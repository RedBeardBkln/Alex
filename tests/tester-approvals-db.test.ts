import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { getAccessToken } from "@/lib/accounts";
import { type ExecutorDeps, type Sender } from "@/lib/approvals/execute";
import { emailSendPayload, MAX_QUOTE_CHARS, outgoingBody, quoteText } from "@/lib/approvals/payload";
import { onMessageStored } from "@/lib/approvals/ingest-hook";
import { reconcileApprovals } from "@/lib/approvals/reconcile";
import {
  cancelItem,
  editItem,
  getOwnItem,
  markNotSent,
  markReconciledSent,
  proposeReply,
  rejectItem,
  replyContext,
  replyFormDefaults,
} from "@/lib/approvals/service";
import { approveAndSend, approveItem } from "./helpers/approve";
import type { GmailClient } from "@/lib/gmail/client";
import { sendRawMessage, type SendOutcome } from "@/lib/gmail/send";
import { getSyncState } from "@/lib/gmail/store";
import { syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { FakeGmail, header, textPart, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";
import { TEST_KEY } from "./setup-env";

// Tester (phase 2b): attacks on draft-then-approve with a real multi-connection pool (the coder's
// suite uses one connection, which serialises "concurrent" transactions), independent decoding of
// the sent bytes, hostile ingested headers, reconcile/ingest spoofing, Q6 timing, reauth, 401 retry.

const HOST = "alex.example.com";
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Decoded = { head: string; headers: [string, string][]; get: (n: string) => string[]; text: string; subject: string };

/** Independent decoder for the sent raw (not using compose.ts or 2a's mime.ts). */
function decode(raw: string): Decoded {
  const msg = Buffer.from(raw, "base64url").toString("utf8");
  const split = msg.indexOf("\r\n\r\n");
  const head = msg.slice(0, split);
  const body = msg.slice(split + 4);
  const headers: [string, string][] = [];
  for (const line of head.split("\r\n")) {
    if (line.startsWith(" ")) headers[headers.length - 1]![1] += line;
    else {
      const i = line.indexOf(": ");
      headers.push([line.slice(0, i), line.slice(i + 2)]);
    }
  }
  const get = (n: string) => headers.filter(([k]) => k.toLowerCase() === n.toLowerCase()).map(([, v]) => v);
  const rawSubject = get("Subject")[0] ?? "";
  const subject = /=\?UTF-8\?B\?/.test(rawSubject)
    ? rawSubject
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)![1]!, "base64"))
        .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))
        .toString("utf8")
    : rawSubject;
  expect(body.split("\r\n").every((l) => l.length <= 76 && /^[A-Za-z0-9+/=]*$/.test(l))).toBe(true);
  const text = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  return { head, headers, get, text, subject };
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

