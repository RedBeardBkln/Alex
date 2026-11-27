import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { ReauthRequiredError } from "@/lib/accounts";
import type { Caps } from "@/lib/ai-ledger/config";
import { emptyUsage, type AiUsage } from "@/lib/ai-ledger/ledger";
import { draftReply } from "@/lib/ai/draft";
import type { DraftInput, DraftOutcome, DraftProvider } from "@/lib/ai/types";
import { executeClaimed, type Sender } from "@/lib/approvals/execute";
import { contentHash, emailSendPayload, outgoingBody } from "@/lib/approvals/payload";
import { claimItem, editItem, getItemView, getOwnItem, proposeAiReply, proposeNewMessage, proposeReply } from "@/lib/approvals/service";
import type { SendOutcome } from "@/lib/gmail/send";
import { getSyncState } from "@/lib/gmail/store";
import { syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { refreshSignature, SIGNATURE_MIN_REMAINING_MS, storeSignatureRead, type SignatureRead } from "@/lib/signatures/refresh";
import { currentSignature } from "@/lib/signatures/store";
import { approveAndSend, approveItem } from "./helpers/approve";
import { FakeGmail, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Phase email-signatures, plan 11.2, with Postgres, a fake Gmail and a fake draft provider.
// Constructed data only: example.com/.test addresses, invented signature text.

const HOST = "alex.example.com";
const DAY = 86_400_000;
const SIG = "Jane Doe\nExample Co <https://example.com/>";
const SIG_HTML = '<div>Jane Doe</div><a href="https://example.com/">Example Co</a>';
const TOKEN = "Zqx7SignatureToken";
const BIG_CAPS: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 25, draftMicros: 3_000_000, totalMicros: 3_500_000 };
const OPUS_USAGE = (): AiUsage => ({ ...emptyUsage("anthropic-opus", "claude-opus-5-5", 30), inputTokens: 8_000, outputTokens: 3_000, thinkingTokens: 1_000, requestId: "req_d" });

class FakeDraft implements DraftProvider {
  id = "anthropic-opus";
  calls: DraftInput[] = [];
  async draft(input: DraftInput): Promise<DraftOutcome> {
    this.calls.push(input);
    return { status: "ok", body: "Thanks, Wednesday works.", notes: "", errorCode: null, usage: OPUS_USAGE() };
  }
}

describe.skipIf(!testDbUrl)("email signatures (Postgres + fake Gmail)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  let threadId: string;
  let parentId: string;
  let sends: { raw: string }[];

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });

  const syncDeps = (over: Partial<SyncDeps> = {}): SyncDeps => ({
    db: database,
    gmailFor: () => gmail,
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
  const reload = async () => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
  const row = async () => (await database.select().from(schema.accountSignatures).where(eq(schema.accountSignatures.accountId, account.id)))[0];
  const sigAudits = async () =>
    (await database.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.signature_updated")).orderBy(asc(schema.auditLog.createdAt))).map((a) => a.detail);
  const cron = async () => {
    clock += 5 * 60_000;
    return syncAccount(syncDeps(), await reload(), "cron");
  };
  async function runUntilEmpty() {
    for (let i = 0; i < 20; i++) {
      await syncAccount(syncDeps(), await reload(), "cron");
      const q = await database.select().from(schema.mailFetchQueue).where(eq(schema.mailFetchQueue.accountId, account.id));
      if ((await getSyncState(database, account.id))?.backfillStatus === "complete" && q.length === 0) return;
      clock += 5 * 60_000;
    }
  }
  const msg = (over: Partial<FakeMessage> & { id: string }): FakeMessage => ({
    threadId: "gt1",
    labelIds: ["INBOX"],
    internalDate: clock - DAY,
    from: "Alice <alice@example.org>",
    subject: "Lunch",
    ...over,
  });
  const store = (read: SignatureRead) => storeSignatureRead(database, account, read, new Date(clock));
  const setSig = (text: string) => store({ ok: true, state: "set", text });
  const reply = async (over: Partial<Parameters<typeof proposeReply>[1]> = {}) => {
    const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Sounds good.", includeQuote: true, ...over });
    if (!r.ok) throw new Error(r.error);
    return (await getOwnItem(database, userId, r.itemId))!;
  };
  const approvalAudit = async (action: string, itemId: string) =>
    (await database.select().from(schema.auditLog).where(eq(schema.auditLog.action, action))).filter((a) => (a.detail as { itemId?: string }).itemId === itemId).map((a) => a.detail);
  const approveInput = (item: { id: string; revision: number; contentHash: string; threadChangedAt: Date | null }) => ({
    userId,
    itemId: item.id,
    revision: item.revision,
    contentHash: item.contentHash,
    ackThreadChange: false,
    shownThreadChangedAt: item.threadChangedAt ? item.threadChangedAt.getTime() : null,
    messageIdHost: HOST,
  });
  const send: Sender = async (_acc, req) => {
    sends.push({ raw: req.raw });
    return { kind: "succeeded", gmailMessageId: `sent${sends.length}`, gmailThreadId: "gt1" } satisfies SendOutcome;
  };
  const sentBody = (raw: string) => {
    const msgText = Buffer.from(raw, "base64url").toString("utf8");
    return Buffer.from(msgText.slice(msgText.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, ""), "base64").toString("utf8");
  };

  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    gmail = new FakeGmail();
    clock = Date.now();
    sends = [];
  });

  // ---- refresh stage -----------------------------------------------------------------------------

  describe("refresh stage", () => {
    it("first reads: set, none, not_found, too_large; one GET of the account's own address per cron run", async () => {
      gmail.sendAs = { kind: "found", signature: SIG_HTML };
      expect((await cron()).outcome).toBe("ok");
      expect(gmail.calls.filter((c) => c.op === "getSendAs").map((c) => c.args)).toEqual([["work@example.com"]]);
      expect(await row()).toMatchObject({ state: "set", signatureText: SIG, lastErrorCode: null, userId });
      expect(await sigAudits()).toEqual([{ state: "set", changed: "state" }]);

      for (const [sendAs, state] of [
        [{ kind: "found", signature: null }, "none"],
        [{ kind: "not_found" }, "not_found"],
        [{ kind: "found", signature: "a".repeat(10_001) }, "too_large"],
      ] as const) {
        await database.delete(schema.accountSignatures);
        await database.delete(schema.auditLog);
        gmail.sendAs = sendAs;
        expect((await cron()).outcome).toBe("ok");
        expect(await row()).toMatchObject({ state, signatureText: null, lastErrorCode: null });
        expect(await sigAudits()).toEqual([{ state, changed: "state" }]);
      }
    });

    it("unchanged: checked_at moves, changed_at doesn't, no audit; a text change and a state change are audited", async () => {
      gmail.sendAs = { kind: "found", signature: SIG_HTML };
      await cron();
      const first = (await row())!;
      await cron();
      const second = (await row())!;
      expect(second.checkedAt.getTime()).toBeGreaterThan(first.checkedAt.getTime());
      expect(second.fetchedAt!.getTime()).toBeGreaterThan(first.fetchedAt!.getTime());
      expect(second.changedAt.getTime()).toBe(first.changedAt.getTime());
      expect(await sigAudits()).toHaveLength(1);

      gmail.sendAs = { kind: "found", signature: "<b>New</b> text" };
      await cron();
      expect((await row())!.signatureText).toBe("New text");
      expect((await row())!.changedAt.getTime()).toBe(clock);
      gmail.sendAs = { kind: "found", signature: "" };
      await cron();
      expect(await row()).toMatchObject({ state: "none", signatureText: null });
      expect(await sigAudits()).toEqual([
        { state: "set", changed: "state" },
        { state: "set", changed: "text" },
        { state: "none", changed: "state" },
      ]);
    });

    it("a 403 after a good read keeps the copy and is audited once; recovery clears the code without an audit", async () => {
      gmail.sendAs = { kind: "found", signature: SIG_HTML };
      await cron();
      const good = (await row())!;
      gmail.failNext("getSendAs", 403, "insufficientPermissions");
      expect((await cron()).outcome).toBe("ok");
      const failed = (await row())!;
      expect(failed).toMatchObject({ state: "set", signatureText: SIG, lastErrorCode: "http_403:insufficientPermissions" });
      expect(failed.fetchedAt!.getTime()).toBe(good.fetchedAt!.getTime());
      expect(failed.changedAt.getTime()).toBe(clock);
      gmail.failNext("getSendAs", 403, "insufficientPermissions");
      await cron();
      expect((await row())!.changedAt.getTime()).toBe(failed.changedAt.getTime());
      await cron();
      expect(await row()).toMatchObject({ state: "set", signatureText: SIG, lastErrorCode: null });
      expect((await row())!.changedAt.getTime()).toBe(clock);
      expect(await sigAudits()).toEqual([
        { state: "set", changed: "state" },
        { state: "set", changed: "error", code: "http_403:insufficientPermissions" },
      ]);
      // No mail.sync_error from the signature stage.
      expect((await database.select().from(schema.auditLog).where(eq(schema.auditLog.action, "mail.sync_error"))).length).toBe(0);
    });

    it("an error on the first-ever read stores a row with a null state", async () => {
      gmail.failNext("getSendAs", 500, "backendError");
      expect((await cron()).outcome).toBe("ok");
      expect(await row()).toMatchObject({ state: null, signatureText: null, fetchedAt: null, lastErrorCode: "http_500:backendError" });
      expect(await sigAudits()).toEqual([{ state: "unread", changed: "error", code: "http_500:backendError" }]);
    });

    it("Round 4 (R-1 A): during an unfinished backfill, the connect run reads the signature first; later runs read after ingestion and skip when the budget is used up", async () => {
      for (let i = 0; i < 120; i++) gmail.seed(msg({ id: `b${i}`, threadId: `bt${i}`, internalDate: clock - (i + 1) * 60_000 }));
      const getFull = gmail.getMessageFull.bind(gmail);
      gmail.getMessageFull = async (id: string) => {
        clock += 5_000; // a slow Gmail: hydrate uses the whole budget
        return getFull(id);
      };
      gmail.sendAs = { kind: "found", signature: SIG_HTML };
      const queued = async () => (await database.select().from(schema.mailFetchQueue).where(eq(schema.mailFetchQueue.accountId, account.id))).length;
      const r = await syncAccount(syncDeps(), await reload(), "connect");
      expect(r.outcome).toBe("ok");
      expect(await queued()).toBeGreaterThan(0); // the backfill isn't finished
      expect(gmail.count("getSendAs")).toBe(1);
      expect(gmail.calls[0]!.op).toBe("getSendAs"); // before any ingestion call
      expect(await row()).toMatchObject({ state: "set", signatureText: SIG });
      // The next run, still backfilling: the account has a copy, so the read is after ingestion and
      // skipped for lack of budget (R-2); the copy stays in use.
      gmail.sendAs = { kind: "found", signature: "<b>Changed</b>" };
      clock += 5 * 60_000;
      expect((await syncAccount(syncDeps(), await reload(), "cron")).outcome).toBe("ok");
      expect(await queued()).toBeGreaterThan(0);
      expect(gmail.count("getSendAs")).toBe(1);
      expect((await row())!.signatureText).toBe(SIG);
    });

    it("Round 4 (R-1 A): a failed first read is retried first on the next run; one call per run", async () => {
      gmail.failNext("getSendAs", 500, "backendError");
      await cron();
      expect(await row()).toMatchObject({ state: null, lastErrorCode: "http_500:backendError" });
      gmail.sendAs = { kind: "found", signature: SIG_HTML };
      gmail.calls = [];
      await cron();
      expect(gmail.calls[0]!.op).toBe("getSendAs");
      expect(gmail.calls.filter((c) => c.op === "getSendAs")).toHaveLength(1);
      expect(await row()).toMatchObject({ state: "set", lastErrorCode: null });
      // A first read failing on the error path isn't repeated after the ingestion failure either.
      await database.delete(schema.accountSignatures);
      gmail.failNext("getProfile", 500, "backendError");
      await database.update(schema.mailSyncState).set({ historyId: null }).where(eq(schema.mailSyncState.accountId, account.id));
      gmail.calls = [];
      expect((await cron()).outcome).toBe("error");
      expect(gmail.calls.filter((c) => c.op === "getSendAs")).toHaveLength(1);
      expect(gmail.calls[0]!.op).toBe("getSendAs");
    });

    it("a failed ingestion stage still refreshes the signature, after the ingestion calls (account with a copy)", async () => {
      await setSig("Old copy");
      gmail.sendAs = { kind: "found", signature: SIG_HTML };
      gmail.failNext("getProfile", 500, "backendError");
      const r = await cron();
      expect(r).toMatchObject({ outcome: "error", stage: "setup" });
      expect(await row()).toMatchObject({ state: "set", signatureText: SIG });
      const ops = gmail.calls.map((c) => c.op);
      expect(ops.indexOf("getSendAs")).toBeGreaterThan(ops.indexOf("getProfile"));
      // On a good run it also comes after the ingestion calls (it never uses their time budget).
      gmail.calls = [];
      expect((await cron()).outcome).toBe("ok");
      const okOps = gmail.calls.map((c) => c.op);
      expect(okOps.at(-1)).toBe("getSendAs");
      expect(okOps.filter((o) => o === "getSendAs")).toHaveLength(1);
    });

    it("tester O-1: with less than one request timeout of budget left, the read is skipped (no call, no write, no audit)", async () => {
      gmail.sendAs = { kind: "found", signature: SIG_HTML };
      await cron();
      const before = (await row())!;
      const audits = (await sigAudits()).length;
      gmail.sendAs = { kind: "found", signature: "<b>New</b>" };
      const calls = gmail.count("getSendAs");
      // budgetMs 29,999 < SIGNATURE_MIN_REMAINING_MS (30,000): skipped; the stored copy stays as it was.
      clock += 5 * 60_000;
      expect(SIGNATURE_MIN_REMAINING_MS).toBe(30_000);
      expect((await syncAccount(syncDeps({ budgetMs: SIGNATURE_MIN_REMAINING_MS - 1 }), await reload(), "cron")).outcome).toBe("ok");
      expect(gmail.count("getSendAs")).toBe(calls);
      expect(await row()).toEqual(before);
      expect(await sigAudits()).toHaveLength(audits);
      // Exactly the threshold left: it runs.
      clock += 5 * 60_000;
      await syncAccount(syncDeps({ budgetMs: SIGNATURE_MIN_REMAINING_MS }), await reload(), "cron");
      expect(gmail.count("getSendAs")).toBe(calls + 1);
      expect((await row())!.signatureText).toBe("New");
      // The error path checks the budget too.
      gmail.failNext("getProfile", 500, "backendError");
      await database.update(schema.mailSyncState).set({ historyId: null }).where(eq(schema.mailSyncState.accountId, account.id));
      clock += 5 * 60_000;
      expect((await syncAccount(syncDeps({ budgetMs: 1_000 }), await reload(), "cron")).outcome).toBe("error");
      expect(gmail.count("getSendAs")).toBe(calls + 1);
      // refreshSignature directly: no budget function means no check (callers outside the sync).
      await refreshSignature({ db: database, gmail, now: () => new Date(clock) }, await reload());
      expect(gmail.count("getSendAs")).toBe(calls + 2);
      await refreshSignature({ db: database, gmail, now: () => new Date(clock), remainingMs: () => 0 }, await reload());
      expect(gmail.count("getSendAs")).toBe(calls + 2);
    });

    it("the stage throwing a non-Gmail error still leaves the sync ok", async () => {
      const broken = new FakeGmail();
      broken.getSendAs = async () => {
        throw new TypeError("boom");
      };
      const r = await syncAccount(syncDeps({ gmailFor: () => broken }), await reload(), "cron");
      expect(r.outcome).toBe("ok");
      expect(await row()).toMatchObject({ state: null, lastErrorCode: "error:TypeError" });
    });

    it("reconnect needed: no call; ReauthRequiredError from the read takes the skip path", async () => {
      await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, account.id));
      expect((await cron()).outcome).toBe("skipped_reauth");
      expect(gmail.count("getSendAs")).toBe(0);
      await database.update(schema.connectedAccounts).set({ status: "active" }).where(eq(schema.connectedAccounts.id, account.id));
      const reauth = new FakeGmail();
      reauth.getSendAs = async () => {
        throw new ReauthRequiredError(account.id, "test");
      };
      const r = await syncAccount(syncDeps({ gmailFor: () => reauth }), await reload(), "cron");
      expect(r).toMatchObject({ outcome: "skipped_reauth", stage: "signature" });
      expect(await row()).toBeUndefined();
    });

    it("push runs make no call; connect runs make one", async () => {
      await runUntilEmpty();
      const before = gmail.count("getSendAs");
      gmail.deliver(msg({ id: "n1", internalDate: clock }));
      await syncAccount(syncDeps(), await reload(), "push");
      expect(gmail.count("getSendAs")).toBe(before);
      await syncAccount(syncDeps(), await reload(), "connect");
      expect(gmail.count("getSendAs")).toBe(before + 1);
    });

    it("a Disconnect that holds the account first: the write is skipped with no 23503 or 40P01", async () => {
      const other = postgres(testDbUrl!, { max: 1, onnotice: () => {} });
      try {
        const db2 = drizzle(other, { schema });
        let pending: Promise<boolean> | null = null;
        await db2.transaction(async (tx) => {
          await tx.delete(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id));
          pending = storeSignatureRead(database, account, { ok: true, state: "set", text: SIG }, new Date(clock));
          await new Promise((r) => setTimeout(r, 200));
        });
        expect(await pending!).toBe(false);
        expect(await row()).toBeUndefined();
        expect(await sigAudits()).toEqual([]);
      } finally {
        await other.end();
      }
    });

    it("Disconnect cascades the row away", async () => {
      await setSig(SIG);
      expect(await row()).toBeDefined();
      await database.delete(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id));
      expect(await database.select().from(schema.accountSignatures)).toEqual([]);
    });
  });

  // ---- propose, edit, send -----------------------------------------------------------------------

  describe("every email.send path", () => {
    beforeEach(async () => {
      gmail.seed(msg({ id: "p1", messageIdHeader: "<p1@mail.example.org>" }));
      await runUntilEmpty();
      const [thread] = await database.select().from(schema.mailThreads).where(eq(schema.mailThreads.accountId, account.id));
      threadId = thread!.id;
      const [parent] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "p1"));
      parentId = parent!.id;
      await setSig(SIG);
    });

    it("owner reply and reply all carry { text }, covered by the hash and audited as signature: true", async () => {
      for (const cc of ["", "carol@example.org"]) {
        const item = await reply({ cc });
        const p = emailSendPayload.parse(item.payload);
        expect(p.signature).toEqual({ text: SIG });
        expect(item.contentHash).toBe(contentHash("email.send", account.id, item.payload));
        expect(await approvalAudit("approval.proposed", item.id)).toEqual([{ itemId: item.id, kind: "email.send", source: "owner", recipients: cc ? 2 : 1, signature: true }]);
      }
    });

    it("no stored signature (none, not_found, too_large, never read): the key is null and saving still works", async () => {
      for (const read of [
        { ok: true, state: "none", text: null },
        { ok: true, state: "not_found", text: null },
        { ok: true, state: "too_large", text: null },
      ] as const) {
        await store(read);
        const item = await reply();
        expect(emailSendPayload.parse(item.payload).signature).toBeNull();
        expect((await approvalAudit("approval.proposed", item.id))[0]).toMatchObject({ signature: false });
      }
      await database.delete(schema.accountSignatures);
      expect(emailSendPayload.parse((await reply()).payload).signature).toBeNull();
    });

    it("AI draft: the snapshot is added by the server, and the model never sees the stored signature", async () => {
      await setSig(`${SIG}\n${TOKEN}`);
      const drafter = new FakeDraft();
      const r = await draftReply({ db: database, provider: drafter, now: () => new Date(clock), caps: BIG_CAPS }, { userId, threadId, mode: "reply", instruction: null });
      expect(r.ok).toBe(true);
      expect(JSON.stringify(drafter.calls)).not.toContain(TOKEN);
      const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
      expect(emailSendPayload.parse(item.payload).signature).toEqual({ text: `${SIG}\n${TOKEN}` });
      const direct = await proposeAiReply(database, { userId, threadId, mode: "all", body: "Fine." });
      expect(direct.ok && emailSendPayload.parse((await getOwnItem(database, userId, direct.itemId))!.payload).signature).toEqual({ text: `${SIG}\n${TOKEN}` });
    });

    it("compose: a new message carries the signature", async () => {
      const r = await proposeNewMessage(database, { userId, accountId: account.id, to: "bob@example.org", cc: "", subject: "Hi", bodyText: "Hello" });
      expect(r.ok).toBe(true);
      const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
      expect(emailSendPayload.parse(item.payload).signature).toEqual({ text: SIG });
      expect((await approvalAudit("approval.proposed", item.id))[0]).toMatchObject({ variant: "new", signature: true });
    });

    it("edit takes a fresh snapshot: after a change, with none, on a legacy item, and on a failed item", async () => {
      const item = await reply();
      await setSig("Changed sig");
      const e1 = await editItem(database, { userId, itemId: item.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Edited", includeQuote: true });
      expect(e1).toEqual({ ok: true, revision: 2 });
      let now = (await getOwnItem(database, userId, item.id))!;
      expect(emailSendPayload.parse(now.payload).signature).toEqual({ text: "Changed sig" });
      expect(now.contentHash).toBe(contentHash("email.send", account.id, now.payload));
      expect(await approvalAudit("approval.edited", item.id)).toEqual([{ itemId: item.id, revision: 2, signature: true }]);

      await store({ ok: true, state: "none", text: null });
      await editItem(database, { userId, itemId: item.id, revision: 2, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Edited", includeQuote: true });
      now = (await getOwnItem(database, userId, item.id))!;
      expect(emailSendPayload.parse(now.payload).signature).toBeNull();
      expect((await approvalAudit("approval.edited", item.id))[1]).toEqual({ itemId: item.id, revision: 3, signature: false });

      // A legacy item (saved before signatures: no key) gains the key on edit.
      await setSig(SIG);
      const legacy = await reply();
      const { signature: _drop, ...legacyPayload } = emailSendPayload.parse(legacy.payload);
      void _drop;
      await database
        .update(schema.approvalItems)
        .set({ payload: legacyPayload, contentHash: contentHash("email.send", account.id, legacyPayload) })
        .where(eq(schema.approvalItems.id, legacy.id));
      const legacyView = (await getItemView(database, userId, legacy.id))!;
      expect("signature" in legacyView.shown).toBe(false);
      expect(outgoingBody(legacyView.shown)).not.toContain("Jane Doe");
      expect(legacyView.accountHasSignature).toBe(true);
      await editItem(database, { userId, itemId: legacy.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "x", includeQuote: false });
      expect(emailSendPayload.parse((await getOwnItem(database, userId, legacy.id))!.payload).signature).toEqual({ text: SIG });

      // A failed item can be edited and gets the current signature.
      const failed = await reply();
      await database.update(schema.approvalItems).set({ status: "failed", errorCode: "gmail_5xx" }).where(eq(schema.approvalItems.id, failed.id));
      await setSig("Third sig");
      expect(await editItem(database, { userId, itemId: failed.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "y", includeQuote: true })).toEqual({ ok: true, revision: 2 });
      expect(emailSendPayload.parse((await getOwnItem(database, userId, failed.id))!.payload).signature).toEqual({ text: "Third sig" });
    });

    it("approve, claim, execute: the raw message has the snapshot between the body and the quote; a later change doesn't alter it", async () => {
      const item = await reply({ bodyText: "Sounds good.\n" });
      expect((await approveItem(database, approveInput(item))).kind).toBe("approved");
      await setSig("Changed after approval");
      const claim = await claimItem(database, userId, item.id);
      expect(claim).not.toBeNull();
      await executeClaimed({ db: database, send }, item.id, claim!.executionId);
      expect(sends).toHaveLength(1);
      const body = sentBody(sends[0]!.raw);
      const p = emailSendPayload.parse(item.payload);
      expect(body).toBe(`Sounds good.\r\n\r\n${SIG.replace(/\n/g, "\r\n")}\r\n\r\n${p.quote!.text.replace(/\n/g, "\r\n")}`);
      expect(body).not.toContain("Changed after approval");
      expect(body).not.toContain("-- ");

      // The same through approveAndSend for a new message (no quote).
      await setSig(SIG);
      const r = await proposeNewMessage(database, { userId, accountId: account.id, to: "bob@example.org", cc: "", subject: "Hi", bodyText: "Hello" });
      const fresh = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
      await approveAndSend({ db: database, send }, { ...approveInput(fresh), confirmedRecipients: ["bob@example.org"] });
      expect(sentBody(sends[1]!.raw)).toBe(`Hello\r\n\r\n${SIG.replace(/\n/g, "\r\n")}`);
    });

    it("getItemView: current signature text and the 'changed' inputs for open and closed items", async () => {
      const item = await reply();
      let view = (await getItemView(database, userId, item.id))!;
      expect(view.currentSignatureText).toBe(SIG);
      expect(view.shown.signature).toEqual({ text: SIG });
      await setSig("Different");
      view = (await getItemView(database, userId, item.id))!;
      expect(view.currentSignatureText).toBe("Different");
      expect(view.accountHasSignature).toBe(true);
      await store({ ok: true, state: "none", text: null });
      view = (await getItemView(database, userId, item.id))!;
      expect(view.currentSignatureText).toBeNull();
      expect(view.accountHasSignature).toBe(false);
      // A failed read keeps the stored copy, so the view still sees it.
      await setSig(SIG);
      await store({ ok: false, code: "http_403" });
      expect((await currentSignature(database, userId, account.id))!).toMatchObject({ state: "set", text: SIG, lastErrorCode: "http_403" });
      expect((await getItemView(database, userId, item.id))!.currentSignatureText).toBe(SIG);
      // Another user can't read it.
      const other = await makeUser(database, "intruder@example.com");
      expect(await currentSignature(database, other.id, account.id)).toBeNull();
      expect(
        (await database.select().from(schema.accountSignatures).where(and(eq(schema.accountSignatures.accountId, account.id), eq(schema.accountSignatures.userId, userId)))).length,
      ).toBe(1);
    });
  });
});
