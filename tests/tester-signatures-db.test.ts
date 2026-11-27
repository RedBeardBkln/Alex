import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { deleteAccount, ReauthRequiredError } from "@/lib/accounts";
import { executeClaimed, type Sender } from "@/lib/approvals/execute";
import { contentHash, emailSendPayload, outgoingBody } from "@/lib/approvals/payload";
import { claimItem, editItem, getItemView, getOwnItem, proposeNewMessage, proposeReply } from "@/lib/approvals/service";
import { GmailApiError } from "@/lib/gmail/client";
import type { SendOutcome } from "@/lib/gmail/send";
import { getSyncState } from "@/lib/gmail/store";
import { runCronSync, syncAccount, syncAfterConnect, syncAfterPush, type SyncDeps } from "@/lib/gmail/sync";
import { refreshSignature, SIGNATURE_MIN_REMAINING_MS, storeSignatureRead } from "@/lib/signatures/refresh";
import { GOOGLE_REQUEST_TIMEOUT_MS } from "@/lib/google-api";
import { approveItem } from "./helpers/approve";
import { FakeGmail, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester, phase email-signatures (plan v2 sections 7 and 10; AC 2, 5-11, 18). Postgres + fake Gmail.
// Constructed data only: example.com / example.org addresses and invented signature text.

const HOST = "alex.example.com";
const DAY = 86_400_000;
const TOKEN = "Qv9TesterSigToken";
const SIG_HTML = `<div>Jane Doe</div><div>${TOKEN}</div><a href="https://example.com/book">Book a meeting</a>`;
const SIG = `Jane Doe\n${TOKEN}\nBook a meeting <https://example.com/book>`;
const sqlState = (e: unknown): string | undefined => {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
};

describe.skipIf(!testDbUrl)("tester: email signatures (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  let sends: { raw: string }[];

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });

  const fakes = new Map<string, FakeGmail>();
  const syncDeps = (over: Partial<SyncDeps> = {}): SyncDeps => ({
    db: database,
    gmailFor: (a) => fakes.get(a.id) ?? gmail,
    now: () => new Date(clock),
    sleep: async () => {},
    unitsPerMinute: 1e9,
    render: async (body, opts) => ({
      renderKind: body.html ? "text" : "none",
      renderReason: body.html ? "worker_unavailable" : null,
      renderedHtml: null,
      renderedHtmlRemote: null,
      renderedText: body.text,
      renderTruncated: false,
      sanitizerVersion: body.html ? null : opts.version,
      renderedAt: new Date(clock),
    }),
    ...over,
  });
  const reload = async (id = account.id) => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, id)))[0]!;
  const sigRow = async (id = account.id) => (await database.select().from(schema.accountSignatures).where(eq(schema.accountSignatures.accountId, id)))[0];
  const sigAudits = async () =>
    (await database.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.signature_updated")).orderBy(asc(schema.auditLog.createdAt))).map((a) => a.detail);
  const refresh = async () => {
    clock += 5 * 60_000;
    await refreshSignature({ db: database, gmail, now: () => new Date(clock) }, await reload());
  };
  const msg = (over: Partial<FakeMessage> & { id: string }): FakeMessage => ({
    threadId: "gt1",
    labelIds: ["INBOX"],
    internalDate: clock - DAY,
    from: "Alice <alice@example.org>",
    subject: "Lunch",
    ...over,
  });
  async function ingestThread() {
    gmail.seed(msg({ id: "p1", messageIdHeader: "<p1@mail.example.org>" }));
    for (let i = 0; i < 20; i++) {
      await syncAccount(syncDeps(), await reload(), "cron");
      const q = await database.select().from(schema.mailFetchQueue).where(eq(schema.mailFetchQueue.accountId, account.id));
      if ((await getSyncState(database, account.id))?.backfillStatus === "complete" && q.length === 0) break;
      clock += 5 * 60_000;
    }
    const [thread] = await database.select().from(schema.mailThreads).where(eq(schema.mailThreads.accountId, account.id));
    const [parent] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "p1"));
    return { threadId: thread!.id, parentId: parent!.id };
  }
  const send: Sender = async (_acc, req) => {
    sends.push({ raw: req.raw });
    return { kind: "succeeded", gmailMessageId: `sent${sends.length}`, gmailThreadId: "gt1" } satisfies SendOutcome;
  };
  const sentBody = (raw: string) => {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    return Buffer.from(text.slice(text.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, ""), "base64").toString("utf8");
  };
  const approveInput = (item: { id: string; revision: number; contentHash: string; threadChangedAt: Date | null }) => ({
    userId,
    itemId: item.id,
    revision: item.revision,
    contentHash: item.contentHash,
    ackThreadChange: false,
    shownThreadChangedAt: item.threadChangedAt ? item.threadChangedAt.getTime() : null,
    messageIdHost: HOST,
  });

  beforeEach(async () => {
    await database.delete(schema.users);
    fakes.clear();
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    gmail = new FakeGmail();
    clock = Date.now();
    sends = [];
  });

  // ---- AC 2: one read-only settings GET per cron/connect run, none on push ------------------------

  describe("call counts", () => {
    it("runCronSync: exactly one getSendAs per active Google account, each for its own address; none for a reconnect-needed account", async () => {
      const second = await makeGoogleAccount(database, userId, { email: "home@example.com", label: "personal" });
      const third = await makeGoogleAccount(database, userId, { email: "old@example.com", label: "personal" });
      await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, third.id));
      const g = new Map([account, second, third].map((a) => [a.id, new FakeGmail()] as const));
      for (const [id, f] of g) fakes.set(id, f);
      for (let run = 1; run <= 3; run++) {
        clock += 5 * 60_000;
        const results = await runCronSync(syncDeps());
        expect(results.filter((r) => r.outcome === "ok")).toHaveLength(2);
        expect(g.get(account.id)!.calls.filter((c) => c.op === "getSendAs").map((c) => c.args)).toEqual(Array.from({ length: run }, () => ["work@example.com"]));
        expect(g.get(second.id)!.calls.filter((c) => c.op === "getSendAs").map((c) => c.args)).toEqual(Array.from({ length: run }, () => ["home@example.com"]));
        expect(g.get(third.id)!.calls).toEqual([]);
      }
      // A push run makes no settings call; a connect run makes exactly one.
      const before = g.get(account.id)!.count("getSendAs");
      await syncAfterPush(syncDeps(), account.id);
      expect(g.get(account.id)!.count("getSendAs")).toBe(before);
      await syncAfterConnect(syncDeps(), account.id);
      expect(g.get(account.id)!.count("getSendAs")).toBe(before + 1);
      // The paced client's only settings op is getSendAs; nothing else in the fake is a settings write.
      expect(new Set(g.get(account.id)!.calls.map((c) => c.op)).has("getSendAs")).toBe(true);
    });

    it("an ingestion failure still makes exactly one getSendAs; a ReauthRequiredError from it on the error path doesn't throw", async () => {
      gmail.sendAs = { kind: "found", signature: SIG_HTML };
      gmail.failNext("getProfile", 500, "backendError");
      clock += 5 * 60_000;
      const r = await syncAccount(syncDeps(), await reload(), "cron");
      expect(r.outcome).toBe("error");
      expect(gmail.count("getSendAs")).toBe(1);
      expect((await sigRow())?.signatureText).toBe(SIG);

      gmail.failNext("getProfile", 500, "backendError");
      const original = gmail.getSendAs;
      gmail.getSendAs = async (addr: string) => {
        gmail.calls.push({ op: "getSendAs", args: [addr] });
        throw new ReauthRequiredError(account.id, "test");
      };
      clock += 5 * 60_000;
      const r2 = await syncAccount(syncDeps(), await reload(), "cron");
      expect(r2.outcome).toBe("error");
      expect(gmail.count("getSendAs")).toBe(2);
      // The copy is kept.
      expect((await sigRow())?.signatureText).toBe(SIG);
      gmail.getSendAs = original;
      // On the success path a ReauthRequiredError from the stage takes the reconnect skip path.
      gmail.getSendAs = async () => {
        throw new ReauthRequiredError(account.id, "test");
      };
      clock += 5 * 60_000;
      expect((await syncAccount(syncDeps(), await reload(), "cron")).outcome).toBe("skipped_reauth");
    });
  });

  // ---- AC 5: failures keep the last good copy; changed_at and the audit move only on a change -----

  it("a sequence of failures keeps the text and fetched_at, audits each new code once, and propose keeps using the copy", async () => {
    gmail.sendAs = { kind: "found", signature: SIG_HTML };
    await refresh();
    const good = (await sigRow())!;
    expect(good).toMatchObject({ state: "set", signatureText: SIG, lastErrorCode: null });
    const fetchedAt = good.fetchedAt!.getTime();

    const codes: [number, string | null, string][] = [
      [403, "insufficientPermissions", "http_403:insufficientPermissions"],
      [403, "insufficientPermissions", "http_403:insufficientPermissions"],
      [500, null, "http_500"],
      [429, "rateLimitExceeded", "http_429:rateLimitExceeded"],
      [429, "rateLimitExceeded", "http_429:rateLimitExceeded"],
    ];
    let lastChanged = good.changedAt.getTime();
    for (const [status, reason, code] of codes) {
      gmail.failures.set("getSendAs", [new GmailApiError(status, reason, "settings.sendAs.get")]);
      const prevCode = (await sigRow())!.lastErrorCode;
      await refresh();
      const r = (await sigRow())!;
      expect(r).toMatchObject({ state: "set", signatureText: SIG, lastErrorCode: code });
      expect(r.fetchedAt!.getTime()).toBe(fetchedAt);
      expect(r.checkedAt.getTime()).toBe(clock);
      if (prevCode === code) expect(r.changedAt.getTime()).toBe(lastChanged);
      else expect(r.changedAt.getTime()).toBe(clock);
      lastChanged = r.changedAt.getTime();
    }
    expect(await sigAudits()).toEqual([
      { state: "set", changed: "state" },
      { state: "set", changed: "error", code: "http_403:insufficientPermissions" },
      { state: "set", changed: "error", code: "http_500" },
      { state: "set", changed: "error", code: "http_429:rateLimitExceeded" },
    ]);
    // Compose while the last read failed still snapshots the last good copy (Q3e).
    const p = await proposeNewMessage(database, { userId, accountId: account.id, to: "bob@example.org", cc: "", subject: "Hi", bodyText: "Hello" });
    expect(p.ok).toBe(true);
    expect(emailSendPayload.parse((await getOwnItem(database, userId, (p as { itemId: string }).itemId))!.payload).signature).toEqual({ text: SIG });

    // Recovery with the same text: code cleared, changed_at moves (the code changed), no new audit.
    await refresh();
    const rec = (await sigRow())!;
    expect(rec).toMatchObject({ state: "set", signatureText: SIG, lastErrorCode: null });
    expect(rec.fetchedAt!.getTime()).toBe(clock);
    expect(rec.changedAt.getTime()).toBe(clock);
    expect(await sigAudits()).toHaveLength(4);
    // A plain unchanged read afterwards moves nothing but checked_at/fetched_at.
    const changedBefore = rec.changedAt.getTime();
    await refresh();
    expect((await sigRow())!.changedAt.getTime()).toBe(changedBefore);
    expect(await sigAudits()).toHaveLength(4);
  });

  it("a longest-possible error code (64-character reason) fits the column check", async () => {
    const reason = "R".repeat(64);
    gmail.failures.set("getSendAs", [new GmailApiError(503, reason, "settings.sendAs.get")]);
    await refresh();
    expect((await sigRow())).toMatchObject({ state: null, lastErrorCode: `http_503:${reason}`, fetchedAt: null });
  });

  it("an oversized signature (as text) is too_large, and propose then saves null", async () => {
    gmail.sendAs = { kind: "found", signature: `<div>${"word ".repeat(2_100)}</div>` };
    await refresh();
    expect(await sigRow()).toMatchObject({ state: "too_large", signatureText: null });
    const p = await proposeNewMessage(database, { userId, accountId: account.id, to: "bob@example.org", cc: "", subject: "Hi", bodyText: "Hello" });
    expect(emailSendPayload.parse((await getOwnItem(database, userId, (p as { itemId: string }).itemId))!.payload).signature).toBeNull();
  });

  // ---- AC 7, 8: always the server's stored snapshot; client-supplied values are ignored -----------

  it("a forged signature on the service inputs (reply, compose, edit) is ignored, with and without a stored signature", async () => {
    const { threadId, parentId } = await ingestThread();
    const forged = { signature: { text: "FORGED-SIGNATURE" }, includeSignature: false } as Record<string, unknown>;
    for (const stored of [null, SIG] as const) {
      if (stored) await storeSignatureRead(database, account, { ok: true, state: "set", text: stored }, new Date(clock));
      else await storeSignatureRead(database, account, { ok: true, state: "none", text: null }, new Date(clock));
      const want = stored ? { text: stored } : null;
      const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Yes", includeQuote: true, ...forged } as Parameters<typeof proposeReply>[1], "owner");
      expect(r.ok).toBe(true);
      const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
      expect(emailSendPayload.parse(item.payload).signature).toEqual(want);
      const c = await proposeNewMessage(database, { userId, accountId: account.id, to: "bob@example.org", cc: "", subject: "Hi", bodyText: "Hello", ...forged } as Parameters<typeof proposeNewMessage>[1]);
      expect(emailSendPayload.parse((await getOwnItem(database, userId, (c as { itemId: string }).itemId))!.payload).signature).toEqual(want);
      const e = await editItem(database, { userId, itemId: item.id, revision: item.revision, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Edited", includeQuote: true, ...forged } as Parameters<typeof editItem>[1]);
      expect(e.ok).toBe(true);
      const edited = (await getOwnItem(database, userId, item.id))!;
      expect(emailSendPayload.parse(edited.payload).signature).toEqual(want);
      expect(JSON.stringify(edited.payload)).not.toContain("FORGED");
    }
  });

  it("another user's signature row is never used (rows are read by account and user)", async () => {
    const { threadId, parentId } = await ingestThread();
    const otherUser = await makeUser(database, "other-owner@example.com");
    // A row for this account but tagged with another user (not reachable through refresh) is ignored.
    await database.delete(schema.accountSignatures);
    await database.insert(schema.accountSignatures).values({ accountId: account.id, userId: otherUser.id, state: "set", signatureText: "OTHER USER", checkedAt: new Date(clock), fetchedAt: new Date(clock), changedAt: new Date(clock) });
    const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Yes", includeQuote: false }, "owner");
    expect(emailSendPayload.parse((await getOwnItem(database, userId, (r as { itemId: string }).itemId))!.payload).signature).toBeNull();
  });

  // ---- AC 9-11: what was approved is exactly what is sent ------------------------------------------

  it("the approval page's text equals the sent body byte for byte; tampering with the approved signature blocks the send", async () => {
    const { threadId, parentId } = await ingestThread();
    await storeSignatureRead(database, account, { ok: true, state: "set", text: SIG }, new Date(clock));
    const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Friday works.\n\n", includeQuote: true }, "owner");
    const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    expect((await approveItem(database, approveInput(item))).kind).toBe("approved");
    const view = (await getItemView(database, userId, item.id))!;
    const shownText = outgoingBody(view.shown);
    expect(shownText.split(TOKEN)).toHaveLength(2); // exactly one signature
    expect(shownText.startsWith(`Friday works.\n\n${SIG}\n\n`)).toBe(true);
    const claim = (await claimItem(database, userId, item.id))!;
    await executeClaimed({ db: database, send }, item.id, claim.executionId);
    expect(sends).toHaveLength(1);
    expect(sentBody(sends[0]!.raw)).toBe(shownText.replace(/\n/g, "\r\n"));

    // A second item: approve, then change only the approved signature text in the database.
    const r2 = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Again", includeQuote: false }, "owner");
    const item2 = (await getOwnItem(database, userId, (r2 as { itemId: string }).itemId))!;
    expect((await approveItem(database, approveInput(item2))).kind).toBe("approved");
    await database.execute(sql`update approval_items set approved_payload = jsonb_set(approved_payload, '{signature,text}', '"Tampered"') where id = ${item2.id}`);
    const claim2 = (await claimItem(database, userId, item2.id))!;
    const out = await executeClaimed({ db: database, send }, item2.id, claim2.executionId);
    expect(out).toMatchObject({ kind: "failed", code: "hash_mismatch" });
    expect(sends).toHaveLength(1);
  });

  it("a legacy item (no signature key) is approved and sent without a signature while the account has one", async () => {
    const { threadId, parentId } = await ingestThread();
    await storeSignatureRead(database, account, { ok: true, state: "set", text: SIG }, new Date(clock));
    const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Old item", includeQuote: true }, "owner");
    const fresh = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    const { signature: _s, ...legacyPayload } = emailSendPayload.parse(fresh.payload);
    void _s;
    const legacyHash = contentHash("email.send", account.id, legacyPayload);
    await database.update(schema.approvalItems).set({ payload: legacyPayload, contentHash: legacyHash }).where(eq(schema.approvalItems.id, fresh.id));
    const item = (await getOwnItem(database, userId, fresh.id))!;
    expect(item.contentHash).toBe(legacyHash);
    expect((await approveItem(database, approveInput(item))).kind).toBe("approved");
    const claim = (await claimItem(database, userId, item.id))!;
    await executeClaimed({ db: database, send }, item.id, claim.executionId);
    const body = sentBody(sends[0]!.raw);
    expect(body).not.toContain(TOKEN);
    expect(body).toBe(outgoingBody(emailSendPayload.parse(legacyPayload)).replace(/\n/g, "\r\n"));
    expect((await getOwnItem(database, userId, item.id))!.approvedHash).toBe(legacyHash);
  });

  // ---- AC 6, 18: Disconnect and content-free records ------------------------------------------------

  it("real Disconnect (deleteAccount) removes the row; no audit row or log line holds the text, its hash or the address", async () => {
    const logs: unknown[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args)));
    try {
      const { threadId, parentId } = await ingestThread();
      gmail.sendAs = { kind: "found", signature: SIG_HTML };
      await refresh();
      gmail.failNext("getSendAs", 403, "forbidden");
      await refresh();
      gmail.sendAs = { kind: "found", signature: SIG_HTML.replace("Jane", "Janet") };
      await refresh();
      gmail.sendAs = { kind: "not_found" };
      await refresh();
      gmail.sendAs = { kind: "found", signature: SIG_HTML };
      await refresh();
      const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Yes", includeQuote: true }, "owner");
      const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
      await editItem(database, { userId, itemId: item.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Yes!", includeQuote: true });
      const edited = (await getOwnItem(database, userId, item.id))!;
      expect((await approveItem(database, approveInput(edited))).kind).toBe("approved");
      const claim = (await claimItem(database, userId, item.id))!;
      await executeClaimed({ db: database, send }, item.id, claim.executionId);
      // A store failure inside refreshSignature (a trigger that raises) is logged content-free too.
      await database.execute(sql.raw("create or replace function tester_sig_fail() returns trigger language plpgsql as $$ begin raise exception 'tester forced failure'; end $$"));
      await database.execute(sql.raw("create trigger tester_sig_fail before update on account_signatures for each row execute function tester_sig_fail()"));
      try {
        gmail.sendAs = { kind: "found", signature: SIG_HTML.replace("Jane", "Janet") };
        await refresh();
        expect((await sigRow())!.signatureText).toBe(SIG);
        expect(JSON.stringify(logs)).toContain("signature store failed");
      } finally {
        await database.execute(sql.raw("drop trigger if exists tester_sig_fail on account_signatures"));
        await database.execute(sql.raw("drop function if exists tester_sig_fail()"));
      }

      await deleteAccount(database, userId, account.id, { attempts: 1 });
      expect(await database.select().from(schema.accountSignatures)).toEqual([]);

      const audits = await database.select().from(schema.auditLog);
      expect(audits.filter((a) => a.action === "account.signature_updated").length).toBeGreaterThanOrEqual(5);
      const needles = [TOKEN, "Jane Doe", "Janet", "work@example.com", "example.com/book"];
      for (const t of [SIG, SIG.replace("Jane", "Janet")]) needles.push(createHash("sha256").update(t).digest("hex"), createHash("sha256").update(t).digest("base64"));
      for (const a of audits) {
        const d = JSON.stringify(a.detail);
        for (const n of needles) expect(d.includes(n), `${a.action} ${d}`).toBe(false);
        if (a.action === "account.signature_updated") expect(Object.keys(a.detail as object).every((k) => ["state", "changed", "code"].includes(k))).toBe(true);
        if (a.action === "approval.proposed" || a.action === "approval.edited") expect(typeof (a.detail as { signature?: unknown }).signature).toBe("boolean");
      }
      const logText = JSON.stringify(logs, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v));
      for (const n of needles) expect(logText.includes(n), n).toBe(false);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("race: storeSignatureRead vs deleteAccount on separate pools never surfaces 23503 or 40P01, and leaves no orphan", async () => {
    const pool = postgres(testDbUrl!, { max: 12, onnotice: () => {} });
    const db2 = drizzle(pool, { schema }) as unknown as Database;
    const tally = { stored: 0, skipped: 0, storeErr: {} as Record<string, number>, deleteErr: {} as Record<string, number> };
    try {
      for (let round = 0; round < 24; round++) {
        const a = await makeGoogleAccount(database, userId, { email: `race${round}@example.com` });
        if (round % 3 === 0) await storeSignatureRead(database, a, { ok: true, state: "none", text: null }, new Date(clock));
        const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
        const [s, d] = await Promise.allSettled([
          (async () => {
            await sleep(round % 2 === 0 ? 0 : (round % 7) * 2);
            return storeSignatureRead(database, a, round % 4 === 1 ? { ok: false, code: "http_500" } : { ok: true, state: "set", text: `${TOKEN}${round}` }, new Date(clock));
          })(),
          (async () => {
            await sleep(round % 2 === 1 ? 0 : (round % 5) * 2);
            await deleteAccount(db2, userId, a.id, { attempts: 1 });
          })(),
        ]);
        if (s.status === "fulfilled") s.value ? tally.stored++ : tally.skipped++;
        else tally.storeErr[sqlState(s.reason) ?? "other"] = (tally.storeErr[sqlState(s.reason) ?? "other"] ?? 0) + 1;
        if (d.status === "rejected") tally.deleteErr[sqlState(d.reason) ?? "other"] = (tally.deleteErr[sqlState(d.reason) ?? "other"] ?? 0) + 1;
        expect(await sigRow(a.id)).toBeUndefined();
      }
      if (process.env.TESTER_SCRATCH) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.TESTER_SCRATCH, `sig-race ${JSON.stringify(tally)}\n`);
      }
      expect(tally.storeErr).toEqual({});
      expect(tally.deleteErr).toEqual({});
      expect(tally.stored + tally.skipped).toBe(24);
    } finally {
      await pool.end();
    }
  });

  it("race: two first writes for a never-read account on separate connections give one row and one state audit", async () => {
    const pool = postgres(testDbUrl!, { max: 4, onnotice: () => {} });
    const db2 = drizzle(pool, { schema }) as unknown as Database;
    try {
      for (let round = 0; round < 10; round++) {
        const a = await makeGoogleAccount(database, userId, { email: `first${round}@example.com` });
        const read = { ok: true as const, state: "set" as const, text: SIG };
        const results = await Promise.all([storeSignatureRead(database, a, read, new Date(clock)), storeSignatureRead(db2, a, read, new Date(clock))]);
        expect(results).toEqual([true, true]);
        expect(await sigRow(a.id)).toMatchObject({ state: "set", signatureText: SIG });
        const audits = (await database.select().from(schema.auditLog).where(eq(schema.auditLog.accountId, a.id))).filter((x) => x.action === "account.signature_updated");
        expect(audits.map((x) => x.detail)).toEqual([{ state: "set", changed: "state" }]);
      }
    } finally {
      await pool.end();
    }
  });
});