describe.skipIf(!testDbUrl)("tester: approval queue attacks (Postgres, fake Gmail, multi-connection pool)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  let threadId: string;
  let parentId: string;
  let sends: { accountId: string; raw: string; threadId: string | null }[];
  let nextOutcome: (n: number) => SendOutcome;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    pool = postgres(testDbUrl!, { max: 12, onnotice: () => {} });
    poolDb = drizzle(pool, { schema }) as unknown as Database;
  });
  afterAll(async () => {
    await pool.end();
    await client.end();
  });

  const syncDeps = (): SyncDeps => ({
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
  });
  const reload = async () => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
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
  const send: Sender = async (acc, req) => {
    sends.push({ accountId: acc.id, raw: req.raw, threadId: req.threadId });
    await sleep(15);
    return nextOutcome(sends.length);
  };
  const deps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({ db: poolDb, send, ...over });
  const item = async (id: string) => (await getOwnItem(database, userId, id))!;
  const audits = async () => (await database.select().from(schema.auditLog).orderBy(asc(schema.auditLog.createdAt))).filter((a) => a.action.startsWith("approval."));
  async function propose(over: Partial<Parameters<typeof proposeReply>[1]> = {}) {
    const r = await proposeReply(database, {
      userId,
      threadId,
      parentMessageId: parentId,
      to: "alice@example.org",
      cc: "",
      subject: "Re: Lunch",
      bodyText: "Sounds good.",
      includeQuote: true,
      ...over,
    });
    if (!r.ok) throw new Error(r.error);
    return item(r.itemId);
  }
  // Like the approval page (round 4, review B1): the form carries the revision, hash and the
  // thread_changed_at it rendered (epoch ms or null) from the item object it was rendered from.
  const approveInput = (it: { id: string; revision: number; contentHash: string; threadChangedAt?: Date | null }, over: Partial<Parameters<typeof approveItem>[1]> = {}) => ({
    userId,
    itemId: it.id,
    revision: it.revision,
    contentHash: it.contentHash,
    ackThreadChange: false,
    shownThreadChangedAt: it.threadChangedAt ? it.threadChangedAt.getTime() : null,
    messageIdHost: HOST,
    ...over,
  });
  let synced = false;
  async function ingestParent(m: FakeMessage) {
    if (synced) gmail.deliver(m);
    else gmail.seed(m);
    synced = true;
    await runUntilEmpty();
    const [thread] = await database.select().from(schema.mailThreads).where(eq(schema.mailThreads.gmailThreadId, m.threadId));
    const [parent] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, m.id));
    return { threadId: thread!.id, parentMessageId: parent!.id };
  }

  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    gmail = new FakeGmail();
    synced = false;
    clock = Date.now();
    sends = [];
    nextOutcome = (n) => ({ kind: "succeeded", gmailMessageId: `sent${n}`, gmailThreadId: "gt1" });
    ({ threadId, parentMessageId: parentId } = await ingestParent(msg({ id: "p1", messageIdHeader: "<p1@mail.example.org>", inReplyTo: "<root@mail.example.org>" })));
  });

  // ---- races with real parallel connections ---------------------------------------------------

  it("10 parallel approves on 12 real connections send exactly once (5 rounds)", async () => {
    for (let round = 0; round < 5; round++) {
      sends = [];
      const it0 = await propose();
      const rs = await Promise.all(Array.from({ length: 10 }, () => approveAndSend(deps(), approveInput(it0))));
      expect(sends, `round ${round}`).toHaveLength(1);
      expect(rs.filter((r) => r.kind === "executed")).toHaveLength(1);
      expect((await item(it0.id)).status).toBe("succeeded");
    }
  });

  it("approve racing edit: never both; if it sent, it sent the displayed revision", async () => {
    const tally = { sent: 0, edited: 0 };
    for (let round = 0; round < 15; round++) {
      sends = [];
      const it0 = await propose({ bodyText: `original ${round}` });
      const [a, e] = await Promise.all([
        sleep(round % 2 ? 0 : round).then(() => approveAndSend(deps(), approveInput(it0))),
        // Staggered start (0-14 ms) so both orders happen across rounds.
        sleep(round % 2 ? round : 0).then(() => editItem(poolDb, { userId, itemId: it0.id, revision: 1, to: "mallory@example.net", cc: "", subject: "Re: Lunch", bodyText: `edited ${round}`, includeQuote: false })),
      ]);
      const after = await item(it0.id);
      if (sends.length === 1) {
        expect(e, `round ${round}`).toEqual({ ok: false, error: "stale" });
        const d = decode(sends[0]!.raw);
        expect(d.get("To")).toEqual(["alice@example.org"]);
        expect(d.text.startsWith(`original ${round}`)).toBe(true);
        expect(after.status).toBe("succeeded");
        tally.sent++;
      } else {
        tally.edited++;
        expect(sends).toHaveLength(0);
        expect(e).toEqual({ ok: true, revision: 2 });
        expect(a.kind).toBe("approval");
        expect(after).toMatchObject({ status: "pending", revision: 2, approvedPayload: null, messageIdHeader: null });
      }
    }
    if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `approve-vs-edit ${JSON.stringify(tally)}
`);
  });

  it("reject racing approve and cancel racing approve-again: exactly one wins, never a send after a reject/cancel", async () => {
    for (let round = 0; round < 15; round++) {
      sends = [];
      const it0 = await propose();
      const [a, rj] = await Promise.all([approveAndSend(deps(), approveInput(it0)), sleep(round).then(() => rejectItem(poolDb, userId, it0.id))]);
      const after = await item(it0.id);
      if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `reject-won ${rj}
`);
      if (rj) {
        expect(sends).toHaveLength(0);
        expect(after.status).toBe("rejected");
        expect(a.kind).toBe("approval");
      } else {
        expect(sends).toHaveLength(1);
        expect(after.status).toBe("succeeded");
      }
    }
    for (let round = 0; round < 10; round++) {
      sends = [];
      nextOutcome = () => ({ kind: "failed", code: "gmail_400", status: 400 });
      const it0 = await propose();
      await approveAndSend(deps(), approveInput(it0));
      const failedNow = await item(it0.id);
      expect(failedNow.status).toBe("failed");
      expect(failedNow.revision).toBe(2); // round 2 (Q8): failed bumps the revision
      nextOutcome = (n) => ({ kind: "succeeded", gmailMessageId: `s${n}`, gmailThreadId: "gt1" });
      // Approve-again from a freshly rendered page (current revision) racing a cancel.
      const [, c] = await Promise.all([approveAndSend(deps(), approveInput(failedNow)), sleep(round).then(() => cancelItem(poolDb, userId, it0.id))]);
      const after = await item(it0.id);
      if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `cancel-won ${c}
`);
      expect(sends.length).toBe(c ? 1 : 2);
      expect(after.status).toBe(c ? "cancelled" : "succeeded");
    }
  });

  it("no edit, reject or cancel once approved/executing/succeeded/unknown; replays of old revision or hash send nothing", async () => {
    const it0 = await propose();
    for (const status of ["approved", "executing", "succeeded", "unknown"] as const) {
      await database.update(schema.approvalItems).set({ status }).where(eq(schema.approvalItems.id, it0.id));
      expect(await editItem(database, { userId, itemId: it0.id, revision: 1, to: "x@example.org", cc: "", subject: "s", bodyText: "b", includeQuote: false }), status).toEqual({ ok: false, error: "stale" });
      expect(await rejectItem(database, userId, it0.id), status).toBe(false);
      expect(await cancelItem(database, userId, it0.id), status).toBe(false);
    }
    // approved but never claimed (crash between approve and claim): an old POST may claim it, but the
    // bytes are the approved snapshot, and a different hash is refused.
    const it1 = await propose({ bodyText: "v1" });
    await approveItem(database, approveInput(it1));
    expect(await approveAndSend(deps(), approveInput(it1, { contentHash: "0".repeat(64) }))).toMatchObject({ kind: "approval", result: { kind: "stale" } });
    expect(sends).toHaveLength(0);
    // Edit -> rev 2; replay of rev 1 with either hash, and rev 2 with the rev-1 hash, are refused.
    const it2 = await propose({ bodyText: "v1" });
    await editItem(database, { userId, itemId: it2.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "v2", includeQuote: true });
    const cur = await item(it2.id);
    for (const inp of [approveInput(it2), approveInput({ ...it2, contentHash: cur.contentHash }), approveInput({ ...cur, contentHash: it2.contentHash })]) {
      expect((await approveAndSend(deps(), inp)).kind).toBe("approval");
    }
    expect(sends).toHaveLength(0);
    // Editing back to identical content still needs the new revision.
    const it3 = await propose({ bodyText: "same" });
    await editItem(database, { userId, itemId: it3.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "same", includeQuote: true });
    const cur3 = await item(it3.id);
    expect(cur3.contentHash).toBe(it3.contentHash);
    expect((await approveAndSend(deps(), approveInput(it3))).kind).toBe("approval");
    expect(sends).toHaveLength(0);
  });

  // ---- account and user forging ---------------------------------------------------------------

  it("another user can't approve, edit, reject or cancel my item even with the right revision and hash; my own other account can't be swapped in", async () => {
    const it0 = await propose();
    const other = (await makeUser(database, "intruder@example.com")).id;
    const otherAcc = await makeGoogleAccount(database, other, { email: "intruder@example.com" });
    expect(await approveAndSend(deps(), { ...approveInput(it0), userId: other })).toEqual({ kind: "approval", result: { kind: "blocked", reason: "not_found" } });
    expect(await editItem(database, { userId: other, itemId: it0.id, revision: 1, to: "x@example.org", cc: "", subject: "s", bodyText: "b", includeQuote: false })).toEqual({ ok: false, error: "not_found" });
    expect(await rejectItem(database, other, it0.id)).toBe(false);
    expect(await cancelItem(database, other, it0.id)).toBe(false);
    expect(await markNotSent(database, other, it0.id, new Date(Date.now() + DAY))).toBe(false);
    expect(sends).toHaveLength(0);
    // Propose against my thread as the other user: not found.
    expect(await proposeReply(database, { userId: other, threadId, parentMessageId: parentId, to: "a@example.org", cc: "", subject: "s", bodyText: "", includeQuote: false })).toEqual({ ok: false, error: "not_found" });

    // Point my item at another user's account (DB tamper): blocked before and at execution.
    await database.update(schema.approvalItems).set({ accountId: otherAcc.id }).where(eq(schema.approvalItems.id, it0.id));
    expect((await approveAndSend(deps(), approveInput(it0))).kind).toBe("approval");
    // My second account, with the hash recomputed so only the account check can stop it.
    const mine2 = await makeGoogleAccount(database, userId, { email: "personal@example.com", label: "personal" });
    const { contentHash } = await import("@/lib/approvals/payload");
    const h = contentHash("email.send", mine2.id, it0.payload);
    await database.update(schema.approvalItems).set({ accountId: mine2.id, contentHash: h }).where(eq(schema.approvalItems.id, it0.id));
    expect(await approveAndSend(deps(), approveInput({ ...it0, contentHash: h }))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "account_mismatch" } });
    expect(sends).toHaveLength(0);
  });

  it("an item approved, then its thread moved to another account before the claim, isn't sent (executor re-check)", async () => {
    const it0 = await propose();
    await approveItem(database, approveInput(it0));
    const mine2 = await makeGoogleAccount(database, userId, { email: "personal@example.com", label: "personal" });
    await database.update(schema.mailThreads).set({ accountId: mine2.id }).where(eq(schema.mailThreads.id, threadId));
    const r = await approveAndSend(deps(), approveInput(it0));
    expect(r).toMatchObject({ kind: "executed", outcome: { kind: "failed", code: "stale_account" } });
    expect(sends).toHaveLength(0);
  });

  // ---- exact bytes and hostile ingested headers ------------------------------------------------

  it("hostile Reply-To/From/Cc/References/Message-ID/Subject from ingested mail never reach the header block", async () => {
    const evil: FakeMessage = msg({
      id: "evil1",
      threadId: "gtE",
      from: '"Boss\r\nBcc: spy1@evil.example" <boss@example.org>',
      subject: "Invoice\r\nBcc: spy2@evil.example X-Injected: 1",
      messageIdHeader: "<evil@x.example>\r\nBcc: spy3@evil.example",
      payload: {
        ...textPart("text/plain", "Pay now.\r\n.\r\nBcc: spy4@evil.example\r\n\r\n<script>alert(1)</script>"),
        headers: [
          header("Reply-To", "pay@evil.example, \"x\r\nBcc: spy5@evil.example\" <ok@evil.example>"),
          header("Cc", "friends: a@example.org, b@example.org;, c@example.org (comment), d@example.org\r\nBcc: spy6@evil.example"),
          header("References", "<r1@x.example> <bad id@x> <r2@x.example>\r\nBcc: spy7@evil.example"),
        ],
      },
    });
    const ids = await ingestParent(evil);
    const ctx = (await replyContext(database, userId, ids.threadId))!;
    for (const mode of ["reply", "all"] as const) {
      const d0 = replyFormDefaults(ctx, mode);
      const r = await proposeReply(database, {
        userId,
        threadId: ids.threadId,
        parentMessageId: ids.parentMessageId,
        to: d0.to.join("\n"),
        cc: d0.cc.join("\n"),
        subject: d0.subject,
        bodyText: "Reply text\nBcc: spy8@evil.example",
        includeQuote: true,
      });
      expect(r.ok, mode).toBe(true);
      const it0 = await item((r as { itemId: string }).itemId);
      const p = emailSendPayload.parse(it0.payload);
      expect(p.replyToNotice).toBe(true);
      sends = [];
      await approveAndSend(deps(), approveInput(it0));
      expect(sends).toHaveLength(1);
      const d = decode(sends[0]!.raw);
      expect(d.headers.map(([k]) => k)).toEqual(
        ["From", "To", ...(p.cc.length ? ["Cc"] : []), "Subject", "Date", "Message-ID", ...(p.threading?.inReplyTo ? ["In-Reply-To", "References"] : []), "MIME-Version", "Content-Type", "Content-Transfer-Encoding"],
      );
      // Attacker text may survive *inside* the one-line Subject value (CR/LF became spaces), but no
      // header line other than ours exists, and no address came from the injected parts.
      expect(d.head.split("\r\n").filter((l) => /^(bcc|x-injected)\s*:/i.test(l.trimStart()))).toEqual([]);
      // Precise (round 4): the bare substring "bcc" can occur in our random hex Message-ID (item UUID +
      // 12 hex), so check header *names* after unfolding and the attacker's injected values instead.
      const unfolded = d.headers.map(([k, v]) => `${k}: ${v}`);
      expect(unfolded.filter((l) => /^\s*(bcc|resent-bcc|x-injected)\s*:/i.test(l))).toEqual([]);
      expect(unfolded.filter((l) => !l.startsWith("Subject:")).join("\n")).not.toMatch(/spy\d@evil\.example|x-injected|\bbcc\s*:/i);
      expect(d.get("From")).toEqual(["work@example.com"]);
      expect(list(d.get("To")[0])).toEqual(p.to);
      expect(list(d.get("Cc")[0])).toEqual(p.cc);
      for (const a of [...p.to, ...p.cc]) expect(a).not.toMatch(/spy/);
      expect(d.subject).toBe(p.subject);
      expect(d.get("Content-Type")).toEqual(["text/plain; charset=UTF-8"]);
      expect(d.text).toBe(outgoingBody(p).replace(/\n/g, "\r\n"));
      expect(d.text).toContain("<script>alert(1)</script>"); // quoted as literal plain text
      expect(sends[0]!.threadId).toBe("gtE");
      const after = await item(it0.id);
      expect(d.get("Message-ID")).toEqual([after.messageIdHeader]);
      expect(after.approvedPayload).toEqual(it0.payload);
    }
  });

  it("non-ASCII subject, bodies with CR-only/CRLF/LF, emoji and quoted text decode back to exactly the approved copy", async () => {
    const it0 = await propose({ subject: "Re: Déjeuner 🍜 " + "é".repeat(120), bodyText: "a\rb\r\nc\nd 🍜\n\n.\n.." });
    await approveAndSend(deps(), approveInput(it0));
    const d = decode(sends[0]!.raw);
    const p = emailSendPayload.parse((await item(it0.id)).approvedPayload);
    expect(d.subject).toBe(p.subject);
    // RFC 5322: 998 hard limit; the encoded subject words stay under 78 (our Message-ID line is ~90, allowed).
    expect(d.head.split("\r\n").every((l) => l.length <= 998)).toBe(true);
    expect(d.head.split("\r\n").filter((l) => l.startsWith("Subject:") || l.startsWith(" =?")).every((l) => l.length < 78)).toBe(true);
    expect(d.text).toBe(outgoingBody(p).replace(/\n/g, "\r\n"));
    expect(p.bodyText).toBe("a\nb\nc\nd 🍜\n\n.\n..");
    expect(d.get("In-Reply-To")).toEqual(["<p1@mail.example.org>"]);
    expect(d.get("References")[0]!.split(/\s+/)).toEqual(["<root@mail.example.org>", "<p1@mail.example.org>"]);
  });

  it("quoted text: capped at 20,000 chars, plain text only, from an HTML-only parent too", async () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} <b>bold</b> &amp;`).join("\n");
    // text/plain containing markup (this harness's fake renderer gives HTML-only parents no text).
    const ids = await ingestParent(msg({ id: "big1", threadId: "gtB", payload: textPart("text/plain", big) }));
    const r = await proposeReply(database, { userId, ...ids, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "x", includeQuote: true });
    expect(r.ok).toBe(true);
    const it0 = await item((r as { itemId: string }).itemId);
    const p = emailSendPayload.parse(it0.payload);
    expect(p.quote!.text.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(p.quote!.text.length).toBeGreaterThan(MAX_QUOTE_CHARS - 200);
    await approveAndSend(deps(), approveInput(it0));
    const d = decode(sends[0]!.raw);
    expect(d.get("Content-Type")).toEqual(["text/plain; charset=UTF-8"]);
    expect(d.text).toBe(outgoingBody(p).replace(/\n/g, "\r\n"));
    // Quote toggle off: nothing of the parent is sent.
    sends = [];
    const r2 = await proposeReply(database, { userId, ...ids, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "only mine", includeQuote: false });
    await approveAndSend(deps(), approveInput(await item((r2 as { itemId: string }).itemId)));
    expect(decode(sends[0]!.raw).text).toBe("only mine");
    expect(d.text).toContain("> line 0 <b>bold</b> &amp;");
  });

  it("D2: where a raw UTF-16 slice of the quote would leave a lone surrogate, the real path stores well-formed text (cut positions around it too)", async () => {
    const m = msg({ id: "sur1", threadId: "gtS" });
    const prefix = `On ${new Date(m.internalDate).toUTCString()}, ${m.from} wrote:\n> `;
    // Premise, computed independently of quoteText: the round-1 algorithm (a raw .slice(0, 20000) of
    // attribution + "> " + text) ends on a lone high surrogate for exactly one n.
    const rawQuote = (k: number) => (prefix + "a".repeat(k) + "🍜 tail").slice(0, MAX_QUOTE_CHARS);
    const n = MAX_QUOTE_CHARS - 1 - prefix.length;
    expect(rawQuote(n).isWellFormed(), "premise: a raw slice leaves a lone surrogate").toBe(false);
    expect(rawQuote(n).charCodeAt(MAX_QUOTE_CHARS - 1)).toBeGreaterThanOrEqual(0xd800);
    let gt = 0;
    for (const k of [n - 2, n - 1, n, n + 1, n + 2]) {
      const ids = await ingestParent({ ...m, id: `sur${k}`, threadId: `gtS${k}`, payload: textPart("text/plain", "a".repeat(k) + "🍜 tail") });
      const r = await proposeReply(database, { userId, ...ids, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "x", includeQuote: true }).catch((e: unknown) => ({ threw: String(e) }));
      expect(r, String(k)).toMatchObject({ ok: true });
      const it0 = await item((r as { itemId: string }).itemId);
      const q = emailSendPayload.parse(it0.payload).quote!.text;
      expect(q.isWellFormed(), String(k)).toBe(true);
      expect(q.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
      // A prefix of the raw quote, minus at most the dangling half: nothing invented, no U+FFFD needed.
      expect(rawQuote(k).startsWith(q), String(k)).toBe(true);
      expect(q).not.toContain("\uFFFD");
      if (k === n) expect(q.length).toBe(MAX_QUOTE_CHARS - 1);
      sends = [];
      await approveAndSend(deps(), approveInput(it0));
      expect(decode(sends[0]!.raw).text).toBe(outgoingBody(emailSendPayload.parse(it0.payload)).replace(/\n/g, "\r\n"));
      gt++;
    }
    expect(gt).toBe(5);
  });

  it("D2: lone surrogates in the owner's subject and body (propose and edit) are stored and sent as U+FFFD, never a database error", async () => {
    const lone = ["\uD83C", "\uDF5C", "x\uD83Cy", "\uDF5C\uD83C", "a🍜\uD800"];
    for (const bad of lone) {
      const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: `Re: ${bad}`, bodyText: `body ${bad}`, includeQuote: false }).catch((e: unknown) => ({ threw: String(e) }));
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: true });
      const it0 = await item((r as { itemId: string }).itemId);
      const p = emailSendPayload.parse(it0.payload);
      expect(p.subject).toBe(`Re: ${bad.toWellFormed()}`);
      expect(p.bodyText).toBe(`body ${bad.toWellFormed()}`);
      const e = await editItem(database, { userId, itemId: it0.id, revision: 1, to: "alice@example.org", cc: "", subject: `Re: edit ${bad}`, bodyText: `edit ${bad}`, includeQuote: true }).catch((err: unknown) => ({ threw: String(err) }));
      expect(e, JSON.stringify(bad)).toMatchObject({ ok: true });
      const ed = await item(it0.id);
      sends = [];
      await approveAndSend(deps(), approveInput(ed));
      const d = decode(sends[0]!.raw);
      expect(d.subject).toBe(`Re: edit ${bad.toWellFormed()}`);
      expect(d.text.startsWith(`edit ${bad.toWellFormed()}`)).toBe(true);
    }
  });

  it("a reply body containing NUL is refused cleanly (no unhandled database error)", async () => {
    const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "a\u0000b", includeQuote: false }).catch((e: unknown) => ({ threw: e instanceof Error ? String((e as { cause?: unknown }).cause ?? e.message).slice(0, 160) : String(e) }));
    expect(r).not.toHaveProperty("threw");
  });

  // ---- Q6 -------------------------------------------------------------------------------------

  it("Q6: a message that lands in the thread while the item is pending sets the warning, even if Gmail received it shortly before the reply was saved (sync lag)", async () => {
    // Arrives in Gmail one minute ago, not yet synced into Alex when the owner writes the reply.
    gmail.deliver(msg({ id: "late1", internalDate: Date.now() - 60_000, from: "Alice <alice@example.org>" }));
    const it0 = await propose();
    await runUntilEmpty();
    const stored = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "late1"));
    expect(stored).toHaveLength(1);
    expect((await item(it0.id)).threadChangedAt, "thread_changed_at after a message landed while pending").not.toBeNull();
  });

  it("Q6: ack required on every approve while flagged; an edited item keeps the flag", async () => {
    const it0 = await propose();
    clock = Date.now() + 60_000;
    gmail.deliver(msg({ id: "new1", internalDate: Date.now() + 30_000 }));
    await runUntilEmpty();
    const flagged = await item(it0.id);
    expect(flagged.threadChangedAt).not.toBeNull();
    expect(await approveAndSend(deps(), approveInput(flagged))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
    await editItem(database, { userId, itemId: it0.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "changed", includeQuote: true });
    const e = await item(it0.id);
    expect(e.threadChangedAt).not.toBeNull();
    expect(await approveAndSend(deps(), approveInput(e))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
    expect((await approveAndSend(deps(), approveInput(e, { ackThreadChange: true }))).kind).toBe("executed");
    expect(sends).toHaveLength(1);
  });

  // ---- unknown, reconcile, ingest spoofing ------------------------------------------------------

  it("unknown is never resent: replayed approve, reconcile with no hit, cron-style runs and recheck all send nothing", async () => {
    nextOutcome = () => ({ kind: "unknown", code: "gmail_5xx", status: 503 });
    const it0 = await propose();
    await approveAndSend(deps(), approveInput(it0));
    expect((await item(it0.id)).status).toBe("unknown");
    const lookups: string[] = [];
    const none: GmailClient = { listMessages: async (req: { q: string }) => (lookups.push(req.q), { messages: undefined }) } as unknown as GmailClient;
    for (let i = 0; i < 3; i++) {
      await approveAndSend(deps(), approveInput(it0));
      await reconcileApprovals({ db: database, gmailFor: () => none });
      await reconcileApprovals({ db: database, gmailFor: () => none }, { userId, itemId: it0.id });
    }
    expect(sends).toHaveLength(1);
    expect((await item(it0.id)).status).toBe("unknown");
    expect(new Set(lookups)).toEqual(new Set([`rfc822msgid:${(await item(it0.id)).messageIdHeader}`]));
    // markNotSent: refused before 30 minutes, allowed after; then an approve is a new Message-ID.
    expect(await markNotSent(database, userId, it0.id, new Date())).toBe(false);
    const first = (await item(it0.id)).messageIdHeader;
    expect(await markNotSent(database, userId, it0.id, new Date(Date.now() + 31 * 60_000))).toBe(true);
    nextOutcome = (n) => ({ kind: "succeeded", gmailMessageId: `s${n}`, gmailThreadId: "gt1" });
    // Round 2 (Q8): the pre-failure approve POST is stale after mark-not-sent; nothing resends on its own.
    expect(await approveAndSend(deps(), approveInput(it0))).toMatchObject({ kind: "approval", result: { kind: "stale" } });
    await reconcileApprovals({ db: database, gmailFor: () => none });
    expect(sends).toHaveLength(1);
    // Only an explicit approve from a freshly rendered page (current revision) sends again, with a new Message-ID.
    const fresh = await item(it0.id);
    expect(fresh.revision).toBe(it0.revision + 1);
    await approveAndSend(deps(), approveInput(fresh));
    expect(sends).toHaveLength(2);
    expect((await item(it0.id)).messageIdHeader).not.toBe(first);
  });

  it("ingest hook: an inbound (non-SENT) message carrying our Message-ID, or a SENT one in another account, does not resolve unknown", async () => {
    nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
    const it0 = await propose();
    await approveAndSend(deps(), approveInput(it0));
    const ours = (await item(it0.id)).messageIdHeader!;
    clock = Date.now() + 60_000;
    gmail.deliver(msg({ id: "spoof1", labelIds: ["INBOX"], messageIdHeader: ours, internalDate: Date.now() + 30_000 }));
    gmail.deliver(msg({ id: "spoof2", labelIds: ["INBOX"], messageIdHeader: ours.toUpperCase(), internalDate: Date.now() + 31_000 }));
    await runUntilEmpty();
    expect((await item(it0.id)).status).toBe("unknown");
    // Same header SENT from another of my accounts: no match (account-scoped).
    const acc2 = await makeGoogleAccount(database, userId, { email: "personal@example.com", label: "personal" });
    const g2 = new FakeGmail();
    g2.seed(msg({ id: "s2", threadId: "gtX", labelIds: ["SENT"], messageIdHeader: ours }));
    const saveG = gmail;
    const saveA = account;
    gmail = g2;
    account = acc2;
    await runUntilEmpty();
    gmail = saveG;
    account = saveA;
    expect((await item(it0.id)).status).toBe("unknown");
    // The genuine SENT copy in the right account resolves it.
    gmail.deliver(msg({ id: "real1", labelIds: ["SENT"], messageIdHeader: ours, internalDate: Date.now() + 40_000 }));
    await runUntilEmpty();
    expect((await item(it0.id)).status).toBe("succeeded");
    expect(sends).toHaveLength(1);
  });

  it("reconcile list lookup: a hit that is an inbound (non-SENT) message must not mark the item sent", async () => {
    nextOutcome = () => ({ kind: "unknown", code: "gmail_5xx", status: 500 });
    const it0 = await propose();
    await approveAndSend(deps(), approveInput(it0));
    // Gmail's rfc822msgid: search is mailbox-wide; here the only hit is an inbound message in INBOX.
    gmail.seed(msg({ id: "inbound-spoof", labelIds: ["INBOX"], messageIdHeader: (await item(it0.id)).messageIdHeader! }));
    const lookup = {
      listMessages: async () => ({ messages: [{ id: "inbound-spoof", threadId: "gt1" }] }),
      getMessageMinimal: (id: string) => gmail.getMessageMinimal(id),
      getMessageFull: (id: string) => gmail.getMessageFull(id),
    } as unknown as GmailClient;
    await reconcileApprovals({ db: database, gmailFor: () => lookup });
    expect((await item(it0.id)).status, "inbound copy treated as proof of send").toBe("unknown");
  });

  // ---- reauth (Testing-mode 7-day expiry) and the 401 retry ------------------------------------

  it("7-day refresh-token expiry: failed/reauth_required with no Gmail request, account flagged, approval blocked until reconnected, then a new Message-ID", async () => {
    await database.update(schema.connectedAccounts).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.connectedAccounts.id, account.id));
    const fetches: { url: string; body: string }[] = [];
    const fetchSpy = async (url: string, init?: RequestInit) => {
      fetches.push({ url, body: String(init?.body) });
      return new Response(JSON.stringify({ id: "m1", threadId: "gt1" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    let refreshFails = true;
    const realSend: Sender = (acc, req) =>
      sendRawMessage(
        () =>
          getAccessToken(database, acc, TEST_KEY, async () => {
            if (refreshFails) throw Object.assign(new Error("invalid_grant: Token has been expired or revoked."), { code: "invalid_grant" });
            return { accessToken: "fresh", accessTokenExpiresAt: new Date(Date.now() + 3600_000) };
          }),
        req,
        fetchSpy,
      );
    const it0 = await propose();
    const r = await approveAndSend(deps({ send: realSend }), approveInput(it0));
    expect(r).toMatchObject({ kind: "executed", outcome: { kind: "failed", code: "reauth_required" } });
    expect(fetches).toHaveLength(0);
    expect((await reload()).status).toBe("reauth_required");
    const failed = await item(it0.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "reauth_required" });
    expect(await approveAndSend(deps({ send: realSend }), approveInput(failed))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "account_inactive" } });
    // Reconnect (status active again), approve again: one request, new Message-ID.
    await database.update(schema.connectedAccounts).set({ status: "active" }).where(eq(schema.connectedAccounts.id, account.id));
    refreshFails = false;
    const first = failed.messageIdHeader;
    const r2 = await approveAndSend(deps({ send: realSend }), approveInput(failed));
    expect(r2).toMatchObject({ kind: "executed", outcome: { kind: "succeeded" } });
    expect(fetches).toHaveLength(1);
    expect((await item(it0.id)).messageIdHeader).not.toBe(first);
  });

  // ---- audit content ---------------------------------------------------------------------------

  it("audit details for a hostile flow carry no address, subject or body text, and every entry has the account", async () => {
    nextOutcome = (n) => (n === 1 ? { kind: "failed", code: "gmail_400", status: 400 } : n === 2 ? { kind: "unknown", code: "timeout", status: null } : { kind: "succeeded", gmailMessageId: "ok3", gmailThreadId: "gt1" });
    const it0 = await propose({ subject: "Re: SECRETSUBJECT", bodyText: "SECRETBODY", cc: "carol@example.net" });
    await approveAndSend(deps(), approveInput(it0));
    await editItem(database, { userId, itemId: it0.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: SECRETSUBJECT2", bodyText: "SECRETBODY2", includeQuote: true });
    const e = await item(it0.id);
    await approveAndSend(deps(), approveInput(e));
    await markNotSent(database, userId, it0.id, new Date(Date.now() + 31 * 60_000));
    await approveAndSend(deps(), approveInput(await item(it0.id)));
    const rows = await audits();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const a of rows) {
      const s = JSON.stringify(a.detail);
      expect(s, a.action).not.toMatch(/@|SECRET|Lunch|Sounds|alice|carol|example/i);
      expect(a.accountId, a.action).toBe(account.id);
    }
  });

  // ---- round 2: attacks on the D1-D4 / Q8 / 401 fixes ------------------------------------------

  describe("round 2", () => {
    const flagOf = async (id: string) => (await item(id)).threadChangedAt;

    it("D1 orderings: lagged arrival after the parent flags; older-than-parent doesn't; failed items flag; approved/executing/unknown/succeeded don't", async () => {
      // Parent p1 is at clock - DAY. A message received after p1 but before the reply was saved, synced later: flagged.
      const a = await propose();
      gmail.deliver(msg({ id: "lagA", internalDate: Date.now() - 5 * 60_000 }));
      await runUntilEmpty();
      expect(await flagOf(a.id), "lagged").not.toBeNull();

      // 2c round 2 (D1 at propose time): lagA is newer than the parent, so every later propose on
      // this parent starts flagged. To keep testing the ingest hook's own ordering rules below, the
      // propose-time flag is asserted and then cleared before each new delivery.
      const proposeCleared = async () => {
        const x = await propose();
        expect(x.threadChangedAt, "propose-time flag (newer message than the parent already stored)").not.toBeNull();
        await database.update(schema.approvalItems).set({ threadChangedAt: null }).where(eq(schema.approvalItems.id, x.id));
        return x;
      };
      // Older than the parent (a late backfilled history message): the hook doesn't flag.
      const b = await proposeCleared();
      gmail.deliver(msg({ id: "oldB", internalDate: clock - 2 * DAY }));
      await runUntilEmpty();
      expect(await flagOf(b.id), "older than parent").toBeNull();

      // Statuses: pending and failed flag; the rest don't.
      const st: Record<string, string> = {};
      for (const status of ["failed", "approved", "executing", "unknown", "succeeded", "rejected", "cancelled"] as const) {
        const x = await proposeCleared();
        await database.update(schema.approvalItems).set({ status }).where(eq(schema.approvalItems.id, x.id));
        st[status] = x.id;
      }
      gmail.deliver(msg({ id: "newC", internalDate: Date.now() + 1000 }));
      await runUntilEmpty();
      expect(await flagOf(st.failed!), "failed").not.toBeNull();
      for (const s of ["approved", "executing", "unknown", "succeeded", "rejected", "cancelled"]) expect(await flagOf(st[s]!), s).toBeNull();

      // The owner's own reply sent from Gmail (SENT, not Alex's Message-ID) newer than the parent: flagged.
      const d = await proposeCleared();
      gmail.deliver(msg({ id: "webD", labelIds: ["SENT"], from: "work@example.com", internalDate: Date.now() + 2000 }));
      await runUntilEmpty();
      expect(await flagOf(d.id), "owner's own Gmail-web reply").not.toBeNull();
    });

    it("round 3 (D5): parent_internal_date is the parent's, survives edits, and drives the flag with the parent deleted before or after new mail", async () => {
      const [p1row] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, parentId));
      // Second message so the thread survives deleting the parent; the reply targets it.
      gmail.deliver(msg({ id: "p3", internalDate: Date.now() - 60 * 60_000, messageIdHeader: "<p3@mail.example.org>" }));
      await runUntilEmpty();
      const [p3] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "p3"));
      const x = await propose({ parentMessageId: p3!.id });
      expect(x.parentInternalDate?.getTime()).toBe(p3!.internalDate.getTime());
      // Edits (several, including changing everything and toggling the quote) never move the baseline.
      let rev = x.revision;
      for (const over of [{ bodyText: "e1", includeQuote: false }, { bodyText: "e2", includeQuote: true, subject: "Other subject" }, { bodyText: "e3", includeQuote: false, to: "bob@example.net" }]) {
        const r = await editItem(database, { userId, itemId: x.id, revision: rev, to: "alice@example.org", cc: "", subject: "Re: Lunch", ...over });
        expect(r).toMatchObject({ ok: true });
        rev = (r as { revision: number }).revision;
        expect((await item(x.id)).parentInternalDate?.getTime()).toBe(p3!.internalDate.getTime());
      }
      // A second item replying to the older p1, and one whose parent baseline is between the new message and p3.
      const y = await propose({ parentMessageId: p1row!.id });

      // Parent deleted AFTER a lagged new message landed: the flag set earlier stays.
      gmail.deliver(msg({ id: "lag1", internalDate: Date.now() - 30 * 60_000 })); // after p3, before both items were created
      await runUntilEmpty();
      expect((await item(x.id)).threadChangedAt, "x flagged by lag1").not.toBeNull();
      expect((await item(y.id)).threadChangedAt, "y flagged by lag1").not.toBeNull();
      gmail.deleteForever("p3");
      await runUntilEmpty();
      expect((await item(x.id)).parentMessageId).toBeNull();
      expect((await item(x.id)).threadChangedAt, "flag survives parent deletion").not.toBeNull();

      // Parent deleted BEFORE new mail: fresh items, parent p4 deleted, then (a) a message older than p4 -> no flag,
      // (b) a lagged message newer than p4 -> flag.
      gmail.deliver(msg({ id: "p4", internalDate: Date.now() - 20 * 60_000, messageIdHeader: "<p4@mail.example.org>" }));
      await runUntilEmpty();
      const [p4] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "p4"));
      const z = await propose({ parentMessageId: p4!.id });
      gmail.deleteForever("p4");
      await runUntilEmpty();
      expect(await item(z.id)).toMatchObject({ parentMessageId: null, threadChangedAt: null });
      expect((await item(z.id)).parentInternalDate?.getTime()).toBe(p4!.internalDate.getTime());
      gmail.deliver(msg({ id: "older1", internalDate: Date.now() - 25 * 60_000 }));
      await runUntilEmpty();
      expect((await item(z.id)).threadChangedAt, "older than the deleted parent").toBeNull();
      gmail.deliver(msg({ id: "lag2", internalDate: Date.now() - 2 * 60_000 }));
      await runUntilEmpty();
      expect((await item(z.id)).threadChangedAt, "lagged, newer than the deleted parent").not.toBeNull();
      // The ack is still required and works.
      const zz = await item(z.id);
      expect(await approveAndSend(deps(), approveInput(zz))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
    });

    it("D1 with the parent missing: a message Gmail received before the reply was saved but synced after it", async () => {
      // Thread with two messages; reply to the newer one (p2), then p2 is deleted in Gmail (parent_message_id SET NULL).
      gmail.deliver(msg({ id: "p2", internalDate: Date.now() - 60 * 60_000, messageIdHeader: "<p2@mail.example.org>" }));
      await runUntilEmpty();
      const [p2] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "p2"));
      const x = await propose({ parentMessageId: p2!.id });
      gmail.deleteForever("p2");
      await runUntilEmpty();
      expect((await item(x.id)).parentMessageId, "premise: parent gone").toBeNull();
      expect((await item(x.id)).threadId, "premise: thread still there").not.toBeNull();
      gmail.deliver(msg({ id: "lagE", internalDate: Date.now() - 2 * 60_000 }));
      await runUntilEmpty();
      expect(await flagOf(x.id), "lagged message with the parent deleted").not.toBeNull();
    });

    it("D3: SENT copy among inbound hits is found (its id is stored); inbound-only, a 6th-position SENT and a lookup error leave it unknown", async () => {
      nextOutcome = () => ({ kind: "unknown", code: "gmail_5xx", status: 500 });
      const mk = async () => {
        const it0 = await propose();
        await approveAndSend(deps(), approveInput(it0));
        return (await item(it0.id))!;
      };
      const meta: Record<string, string[]> = { in1: ["INBOX"], in2: ["INBOX", "IMPORTANT"], sent1: ["SENT"], spam: ["SPAM"] };
      const lookup = (ids: string[], fail = false) =>
        ({
          listMessages: async () => ({ messages: ids.map((id) => ({ id, threadId: "gt1" })) }),
          getMessageMinimal: async (id: string) => {
            if (fail) throw new Error("boom");
            return { id, threadId: "gt1", labelIds: meta[id] ?? ["INBOX"] };
          },
        }) as unknown as GmailClient;
      const a = await mk();
      await reconcileApprovals({ db: database, gmailFor: () => lookup(["in1", "in2", "sent1"]) }, { itemId: a.id });
      expect(await item(a.id)).toMatchObject({ status: "succeeded", result: { gmailMessageId: "sent1" } });
      const b = await mk();
      await reconcileApprovals({ db: database, gmailFor: () => lookup(["in1", "spam", "in2"]) }, { itemId: b.id });
      expect((await item(b.id)).status).toBe("unknown");
      const c = await mk();
      await reconcileApprovals({ db: database, gmailFor: () => lookup(["in1", "in1", "in1", "in1", "in1", "sent1"]) }, { itemId: c.id });
      expect((await item(c.id)).status, "SENT beyond the first 5 hits: stays unknown (the safe direction)").toBe("unknown");
      const d = await mk();
      const r = await reconcileApprovals({ db: database, gmailFor: () => lookup(["sent1"], true) }, { itemId: d.id });
      expect(r.errors).toBe(1);
      expect((await item(d.id)).status).toBe("unknown");
      expect(sends).toHaveLength(4);
    });

    it("D4: every C0 control except tab/LF/CR and DEL is refused in the body (propose and edit); subject refuses C0, DEL, C1, U+2028/9; nothing reaches the database as an error", async () => {
      const it0 = await propose();
      const accepted: string[] = [];
      for (let c = 0; c < 0x20; c++) {
        const ch = String.fromCharCode(c);
        const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: `a${ch}b`, includeQuote: false }).catch((e: unknown) => ({ threw: String(e) }));
        const e = await editItem(database, { userId, itemId: it0.id, revision: (await item(it0.id)).revision, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: `a${ch}b`, includeQuote: false }).catch((err: unknown) => ({ threw: String(err) }));
        expect(r, `0x${c.toString(16)}`).not.toHaveProperty("threw");
        expect(e, `0x${c.toString(16)}`).not.toHaveProperty("threw");
        if ((r as { ok: boolean }).ok) accepted.push(c.toString(16));
        expect((r as { ok: boolean }).ok, `edit and propose agree for 0x${c.toString(16)}`).toBe((e as { ok: boolean }).ok);
        if (!(r as { ok: boolean }).ok) expect(r).toEqual({ ok: false, error: "invalid_body" });
      }
      expect(accepted).toEqual(["9", "a", "d"]);
      for (const ch of ["\u007f"]) {
        expect(await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: x", bodyText: `a${ch}b`, includeQuote: false })).toEqual({ ok: false, error: "invalid_body" });
      }
      // C1 and line/paragraph separators in the body are accepted (base64 text/plain; documented).
      for (const ch of ["\u0085", "\u009b", " ", " "]) {
        expect((await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: x", bodyText: `a${ch}b`, includeQuote: false })).ok, JSON.stringify(ch)).toBe(true);
      }
      const subjectBad = [...Array.from({ length: 0x20 }, (_, c) => String.fromCharCode(c)), "\u007f", "\u0080", "\u0085", "\u009f", " ", " "];
      for (const ch of subjectBad) {
        const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: `Re: a${ch}b`, bodyText: "x", includeQuote: false }).catch((e: unknown) => ({ threw: String(e) }));
        // Tab, LF, CR at the edges are trimmed; inside they are refused.
        expect(r, JSON.stringify(ch)).toEqual({ ok: false, error: "invalid_subject" });
      }
      for (const ch of ["\u0000", "\u001b", "\u007f", "\u0085", " "]) {
        const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: `alice${ch}@example.org`, cc: "", subject: "Re: x", bodyText: "x", includeQuote: false }).catch((e: unknown) => ({ threw: String(e) }));
        expect(r, JSON.stringify(ch)).toEqual({ ok: false, error: "invalid_recipients" });
      }
      // A parent whose text carries every C0 control: the quote keeps only tab/LF and is stored fine.
      // NUL itself is left out: 2a can't store a message body containing NUL at all (pre-existing; probe below).
      const all = Array.from({ length: 0x1f }, (_, c) => String.fromCharCode(c + 1)).join("") + "\u007f end";
      const ids = await ingestParent(msg({ id: "ctl1", threadId: "gtC", payload: textPart("text/plain", `start ${all}`) }));
      const r = await proposeReply(database, { userId, ...ids, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "x", includeQuote: true }).catch((e: unknown) => ({ threw: String(e) }));
      expect(r).toMatchObject({ ok: true });
      const q = emailSendPayload.parse((await item((r as { itemId: string }).itemId)).payload).quote?.text ?? "";
      expect([...q].filter((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f).map((ch) => ch.charCodeAt(0)).filter((c) => c !== 0x0a && c !== 0x09)).toEqual([]);
    });

    // Pre-existing 2a finding (not caused by 2b): this fails today, so it is env-gated to keep the suite meaningful.
    it.runIf(process.env.TESTER_PREEXISTING === "1")("pre-existing 2a probe: an inbound message whose text body contains NUL is stored", async () => {
      await ingestParent(msg({ id: "nul1", threadId: "gtN", payload: textPart("text/plain", "a\u0000b") })).catch(() => null);
      const stored = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "nul1"));
      expect(stored, "2a stores a message with NUL in its body").toHaveLength(1);
    });

    it("Q8: an old approve POST is stale after failed (Gmail 4xx, reauth, stale account) and after mark-not-sent; only the fresh revision sends", async () => {
      for (const failure of [{ kind: "failed", code: "gmail_400", status: 400 }, { kind: "failed", code: "reauth_required", status: null }] as const) {
        sends = [];
        nextOutcome = (n) => (n === 1 ? failure : { kind: "succeeded", gmailMessageId: `ok${n}`, gmailThreadId: "gt1" });
        const it0 = await propose();
        await approveAndSend(deps(), approveInput(it0));
        const f = await item(it0.id);
        expect(f).toMatchObject({ status: "failed", revision: 2 });
        for (let i = 0; i < 3; i++) expect(await approveAndSend(deps(), approveInput(it0)), failure.code).toMatchObject({ kind: "approval", result: { kind: "stale" } });
        expect(sends).toHaveLength(1);
        await approveAndSend(deps(), approveInput(f));
        expect(sends).toHaveLength(2);
        expect(await approveAndSend(deps(), approveInput(f))).toMatchObject({ kind: "approval", result: { kind: "stale", status: "succeeded" } });
        expect(sends).toHaveLength(2);
      }
      // Executor pre-check failure (thread moved to another account): also bumps.
      sends = [];
      nextOutcome = (n) => ({ kind: "succeeded", gmailMessageId: `ok${n}`, gmailThreadId: "gt1" });
      const g = await propose();
      await approveItem(database, approveInput(g));
      const mine2 = await makeGoogleAccount(database, userId, { email: "personal@example.com", label: "personal" });
      await database.update(schema.mailThreads).set({ accountId: mine2.id }).where(eq(schema.mailThreads.id, threadId));
      await approveAndSend(deps(), approveInput(g));
      expect(await item(g.id)).toMatchObject({ status: "failed", errorCode: "stale_account", revision: 2 });
      await database.update(schema.mailThreads).set({ accountId: account.id }).where(eq(schema.mailThreads.id, threadId));
      expect((await approveAndSend(deps(), approveInput(g))).kind).toBe("approval");
      expect(sends).toHaveLength(0);
      // After mark-not-sent: the pre-unknown POST and the unknown-time page POST are both stale.
      nextOutcome = (n) => (n === 1 ? { kind: "unknown", code: "timeout", status: null } : { kind: "succeeded", gmailMessageId: `ok${n}`, gmailThreadId: "gt1" });
      const u = await propose();
      await approveAndSend(deps(), approveInput(u));
      const unk = await item(u.id);
      expect(unk).toMatchObject({ status: "unknown", revision: 1 });
      expect(await markNotSent(database, userId, u.id, new Date(Date.now() + 31 * 60_000))).toBe(true);
      for (const old of [u, unk]) expect(await approveAndSend(deps(), approveInput(old))).toMatchObject({ kind: "approval", result: { kind: "stale" } });
      expect(sends).toHaveLength(1);
      const fresh = await item(u.id);
      expect(fresh.revision).toBe(2);
      await approveAndSend(deps(), approveInput(fresh));
      expect(sends).toHaveLength(2);
      expect((await item(u.id)).messageIdHeader).not.toBe(unk.messageIdHeader);
    });

    it("401 through the full approve path: exactly one Gmail request, failed/gmail_401, token not refreshed, revision bumped", async () => {
      const fetches: string[] = [];
      let tokenCalls = 0;
      const realSend: Sender = (_acc, req) =>
        sendRawMessage(
          async (o) => {
            tokenCalls++;
            if (o?.forceRefresh) throw new Error("refresh must not happen");
            return "tok";
          },
          req,
          async (url, init) => {
            fetches.push(`${init?.method} ${url}`);
            return new Response(JSON.stringify({ error: { code: 401 } }), { status: 401, headers: { "content-type": "application/json" } });
          },
        );
      const it0 = await propose();
      const r = await approveAndSend(deps({ send: realSend }), approveInput(it0));
      expect(r).toMatchObject({ kind: "executed", outcome: { kind: "failed", code: "gmail_401", status: 401 } });
      expect(fetches).toEqual(["POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send"]);
      expect(tokenCalls).toBe(1);
      expect(await item(it0.id)).toMatchObject({ status: "failed", errorCode: "gmail_401", revision: 2 });
    });
  });

  // ---- round 4: B1 (Q6 bound to what was rendered) and B2 (status classes) -----------------------

  describe("round 4", () => {
    const land = async (id: string, ms = 1000) => {
      gmail.deliver(msg({ id, internalDate: Date.now() + ms }));
      await runUntilEmpty();
    };

    it("B1: a tick from a page rendered before another message landed sends nothing; omitted/forged values too; only the exact rendered value plus the tick sends", async () => {
      const it0 = await propose();
      await land("a1");
      const r1 = await item(it0.id); // page render 1 (warning for a1)
      expect(r1.threadChangedAt).not.toBeNull();
      await sleep(5);
      await land("b1", 2000);
      const r2 = await item(it0.id); // page render 2 (warning moved)
      expect(r2.threadChangedAt!.getTime()).toBeGreaterThan(r1.threadChangedAt!.getTime());
      const shown2 = r2.threadChangedAt!.getTime();
      const bad: Partial<Parameters<typeof approveItem>[1]>[] = [
        { ackThreadChange: true, shownThreadChangedAt: r1.threadChangedAt!.getTime() }, // stale tick
        { ackThreadChange: true, shownThreadChangedAt: undefined }, // omitted field
        { ackThreadChange: true, shownThreadChangedAt: null }, // "no warning shown"
        { ackThreadChange: true, shownThreadChangedAt: shown2 + 1 },
        { ackThreadChange: true, shownThreadChangedAt: shown2 - 1 },
        { ackThreadChange: true, shownThreadChangedAt: 0 },
        { ackThreadChange: true, shownThreadChangedAt: -shown2 },
        { ackThreadChange: true, shownThreadChangedAt: 9_999_999_999_999_999 }, // beyond Date range: must not throw
        { ackThreadChange: true, shownThreadChangedAt: Number.NaN },
        { ackThreadChange: false, shownThreadChangedAt: shown2 }, // exact value, no tick
      ];
      for (const over of bad) {
        expect(await approveAndSend(deps(), approveInput(r2, over)), JSON.stringify(over)).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
      }
      expect(sends).toHaveLength(0);
      expect((await item(it0.id)).status).toBe("pending");
      expect((await audits()).filter((a) => a.action === "approval.approved")).toHaveLength(0);
      expect((await approveAndSend(deps(), approveInput(r2, { ackThreadChange: true }))).kind).toBe("executed");
      expect(sends).toHaveLength(1);
    });

    it("B1: null vs null sends; a page rendered unflagged, then a message lands: nothing is sent with or without the tick", async () => {
      const a = await propose();
      expect((await approveAndSend(deps(), approveInput(a))).kind).toBe("executed"); // null vs null
      const b = await propose();
      const rb = await item(b.id); // rendered with no warning
      await land("c1");
      for (const tick of [false, true]) {
        expect(await approveAndSend(deps(), approveInput(rb, { ackThreadChange: tick })), String(tick)).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
      }
      expect(sends).toHaveLength(1);
      // A failed item keeps the flag: approve-again from the fresh page needs the value and the tick.
      nextOutcome = (n) => (n === 2 ? { kind: "failed", code: "gmail_400", status: 400 } : { kind: "succeeded", gmailMessageId: `s${n}`, gmailThreadId: "gt1" });
      const fb = await item(b.id);
      await approveAndSend(deps(), approveInput(fb, { ackThreadChange: true }));
      const failed = await item(b.id);
      expect(failed).toMatchObject({ status: "failed" });
      expect(failed.threadChangedAt?.getTime()).toBe(fb.threadChangedAt?.getTime());
      expect(await approveAndSend(deps(), approveInput(failed))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
      expect((await approveAndSend(deps(), approveInput(failed, { ackThreadChange: true }))).kind).toBe("executed");
      expect(sends).toHaveLength(3);
    });

    it("B1 race on 12 real connections: approve (ticked, rendered value) vs a message landing: sent only if the flag was still the rendered one", async () => {
      const tally = { sent: 0, blocked: 0 };
      for (let round = 0; round < 20; round++) {
        sends = [];
        const it0 = await propose();
        if (round % 2) await land(`pre${round}`); // half the rounds start flagged
        const shown = await item(it0.id);
        const hook = () =>
          onMessageStored(poolDb, {
            accountId: account.id,
            threadId,
            messageId: "00000000-0000-4000-8000-000000000001",
            gmailMessageId: `race${round}`,
            gmailThreadId: "gt1",
            rfc822MessageId: null,
            isSent: false,
            internalDate: new Date(Date.now() + 60_000),
          });
        const d = (round % 10) * 6; // the approve path does several reads before its UPDATE, so the hook needs up to ~54 ms of delay to lose
        const [r] = await Promise.all([
          sleep(round % 4 < 2 ? 0 : Math.floor(d / 6)).then(() => approveAndSend(deps(), approveInput(shown, { ackThreadChange: true }))),
          sleep(round % 4 < 2 ? d : 0).then(hook),
        ]);
        const after = await item(it0.id);
        const same = (after.threadChangedAt?.getTime() ?? null) === (shown.threadChangedAt?.getTime() ?? null);
        if (sends.length === 1) {
          tally.sent++;
          expect(same, `round ${round}: sent although the flag moved`).toBe(true);
          expect(after.status).toBe("succeeded");
        } else {
          tally.blocked++;
          expect(sends).toHaveLength(0);
          expect(same, `round ${round}`).toBe(false);
          expect(r).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
          expect(after.status).toBe("pending");
        }
      }
      if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `b1-race ${JSON.stringify(tally)}\n`);
      expect(tally.sent + tally.blocked).toBe(20);
    });

    it("B2 through the executor: 408/409/499/500/302 leave the item unknown (no revision bump, not approvable, never resent); 400/401/403/404/429 fail and bump", async () => {
      const fetchFor = (status: number) => async () => new Response(JSON.stringify({ error: { code: status } }), { status, headers: { "content-type": "application/json" } });
      for (const [status, kind] of [[408, "unknown"], [409, "unknown"], [499, "unknown"], [500, "unknown"], [302, "unknown"], [410, "unknown"], [400, "failed"], [401, "failed"], [403, "failed"], [404, "failed"], [429, "failed"]] as const) {
        let calls = 0;
        const realSend: Sender = (_a, req) => sendRawMessage(async () => "tok", req, async () => (calls++, fetchFor(status)()));
        const it0 = await propose();
        await approveAndSend(deps({ send: realSend }), approveInput(it0));
        const after = await item(it0.id);
        expect(calls, String(status)).toBe(1);
        expect(after.status, String(status)).toBe(kind);
        expect(after.errorCode, String(status)).toBe(status >= 500 ? "gmail_5xx" : `gmail_${status}`);
        expect(after.revision, String(status)).toBe(kind === "failed" ? 2 : 1);
        expect((await approveAndSend(deps({ send: realSend }), approveInput(after))).kind, String(status)).toBe(kind === "failed" ? "executed" : "approval");
        expect(calls, String(status)).toBe(kind === "failed" ? 2 : 1);
      }
    });
  });

  // ---- round 5: security review S1 (inbound reuse of our Message-ID) and N1 (user-scoped reconcile) ----

  describe("round 5", () => {
    async function unknownItem() {
      nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
      const it0 = await propose();
      // 2c round 2: earlier iterations left newer messages in this thread, so the item can start
      // flagged (D1 at propose time). Approve like the page: rendered value plus the tick (B1).
      await approveAndSend(deps(), approveInput(it0, { ackThreadChange: it0.threadChangedAt !== null }));
      const u = await item(it0.id);
      expect(u.status).toBe("unknown");
      return u;
    }
    let seq = 0;
    const deliverWith = async (labelIds: string[], messageIdHeader: string, threadIdG = "gt1") => {
      seq++;
      gmail.deliver(msg({ id: `r5m${seq}`, threadId: threadIdG, labelIds, messageIdHeader, internalDate: Date.now() + seq * 1000 }));
      await runUntilEmpty();
      return (await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, `r5m${seq}`)))[0] ?? null;
    };

    it("S1: an inbound copy reusing our Message-ID (any non-SENT label set) never resolves the item and now raises Q6 on other pending items", async () => {
      const results: Record<string, { stored: boolean; flagged: boolean }> = {};
      for (const labels of [["INBOX"], ["INBOX", "IMPORTANT", "STARRED"], ["INBOX", "CATEGORY_UPDATES", "UNREAD"], ["CATEGORY_PERSONAL"], ["DRAFT"], ["TRASH"], ["SPAM"]]) {
        await database.delete(schema.approvalItems);
        const u = await unknownItem();
        const sibling = await propose(); // pending item in the same thread
        // It may start flagged by earlier iterations' messages (D1 at propose time); clear it so the
        // assertion below measures what the inbound reuse itself does.
        await database.update(schema.approvalItems).set({ threadChangedAt: null }).where(eq(schema.approvalItems.id, sibling.id));
        const stored = await deliverWith(labels, u.messageIdHeader!);
        expect((await item(u.id)).status, labels.join("+")).toBe("unknown");
        expect((await audits()).filter((a) => a.action === "approval.reconciled"), labels.join("+")).toHaveLength(0);
        const flagged = (await item(sibling.id)).threadChangedAt !== null;
        results[labels.join("+")] = { stored: stored !== null, flagged };
        // Wherever 2a stores it, the reuse must be treated as a new message (the round-4 early return suppressed this).
        if (stored) expect(flagged, labels.join("+")).toBe(true);
      }
      if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `s1 ${JSON.stringify(results)}\n`);
      expect(results["INBOX"]).toEqual({ stored: true, flagged: true });
      expect(sends.length).toBe(7);
    });

    it("S1: sending to yourself (one copy with SENT and INBOX) resolves the item and does not flag other items", async () => {
      const u = await unknownItem();
      const sibling = await propose();
      const stored = await deliverWith(["SENT", "INBOX", "UNREAD"], u.messageIdHeader!);
      expect(stored).not.toBeNull();
      expect(await item(u.id)).toMatchObject({ status: "succeeded", result: { gmailMessageId: stored!.gmailMessageId } });
      expect((await audits()).filter((a) => a.action === "approval.reconciled").map((a) => a.detail)).toEqual([{ itemId: u.id, outcome: "ingest_match" }]);
      expect((await item(sibling.id)).threadChangedAt).toBeNull();
      // A later SENT duplicate of an already-succeeded send: no-op, no flag, no second audit.
      await deliverWith(["SENT"], u.messageIdHeader!);
      expect((await audits()).filter((a) => a.action === "approval.reconciled")).toHaveLength(1);
      expect((await item(sibling.id)).threadChangedAt).toBeNull();
    });

    it("S1: copies in a different account (SENT or inbound) never touch this account's item", async () => {
      const u = await unknownItem();
      const acc2 = await makeGoogleAccount(database, userId, { email: "personal@example.com", label: "personal" });
      const g2 = new FakeGmail();
      const [saveG, saveA] = [gmail, account];
      [gmail, account] = [g2, acc2];
      await runUntilEmpty(); // initial sync of the empty second mailbox, then both arrive through history
      // 2a stores SENT messages only in threads it already knows (no outbound source in 2b), so the SENT copy follows an inbound one in the same thread.
      g2.deliver(msg({ id: "x-in", threadId: "gtY", labelIds: ["INBOX"], messageIdHeader: u.messageIdHeader!, internalDate: Date.now() }));
      g2.deliver(msg({ id: "x-sent", threadId: "gtY", labelIds: ["SENT"], messageIdHeader: u.messageIdHeader!, internalDate: Date.now() + 1 }));
      await runUntilEmpty();
      [gmail, account] = [saveG, saveA];
      expect(await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.accountId, acc2.id))).toHaveLength(2);
      expect((await item(u.id)).status).toBe("unknown");
      expect((await audits()).filter((a) => a.action === "approval.reconciled")).toHaveLength(0);
    });

    it("reconcile vs hook ordering: both racing on 12 connections resolve once (one audit), whichever wins; either order sequentially too", async () => {
      for (let round = 0; round < 12; round++) {
        await database.delete(schema.auditLog);
        const u = await unknownItem();
        const sentLookup = {
          listMessages: async () => ({ messages: [{ id: `list${round}`, threadId: "gt1" }] }),
          getMessageMinimal: async (id: string) => ({ id, threadId: "gt1", labelIds: ["SENT"] }),
        } as unknown as GmailClient;
        const hook = () =>
          poolDb.transaction((tx) =>
            onMessageStored(tx as unknown as Database, {
              accountId: account.id,
              threadId,
              messageId: "00000000-0000-4000-8000-000000000002",
              gmailMessageId: `hook${round}`,
              gmailThreadId: "gt1",
              rfc822MessageId: u.messageIdHeader,
              isSent: true,
              internalDate: new Date(),
            }),
          );
        const rec = () => reconcileApprovals({ db: poolDb, gmailFor: () => sentLookup }, { itemId: u.id });
        if (round < 2) {
          // Sequential, both orders.
          if (round === 0) {
            await hook();
            await rec();
          } else {
            await rec();
            await hook();
          }
        } else {
          await Promise.all([sleep(round % 2 ? round : 0).then(rec), sleep(round % 2 ? 0 : round).then(hook)]);
        }
        const after = await item(u.id);
        expect(after.status, `round ${round}`).toBe("succeeded");
        const rec_ = (await audits()).filter((a) => a.action === "approval.reconciled");
        expect(rec_, `round ${round}`).toHaveLength(1);
        const winner = (rec_[0]!.detail as { outcome: string }).outcome;
        expect((after.result as { gmailMessageId: string }).gmailMessageId).toBe(winner === "ingest_match" ? `hook${round}` : `list${round}`);
      }
    });

    it("N1: markReconciledSent with another user's id (or a mismatched user) changes nothing and writes no audit", async () => {
      const u = await unknownItem();
      const other = await makeUser(database, "intruder@example.com");
      for (const who of [other.id, "00000000-0000-4000-8000-000000000000"]) {
        expect(await markReconciledSent(database, { id: u.id, userId: who, accountId: u.accountId }, { gmailMessageId: "evil", gmailThreadId: "evil" }, "list_found")).toBe(false);
      }
      expect(await item(u.id)).toMatchObject({ status: "unknown", result: null });
      expect((await audits()).filter((a) => a.action === "approval.reconciled")).toHaveLength(0);
      expect(await markReconciledSent(database, { id: u.id, userId, accountId: u.accountId }, { gmailMessageId: "ok", gmailThreadId: "gt1" }, "list_found")).toBe(true);
      expect(await item(u.id)).toMatchObject({ status: "succeeded", result: { gmailMessageId: "ok" } });
    });
  });
});