describe.skipIf(!testDbUrl)("tester round 2: O-1 budget skip (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    gmail = new FakeGmail();
    clock = Date.now();
  });
  // The fake clock doesn't move during a run, so the remaining budget at the signature stage is exactly budgetMs.
  const deps = (budgetMs: number): SyncDeps => ({
    db: database,
    gmailFor: () => gmail,
    now: () => new Date(clock),
    sleep: async () => {},
    unitsPerMinute: 1e9,
    budgetMs,
    render: async (body, opts) => ({
      renderKind: body.html ? "text" : "none",
      renderReason: body.html ? "worker_unavailable" : null,
      renderedHtml: null,
      renderedHtmlRemote: null,
      renderedText: body.text,
      renderTruncated: false,
      sanitizerVersion: body.html ? null : opts.version,
      renderedAt: new Date(clock),
    }),
  });
  const reload = async () => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
  const rows = () => database.select().from(schema.accountSignatures);
  const sigAudits = async () => (await database.select().from(schema.auditLog)).filter((a) => a.action === "account.signature_updated");
  const run = async (budgetMs: number) => {
    clock += 5 * 60_000;
    return syncAccount(deps(budgetMs), await reload(), "cron");
  };

  it("SIGNATURE_MIN_REMAINING_MS is one request timeout (30 s)", () => {
    expect(SIGNATURE_MIN_REMAINING_MS).toBe(GOOGLE_REQUEST_TIMEOUT_MS);
    expect(GOOGLE_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("boundary: 29,999 ms left skips (no call, no row, no audit, content-free log); 30,000 ms reads", async () => {
    gmail.sendAs = { kind: "found", signature: SIG_HTML };
    const warns: unknown[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(a));
    try {
      expect((await run(29_999)).outcome).toBe("ok");
      expect(gmail.count("getSendAs")).toBe(0);
      expect(await rows()).toEqual([]);
      expect(await sigAudits()).toEqual([]);
      expect(warns).toEqual([["signature read skipped", { accountId: account.id, reason: "budget" }]]);
    } finally {
      spy.mockRestore();
    }
    expect((await run(30_000)).outcome).toBe("ok");
    expect(gmail.count("getSendAs")).toBe(1);
    expect((await rows())[0]).toMatchObject({ state: "set", signatureText: SIG });
    expect(await sigAudits()).toHaveLength(1);

    // With a stored copy: a skipped run leaves the row byte-identical (checked_at included) even though Gmail changed.
    const before = await rows();
    gmail.sendAs = { kind: "found", signature: SIG_HTML.replace("Jane", "Janet") };
    expect((await run(29_999)).outcome).toBe("ok");
    expect(await rows()).toEqual(before);
    expect(await sigAudits()).toHaveLength(1);
    expect(gmail.count("getSendAs")).toBe(1);
    expect((await run(30_000)).outcome).toBe("ok");
    expect((await rows())[0]!.signatureText).toBe(SIG.replace("Jane", "Janet"));
  });

  it("error path: a failed ingestion with 29,999 ms left makes no settings call and writes nothing; 30,000 ms makes one", async () => {
    gmail.sendAs = { kind: "found", signature: SIG_HTML };
    gmail.failNext("getProfile", 500, "backendError");
    expect((await run(29_999)).outcome).toBe("error");
    expect(gmail.count("getSendAs")).toBe(0);
    expect(await rows()).toEqual([]);
    gmail.failNext("getProfile", 500, "backendError");
    expect((await run(30_000)).outcome).toBe("error");
    expect(gmail.count("getSendAs")).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  it("a deadline already passed (negative remaining) skips too", async () => {
    expect((await run(-1)).outcome).not.toBe("skipped_reauth");
    expect(gmail.count("getSendAs")).toBe(0);
  });
});
