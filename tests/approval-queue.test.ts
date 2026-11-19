import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { asc, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { ReauthRequiredError } from "@/lib/accounts";
import { approveAndSend, executeClaimed, type ExecutorDeps, type Sender } from "@/lib/approvals/execute";
import { contentHash, emailSendPayload, outgoingBody } from "@/lib/approvals/payload";
import { reconcileApprovals } from "@/lib/approvals/reconcile";
import {
  approveItem,
  cancelItem,
  claimItem,
  countNeedingOwner,
  editItem,
  getItemView,
  getOwnItem,
  listItems,
  markNotSent,
  markReconciledSent,
  proposeReply,
  rejectItem,
  replyContext,
  replyFormDefaults,
} from "@/lib/approvals/service";
import type { GmailClient } from "@/lib/gmail/client";
import { buildMessage } from "@/lib/gmail/compose";
import { sendRawMessage, type SendOutcome } from "@/lib/gmail/send";
import { getSyncState } from "@/lib/gmail/store";
import { syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { FakeGmail, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Phase 2b with Postgres and a fake Gmail: the state machine (plan §5), concurrency and
// idempotency (AC4), exact match (AC3), account rules (AC5), outcome handling (AC6), reconcile,
// user scoping (AC9), same-transaction audit (AC10) and 2a integration (AC12).

const HOST = "alex.example.com";
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!testDbUrl)("approval queue (Postgres + fake Gmail)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
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
  });
  afterAll(async () => {
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
    await sleep(20); // widen any race window
    return nextOutcome(sends.length);
  };
  const deps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({ db: database, send, ...over });
  const audits = async (prefix = "approval.") =>
    (await database.select().from(schema.auditLog).orderBy(asc(schema.auditLog.createdAt))).filter((a) => a.action.startsWith(prefix));

  async function propose(over: Partial<Parameters<typeof proposeReply>[1]> = {}) {
    const r = await proposeReply(database, {
      userId,
      threadId,
      parentMessageId: parentId,
      to: "alice@example.org",
      cc: "",
      subject: "Re: Lunch",
      bodyText: "Sounds good.\r\nSee you.",
      includeQuote: true,
      ...over,
    });
    if (!r.ok) throw new Error(r.error);
    return (await getOwnItem(database, userId, r.itemId))!;
  }
  // Like the approval page: the form carries the thread_changed_at it rendered (B1).
  const approveInput = (
    item: { id: string; revision: number; contentHash: string; threadChangedAt?: Date | null },
    over: Partial<Parameters<typeof approveItem>[1]> = {},
  ) => ({
    userId,
    itemId: item.id,
    revision: item.revision,
    contentHash: item.contentHash,
    ackThreadChange: false,
    shownThreadChangedAt: item.threadChangedAt ? item.threadChangedAt.getTime() : null,
    messageIdHost: HOST,
    ...over,
  });

  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    gmail = new FakeGmail();
    clock = Date.now();
    sends = [];
    nextOutcome = (n) => ({ kind: "succeeded", gmailMessageId: `sent${n}`, gmailThreadId: "gt1" });
    gmail.seed(msg({ id: "p1", messageIdHeader: "<p1@mail.example.org>", inReplyTo: "<root@mail.example.org>" }));
    await runUntilEmpty();
    const [thread] = await database.select().from(schema.mailThreads).where(eq(schema.mailThreads.accountId, account.id));
    threadId = thread!.id;
    const [parent] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "p1"));
    parentId = parent!.id;
  });

  // ---- propose -------------------------------------------------------------------------------

  it("propose: pending, the thread's account, threading from the stored parent, nothing sent", async () => {
    const ctx = (await replyContext(database, userId, threadId))!;
    expect(replyFormDefaults(ctx, "reply")).toMatchObject({ to: ["alice@example.org"], cc: [], subject: "Re: Lunch", hasQuote: true });
    const item = await propose();
    expect(item).toMatchObject({ status: "pending", kind: "email.send", source: "owner", accountId: account.id, threadId, parentMessageId: parentId, revision: 1 });
    const p = emailSendPayload.parse(item.payload);
    expect(p.threading).toEqual({ gmailThreadId: "gt1", inReplyTo: "<p1@mail.example.org>", references: ["<root@mail.example.org>", "<p1@mail.example.org>"] });
    expect(p.bodyText).toBe("Sounds good.\nSee you.");
    expect(p.quote?.included).toBe(true);
    expect(p.quote?.text).toContain("> Body of p1");
    expect(item.contentHash).toBe(contentHash("email.send", account.id, item.payload));
    expect(sends).toEqual([]);
    expect((await audits()).map((a) => [a.action, a.detail])).toEqual([["approval.proposed", { itemId: item.id, kind: "email.send", source: "owner", recipients: 1 }]]);
    expect(await countNeedingOwner(database, userId)).toBe(1);
  });

  it("propose validates recipients and subject, and rejects another user's thread", async () => {
    const bad = (over: Partial<Parameters<typeof proposeReply>[1]>) => proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "a@example.org", cc: "", subject: "Re: x", bodyText: "", includeQuote: false, ...over });
    expect(await bad({ to: "Alice <a@example.org>" })).toEqual({ ok: false, error: "invalid_recipients" });
    expect(await bad({ to: "" })).toEqual({ ok: false, error: "no_recipients" });
    expect(await bad({ cc: Array.from({ length: 50 }, (_, i) => `c${i}@example.org`).join("\n") })).toEqual({ ok: false, error: "too_many_recipients" });
    expect(await bad({ subject: "x\r\nBcc: e@example.org" })).toEqual({ ok: false, error: "invalid_subject" });
    expect(await bad({ bodyText: "x".repeat(100_001) })).toEqual({ ok: false, error: "body_too_long" });
    const other = (await makeUser(database, "other@example.com")).id;
    expect(await bad({ userId: other })).toEqual({ ok: false, error: "not_found" });
    expect(await bad({ parentMessageId: "00000000-0000-4000-8000-000000000000" })).toEqual({ ok: false, error: "not_found" });
  });

  // ---- approve, exact match ------------------------------------------------------------------

  it("approve sends once, and the bytes are exactly the approved copy (AC3)", async () => {
    const item = await propose({ cc: "bob@example.net" });
    const r = await approveAndSend(deps(), approveInput(item));
    expect(r).toMatchObject({ kind: "executed", outcome: { kind: "succeeded", gmailMessageId: "sent1" } });
    expect(sends).toHaveLength(1);
    const after = (await getOwnItem(database, userId, item.id))!;
    expect(after).toMatchObject({ status: "succeeded", approvedRevision: 1, approvedHash: item.contentHash, result: { gmailMessageId: "sent1", gmailThreadId: "gt1" } });
    expect(after.approvedPayload).toEqual(item.payload);
    expect(after.messageIdHeader).toMatch(new RegExp(`^<alex\\.${item.id}\\.1\\.[0-9a-f]{12}@alex\\.example\\.com>$`));

    const sent = sends[0]!;
    expect(sent.accountId).toBe(account.id);
    expect(sent.threadId).toBe("gt1");
    const text = Buffer.from(sent.raw, "base64url").toString("utf8");
    const p = emailSendPayload.parse(after.approvedPayload);
    const dateLine = /\r\nDate: ([^\r]+)\r\n/.exec(text)![1]!;
    expect(text).toBe(
      buildMessage({
        from: "work@example.com",
        to: p.to,
        cc: p.cc,
        subject: p.subject,
        bodyText: outgoingBody(p),
        messageId: after.messageIdHeader!,
        inReplyTo: "<p1@mail.example.org>",
        references: ["<root@mail.example.org>", "<p1@mail.example.org>"],
        date: new Date(dateLine),
      }),
    );
    const head = text.slice(0, text.indexOf("\r\n\r\n"));
    expect(head).toContain("From: work@example.com\r\nTo: alice@example.org\r\nCc: bob@example.net\r\nSubject: Re: Lunch\r\n");
    const body = Buffer.from(text.slice(text.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(body).toBe(outgoingBody(p).replace(/\n/g, "\r\n"));

    expect((await audits()).map((a) => a.action)).toEqual([
      "approval.proposed",
      "approval.approved",
      "approval.execution_started",
      "approval.executed",
    ]);
    expect((await audits()).every((a) => a.accountId === account.id)).toBe(true);
  });

  it("10 concurrent approve calls send exactly once (AC4)", async () => {
    const item = await propose();
    const results = await Promise.all(Array.from({ length: 10 }, () => approveAndSend(deps(), approveInput(item))));
    expect(sends).toHaveLength(1);
    expect(results.filter((r) => r.kind === "executed")).toHaveLength(1);
    expect((await getOwnItem(database, userId, item.id))!.status).toBe("succeeded");
    expect((await audits("approval.execution_started")).length).toBe(1);
    expect((await audits("approval.approved")).length).toBe(1);
  });

  it("replaying the approve after success sends nothing; approve on executing, succeeded, unknown, rejected or cancelled is a no-op", async () => {
    const item = await propose();
    await approveAndSend(deps(), approveInput(item));
    expect(await approveAndSend(deps(), approveInput(item))).toEqual({ kind: "approval", result: { kind: "stale", status: "succeeded" } });
    expect(sends).toHaveLength(1);

    for (const status of ["executing", "unknown", "rejected", "cancelled"] as const) {
      const other = await propose();
      await database.update(schema.approvalItems).set({ status }).where(eq(schema.approvalItems.id, other.id));
      const r = await approveAndSend(deps(), approveInput(other));
      expect(r, status).toEqual({ kind: "approval", result: { kind: "stale", status } });
    }
    expect(sends).toHaveLength(1);
  });

  it("an item edited after the page loaded can't be approved with the stale revision or hash; editing clears the approval", async () => {
    const item = await propose();
    const edited = await editItem(database, { userId, itemId: item.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Changed", includeQuote: false });
    expect(edited).toEqual({ ok: true, revision: 2 });
    expect(await approveAndSend(deps(), approveInput(item))).toEqual({ kind: "approval", result: { kind: "stale", status: "pending" } });
    const current = (await getOwnItem(database, userId, item.id))!;
    expect(await approveAndSend(deps(), approveInput({ ...current, contentHash: item.contentHash }))).toEqual({ kind: "approval", result: { kind: "stale", status: "pending" } });
    expect(sends).toHaveLength(0);
    // A stale edit is refused too.
    expect(await editItem(database, { userId, itemId: item.id, revision: 1, to: "x@example.org", cc: "", subject: "s", bodyText: "", includeQuote: false })).toEqual({ ok: false, error: "stale" });

    // Fail it, then edit: back to pending, approved_* cleared.
    nextOutcome = () => ({ kind: "failed", code: "gmail_400", status: 400 });
    await approveAndSend(deps(), approveInput(current));
    expect((await getOwnItem(database, userId, item.id))!).toMatchObject({ status: "failed", errorCode: "gmail_400" });
    // Moving to failed bumped the revision (Q8), so the edit uses the revision the page now shows.
    expect((await getOwnItem(database, userId, item.id))!.revision).toBe(3);
    await editItem(database, { userId, itemId: item.id, revision: 3, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Again", includeQuote: false });
    expect((await getOwnItem(database, userId, item.id))!).toMatchObject({
      status: "pending",
      revision: 4,
      approvedRevision: null,
      approvedHash: null,
      approvedPayload: null,
      approvedAt: null,
      messageIdHeader: null,
      errorCode: null,
    });
  });

  it("a definite failure needs a new approval click (Q8), with a new Message-ID", async () => {
    const item = await propose();
    nextOutcome = (n) => (n === 1 ? { kind: "failed", code: "gmail_429", status: 429 } : { kind: "succeeded", gmailMessageId: "ok", gmailThreadId: "gt1" });
    await approveAndSend(deps(), approveInput(item));
    const failed = (await getOwnItem(database, userId, item.id))!;
    expect(failed.status).toBe("failed");
    // Nothing retries it on its own: a reconcile run doesn't touch failed items.
    await reconcileApprovals({ db: database, gmailFor: () => gmail });
    expect(sends).toHaveLength(1);
    await approveAndSend(deps(), approveInput(failed));
    const done = (await getOwnItem(database, userId, item.id))!;
    expect(done.status).toBe("succeeded");
    expect(done.messageIdHeader).not.toBe(failed.messageIdHeader);
    expect(sends).toHaveLength(2);
  });

  // ---- account rules (AC5) -------------------------------------------------------------------

  it("a non-active account blocks approval; a mismatched account or tampered content is refused", async () => {
    const item = await propose();
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, account.id));
    expect(await approveAndSend(deps(), approveInput(item))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "account_inactive" } });
    await database.update(schema.connectedAccounts).set({ status: "active" }).where(eq(schema.connectedAccounts.id, account.id));

    // Forged account (as if a form or a bug had put another account on the item): refused.
    const other = await makeGoogleAccount(database, userId, { email: "personal@example.com" });
    await database.update(schema.approvalItems).set({ accountId: other.id, contentHash: contentHash("email.send", other.id, item.payload) }).where(eq(schema.approvalItems.id, item.id));
    const forged = (await getOwnItem(database, userId, item.id))!;
    expect(await approveAndSend(deps(), approveInput(forged))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "account_mismatch" } });

    // Payload changed without updating the hash: refused.
    await database.update(schema.approvalItems).set({ accountId: account.id, contentHash: item.contentHash, payload: { ...item.payload, bodyText: "tampered" } }).where(eq(schema.approvalItems.id, item.id));
    expect(await approveAndSend(deps(), approveInput(item))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "hash_mismatch" } });
    expect(sends).toHaveLength(0);
  });

  it("ReauthRequiredError gives failed/reauth_required with no fetch", async () => {
    const item = await propose();
    let fetches = 0;
    const reauthSend: Sender = (acc, req) =>
      sendRawMessage(async () => {
        throw new ReauthRequiredError(acc.id, "expired");
      }, req, async () => {
        fetches++;
        return new Response("{}", { status: 200 });
      });
    await approveAndSend(deps({ send: reauthSend }), approveInput(item));
    expect((await getOwnItem(database, userId, item.id))!).toMatchObject({ status: "failed", errorCode: "reauth_required" });
    expect(fetches).toBe(0);
  });

  it("the executor changes and sends nothing for rows that aren't executing with its execution id (AC2)", async () => {
    const item = await propose();
    expect(await executeClaimed(deps(), item.id, "00000000-0000-4000-8000-000000000000")).toBeNull();
    await approveItem(database, approveInput(item));
    expect(await executeClaimed(deps(), item.id, "00000000-0000-4000-8000-000000000000")).toBeNull();
    const claim = (await claimItem(database, userId, item.id))!;
    expect(await claimItem(database, userId, item.id)).toBeNull(); // only one claim
    expect(await executeClaimed(deps(), item.id, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(sends).toHaveLength(0);
    expect((await executeClaimed(deps(), item.id, claim.executionId))!.kind).toBe("succeeded");
    expect(await executeClaimed(deps(), item.id, claim.executionId)).toBeNull(); // already recorded
    expect(sends).toHaveLength(1);
  });

  // ---- outcomes, reconcile, mark not sent (AC6) ----------------------------------------------

  it("unknown is never retried automatically; reconcile marks it succeeded on an rfc822msgid hit", async () => {
    const item = await propose();
    nextOutcome = () => ({ kind: "unknown", code: "gmail_5xx", status: 503 });
    await approveAndSend(deps(), approveInput(item));
    const unknown = (await getOwnItem(database, userId, item.id))!;
    expect(unknown).toMatchObject({ status: "unknown", errorCode: "gmail_5xx" });
    expect(await approveAndSend(deps(), approveInput(unknown))).toEqual({ kind: "approval", result: { kind: "stale", status: "unknown" } });

    const queries: string[] = [];
    const lookup = (hit: boolean): GmailClient => ({
      listMessages: async (req: { q: string }) => {
        queries.push(req.q);
        return hit ? { messages: [{ id: "found1", threadId: "gt1" }] } : {};
      },
      getMessageMinimal: async (id: string) => ({ id, threadId: "gt1", labelIds: ["SENT"] }),
    }) as unknown as GmailClient;
    expect(await reconcileApprovals({ db: database, gmailFor: () => lookup(false) })).toMatchObject({ checked: 1, found: 0 });
    expect((await getOwnItem(database, userId, item.id))!.status).toBe("unknown");
    expect(await reconcileApprovals({ db: database, gmailFor: () => lookup(true) })).toMatchObject({ checked: 1, found: 1 });
    expect(queries).toEqual([`rfc822msgid:${unknown.messageIdHeader}`, `rfc822msgid:${unknown.messageIdHeader}`]);
    expect((await getOwnItem(database, userId, item.id))!).toMatchObject({ status: "succeeded", result: { gmailMessageId: "found1", gmailThreadId: "gt1" } });
    expect(sends).toHaveLength(1);
    expect((await audits("approval.reconciled")).map((a) => a.detail)).toEqual([{ itemId: item.id, outcome: "list_found" }]);
  });

  it("executing older than 10 minutes with no hit becomes unknown; a recent one is left alone", async () => {
    const item = await propose();
    await approveItem(database, approveInput(item));
    await claimItem(database, userId, item.id);
    const none = { listMessages: async () => ({}) } as unknown as GmailClient;
    await reconcileApprovals({ db: database, gmailFor: () => none });
    expect((await getOwnItem(database, userId, item.id))!.status).toBe("executing");
    await database.update(schema.approvalItems).set({ executingSince: new Date(Date.now() - 11 * 60_000) }).where(eq(schema.approvalItems.id, item.id));
    expect(await reconcileApprovals({ db: database, gmailFor: () => none })).toMatchObject({ markedUnknown: 1 });
    expect((await getOwnItem(database, userId, item.id))!).toMatchObject({ status: "unknown", errorCode: "stuck" });
    expect(sends).toHaveLength(0);
  });

  it("markNotSent works only from unknown and only after 30 minutes", async () => {
    const item = await propose();
    expect(await markNotSent(database, userId, item.id, new Date())).toBe(false); // pending
    nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
    await approveAndSend(deps(), approveInput(item));
    expect(await markNotSent(database, userId, item.id, new Date())).toBe(false); // too early
    expect(await markNotSent(database, userId, item.id, new Date(Date.now() + 31 * 60_000))).toBe(true);
    const failed = (await getOwnItem(database, userId, item.id))!;
    expect(failed).toMatchObject({ status: "failed", errorCode: "marked_not_sent" });
    expect(await markNotSent(database, userId, item.id, new Date(Date.now() + 31 * 60_000))).toBe(false);
    expect((await audits("approval.marked_not_sent")).length).toBe(1);
  });

  it("reject (pending only) and cancel (pending or failed)", async () => {
    const a = await propose();
    expect(await rejectItem(database, userId, a.id)).toBe(true);
    expect(await rejectItem(database, userId, a.id)).toBe(false);
    expect(await cancelItem(database, userId, a.id)).toBe(false);
    const b = await propose();
    nextOutcome = () => ({ kind: "failed", code: "gmail_400", status: 400 });
    await approveAndSend(deps(), approveInput(b));
    expect(await rejectItem(database, userId, b.id)).toBe(false);
    expect(await cancelItem(database, userId, b.id)).toBe(true);
    expect((await listItems(database, userId, "done")).map((r) => r.status).sort()).toEqual(["cancelled", "rejected"]);
  });

  // ---- user scoping (AC9) --------------------------------------------------------------------

  it("another user can't see, edit, approve, reject, cancel or mark the item", async () => {
    const item = await propose();
    const other = (await makeUser(database, "other@example.com")).id;
    expect(await getOwnItem(database, other, item.id)).toBeNull();
    expect(await getItemView(database, other, item.id)).toBeNull();
    expect(await listItems(database, other, "pending")).toEqual([]);
    expect(await editItem(database, { userId: other, itemId: item.id, revision: 1, to: "x@example.org", cc: "", subject: "s", bodyText: "", includeQuote: false })).toEqual({ ok: false, error: "not_found" });
    expect(await approveAndSend(deps(), approveInput(item, { userId: other }))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "not_found" } });
    expect(await claimItem(database, other, item.id)).toBeNull();
    expect(await rejectItem(database, other, item.id)).toBe(false);
    expect(await cancelItem(database, other, item.id)).toBe(false);
    expect(await markNotSent(database, other, item.id, new Date(Date.now() + DAY))).toBe(false);
    expect((await getOwnItem(database, userId, item.id))!.status).toBe("pending");
    expect(sends).toHaveLength(0);
  });

  // ---- audit (AC10) --------------------------------------------------------------------------

  it("the audit entry and the state change commit together: if the audit insert fails, the transition is rolled back", async () => {
    const item = await propose();
    await database.execute(sql`alter table audit_log add constraint test_no_reject check (action <> 'approval.rejected')`);
    try {
      await expect(rejectItem(database, userId, item.id)).rejects.toThrow();
    } finally {
      await database.execute(sql`alter table audit_log drop constraint test_no_reject`);
    }
    expect((await getOwnItem(database, userId, item.id))!.status).toBe("pending");
    // And the other way round: rolling back the surrounding transaction leaves neither.
    await database
      .transaction(async (tx) => {
        await cancelItem(tx as unknown as Database, userId, item.id);
        throw new Error("rollback");
      })
      .catch(() => undefined);
    expect((await getOwnItem(database, userId, item.id))!.status).toBe("pending");
    expect((await audits()).map((a) => a.action)).toEqual(["approval.proposed"]);
  });

  it("no approval audit detail contains an address, the subject or the body", async () => {
    const subject = "Re: Lunch secret-subject-marker";
    const a = await propose({ subject, bodyText: "secret-body-marker", cc: "bob@example.net" });
    await editItem(database, { userId, itemId: a.id, revision: 1, to: "alice@example.org", cc: "", subject, bodyText: "secret-body-marker 2", includeQuote: true });
    const a2 = (await getOwnItem(database, userId, a.id))!;
    nextOutcome = () => ({ kind: "unknown", code: "network", status: null });
    await approveAndSend(deps(), approveInput(a2));
    await markNotSent(database, userId, a.id, new Date(Date.now() + DAY));
    nextOutcome = () => ({ kind: "failed", code: "gmail_403", status: 403 });
    await approveAndSend(deps(), approveInput((await getOwnItem(database, userId, a.id))!));
    await cancelItem(database, userId, a.id);
    const b = await propose({ subject, bodyText: "secret-body-marker" });
    nextOutcome = (n) => ({ kind: "succeeded", gmailMessageId: `m${n}`, gmailThreadId: "gt1" });
    await approveAndSend(deps(), approveInput(b));
    const c = await propose({ subject });
    await rejectItem(database, userId, c.id);
    const all = await audits();
    expect(new Set(all.map((x) => x.action))).toEqual(
      new Set([
        "approval.proposed",
        "approval.edited",
        "approval.approved",
        "approval.execution_started",
        "approval.execution_unknown",
        "approval.marked_not_sent",
        "approval.execution_failed",
        "approval.cancelled",
        "approval.executed",
        "approval.rejected",
      ]),
    );
    for (const entry of all) {
      const json = JSON.stringify(entry.detail);
      expect(json, entry.action).not.toContain("@");
      expect(json).not.toContain("secret");
      expect(json).not.toContain("Lunch");
      expect(entry.accountId).toBe(account.id);
    }
  });

  // ---- 2a integration (Q6, §5.4, AC12) ---------------------------------------------------------

  it("a new message in the thread sets the warning; approval then needs the one-time confirmation", async () => {
    const item = await propose();
    clock += 60_000;
    gmail.deliver(msg({ id: "p2", internalDate: clock, messageIdHeader: "<p2@mail.example.org>" }));
    await syncAccount(syncDeps(), await reload(), "cron");
    const flagged = (await getOwnItem(database, userId, item.id))!;
    expect(flagged.threadChangedAt).not.toBeNull();
    expect(flagged.payload).toEqual(item.payload); // unchanged
    expect(await approveAndSend(deps(), approveInput(flagged))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
    expect(sends).toHaveLength(0);
    expect((await approveAndSend(deps(), approveInput(flagged, { ackThreadChange: true }))).kind).toBe("executed");
    expect(sends).toHaveLength(1);
  });

  it("the sent reply is ingested into the thread through history, without raising the warning on other items (AC12)", async () => {
    const item = await propose();
    const waiting = await propose({ bodyText: "a second draft" });
    await approveAndSend(deps(), approveInput(item));
    const sent = (await getOwnItem(database, userId, item.id))!;
    clock += 60_000;
    gmail.deliver(msg({ id: "sent1", labelIds: ["SENT"], internalDate: clock, from: "work@example.com", messageIdHeader: sent.messageIdHeader!, subject: "Re: Lunch" }));
    await syncAccount(syncDeps(), await reload(), "cron");
    const [stored] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "sent1"));
    expect(stored).toMatchObject({ threadId, isSent: true, rfc822MessageId: sent.messageIdHeader });
    expect((await getOwnItem(database, userId, waiting.id))!.threadChangedAt).toBeNull();
  });

  it("an unknown send that 2a ingests becomes succeeded (ingest match)", async () => {
    const item = await propose();
    nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
    await approveAndSend(deps(), approveInput(item));
    const unknown = (await getOwnItem(database, userId, item.id))!;
    expect(unknown.status).toBe("unknown");
    clock += 60_000;
    gmail.deliver(msg({ id: "late1", labelIds: ["SENT"], internalDate: clock, from: "work@example.com", messageIdHeader: unknown.messageIdHeader! }));
    await syncAccount(syncDeps(), await reload(), "cron");
    expect((await getOwnItem(database, userId, item.id))!).toMatchObject({ status: "succeeded", result: { gmailMessageId: "late1", gmailThreadId: "gt1" } });
    expect((await audits("approval.reconciled")).map((a) => a.detail)).toEqual([{ itemId: item.id, outcome: "ingest_match" }]);
    expect(sends).toHaveLength(1);
  });

  // ---- review round 1 fixes -------------------------------------------------------------------

  it("D1: a message Gmail received before the reply was saved, but synced after, still raises the warning; an older one doesn't", async () => {
    // Received 1 minute ago (after the parent, a day old), not yet synced when the reply is saved.
    gmail.deliver(msg({ id: "lag1", internalDate: Date.now() - 60_000, messageIdHeader: "<lag1@mail.example.org>" }));
    const item = await propose();
    clock = Date.now();
    await syncAccount(syncDeps(), await reload(), "cron");
    expect((await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "lag1"))).length).toBe(1);
    expect((await getOwnItem(database, userId, item.id))!.threadChangedAt).not.toBeNull();

    // A message older than the parent (say, a late backfill) doesn't raise it.
    const other = await propose();
    gmail.deliver(msg({ id: "old1", internalDate: clock - 3 * DAY, messageIdHeader: "<old1@mail.example.org>" }));
    await syncAccount(syncDeps(), await reload(), "cron");
    expect((await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "old1"))).length).toBe(1);
    expect((await getOwnItem(database, userId, other.id))!.threadChangedAt).toBeNull();
  });

  it("D2: an emoji at the quote cap can be saved; with the toggle off no quote is computed or stored; lone surrogates become U+FFFD", async () => {
    const emoji = String.fromCodePoint(0x1f35c);
    // Every cut position across the emoji: none fails.
    for (const k of [19_940, 19_950, 19_955, 19_960, 19_965, 19_970]) {
      await database.update(schema.mailMessages).set({ bodyText: "a".repeat(k) + emoji + " tail" }).where(eq(schema.mailMessages.id, parentId));
      const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "x", includeQuote: true });
      expect(r.ok, String(k)).toBe(true);
      const p = emailSendPayload.parse((await getOwnItem(database, userId, (r as { itemId: string }).itemId))!.payload);
      expect(p.quote!.text.length).toBeLessThanOrEqual(20_000);
      expect(p.quote!.text.isWellFormed()).toBe(true);
    }
    const off = await propose({ includeQuote: false });
    expect(emailSendPayload.parse(off.payload).quote).toBeNull();
    // Turning the quote on in an edit computes it then.
    await editItem(database, { userId, itemId: off.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "x", includeQuote: true });
    expect(emailSendPayload.parse((await getOwnItem(database, userId, off.id))!.payload).quote?.included).toBe(true);
    const lone = String.fromCharCode(0xd83c);
    const s = await propose({ subject: `Re: a${lone}`, bodyText: `b${lone}` });
    const sp = emailSendPayload.parse(s.payload);
    expect(sp.subject).toBe(`Re: a${String.fromCharCode(0xfffd)}`);
    expect(sp.bodyText).toBe(`b${String.fromCharCode(0xfffd)}`);
  });

  it("D3: a reconcile hit counts only if it carries SENT (in the item's own account mailbox)", async () => {
    const item = await propose();
    nextOutcome = () => ({ kind: "unknown", code: "gmail_5xx", status: 500 });
    await approveAndSend(deps(), approveInput(item));
    const header = (await getOwnItem(database, userId, item.id))!.messageIdHeader!;
    const labels = { current: ["INBOX"] };
    const gets: string[] = [];
    const lookup = {
      listMessages: async () => ({ messages: [{ id: "hit1", threadId: "gt1" }] }),
      getMessageMinimal: async (id: string) => (gets.push(id), { id, threadId: "gt1", labelIds: labels.current }),
    } as unknown as GmailClient;
    const accountsAsked: string[] = [];
    const gmailFor = (acc: ConnectedAccount) => (accountsAsked.push(acc.id), lookup);
    await reconcileApprovals({ db: database, gmailFor });
    expect((await getOwnItem(database, userId, item.id))!.status).toBe("unknown");
    labels.current = ["SENT"];
    await reconcileApprovals({ db: database, gmailFor });
    expect((await getOwnItem(database, userId, item.id))!).toMatchObject({ status: "succeeded", result: { gmailMessageId: "hit1" } });
    expect(gets).toEqual(["hit1", "hit1"]);
    expect(new Set(accountsAsked)).toEqual(new Set([account.id]));
    expect(header).toMatch(/^<alex\./);
  });

  it("D4: NUL or other controls in body, subject or recipients are validation errors, not database errors", async () => {
    const nul = String.fromCharCode(0);
    const base = { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "ok", includeQuote: false };
    expect(await proposeReply(database, { ...base, bodyText: `a${nul}b` })).toEqual({ ok: false, error: "invalid_body" });
    expect(await proposeReply(database, { ...base, bodyText: `a${String.fromCharCode(0x1b)}b` })).toEqual({ ok: false, error: "invalid_body" });
    expect(await proposeReply(database, { ...base, subject: `Re: a${nul}` })).toEqual({ ok: false, error: "invalid_subject" });
    expect(await proposeReply(database, { ...base, to: `alice${nul}@example.org` })).toEqual({ ok: false, error: "invalid_recipients" });
    expect(await proposeReply(database, { ...base, cc: `bob@example.org${nul}` })).toEqual({ ok: false, error: "invalid_recipients" });
    expect((await proposeReply(database, { ...base, bodyText: "tab\tand\r\nnewline" })).ok).toBe(true);
    const item = await propose();
    expect(await editItem(database, { userId, itemId: item.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: `x${nul}`, includeQuote: false })).toEqual({ ok: false, error: "invalid_body" });
  });

  it("Q8: after a definite failure, a resubmitted old approve POST is stale and sends nothing; a fresh page's approve sends", async () => {
    const item = await propose();
    nextOutcome = (n) => (n === 1 ? { kind: "failed", code: "gmail_400", status: 400 } : { kind: "succeeded", gmailMessageId: `s${n}`, gmailThreadId: "gt1" });
    await approveAndSend(deps(), approveInput(item));
    const failed = (await getOwnItem(database, userId, item.id))!;
    expect(failed).toMatchObject({ status: "failed", revision: 2 });
    for (let i = 0; i < 3; i++) {
      expect(await approveAndSend(deps(), approveInput(item))).toEqual({ kind: "approval", result: { kind: "stale", status: "failed" } });
    }
    expect(sends).toHaveLength(1);
    expect((await approveAndSend(deps(), approveInput(failed))).kind).toBe("executed");
    expect(sends).toHaveLength(2);

    // The same after "Mark as not sent".
    const u = await propose();
    nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
    await approveAndSend(deps(), approveInput(u));
    expect(await markNotSent(database, userId, u.id, new Date(Date.now() + 31 * 60_000))).toBe(true);
    expect((await getOwnItem(database, userId, u.id))!.revision).toBe(2);
    expect(await approveAndSend(deps(), approveInput(u))).toEqual({ kind: "approval", result: { kind: "stale", status: "failed" } });
    expect(sends).toHaveLength(3);
  });

  it("D5: the Q6 baseline is the parent's internalDate copied at propose time; an edit keeps it, and it still works after the parent row is deleted", async () => {
    const [parent] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.id, parentId));
    const item = await propose();
    expect(item.parentInternalDate?.getTime()).toBe(parent!.internalDate.getTime());
    await editItem(database, { userId, itemId: item.id, revision: 1, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "edited", includeQuote: false });
    const edited = (await getOwnItem(database, userId, item.id))!;
    expect(edited.parentInternalDate?.getTime()).toBe(parent!.internalDate.getTime());

    // The parent row disappears (parent_message_id SET NULL); then a message that Gmail received
    // before the reply was saved, but after the parent, is synced: still flagged.
    await database.delete(schema.mailMessages).where(eq(schema.mailMessages.id, parentId));
    const gone = (await getOwnItem(database, userId, item.id))!;
    expect(gone.parentMessageId).toBeNull();
    expect(gone.threadId).toBe(threadId);
    expect(gone.threadChangedAt).toBeNull();
    gmail.deliver(msg({ id: "lagD5", internalDate: edited.createdAt.getTime() - 60_000, messageIdHeader: "<lagD5@mail.example.org>" }));
    clock = Date.now();
    await syncAccount(syncDeps(), await reload(), "cron");
    expect((await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "lagD5"))).length).toBe(1);
    expect((await getOwnItem(database, userId, item.id))!.threadChangedAt).not.toBeNull();
  });

  // ---- review B1: the Q6 acknowledgement is bound to the rendered thread_changed_at -------------

  it("B1: a tick given against an older warning doesn't send after a second message arrives; a fresh render does", async () => {
    const item = await propose();
    clock = Date.now() + 60_000;
    gmail.deliver(msg({ id: "a1", internalDate: Date.now() + 1_000, messageIdHeader: "<a1@mail.example.org>" }));
    await syncAccount(syncDeps(), await reload(), "cron");
    const rendered = (await getOwnItem(database, userId, item.id))!; // the page the owner looked at
    expect(rendered.threadChangedAt).not.toBeNull();
    await sleep(5);
    clock += 60_000;
    gmail.deliver(msg({ id: "b1", internalDate: Date.now() + 2_000, messageIdHeader: "<b1@mail.example.org>" }));
    await syncAccount(syncDeps(), await reload(), "cron");
    expect((await getOwnItem(database, userId, item.id))!.threadChangedAt!.getTime()).not.toBe(rendered.threadChangedAt!.getTime());
    // The tick on the old page: not sent.
    expect(await approveAndSend(deps(), approveInput(rendered, { ackThreadChange: true }))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
    expect(sends).toHaveLength(0);
    expect((await getOwnItem(database, userId, item.id))!.status).toBe("pending");
    // A fresh render without the tick: still refused; with it: sent.
    const fresh = (await getOwnItem(database, userId, item.id))!;
    expect(await approveAndSend(deps(), approveInput(fresh))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
    expect((await approveAndSend(deps(), approveInput(fresh, { ackThreadChange: true }))).kind).toBe("executed");
    expect(sends).toHaveLength(1);
  });

  it("B1: a page rendered with no warning (null) can't approve once a message has landed; null vs null approves", async () => {
    const item = await propose();
    const rendered = (await getOwnItem(database, userId, item.id))!;
    expect(rendered.threadChangedAt).toBeNull();
    clock = Date.now() + 60_000;
    gmail.deliver(msg({ id: "c1", internalDate: Date.now() + 1_000, messageIdHeader: "<c1@mail.example.org>" }));
    await syncAccount(syncDeps(), await reload(), "cron");
    for (const ack of [false, true]) {
      expect(await approveAndSend(deps(), approveInput(rendered, { ackThreadChange: ack }))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
    }
    // Omitting the rendered value counts as "no warning shown".
    expect(await approveAndSend(deps(), { ...approveInput(rendered, { ackThreadChange: true }), shownThreadChangedAt: undefined })).toEqual({
      kind: "approval",
      result: { kind: "blocked", reason: "ack_required" },
    });
    expect(sends).toHaveLength(0);

    // null rendered, null stored: approves and sends (no tick needed).
    const plain = await propose();
    expect(plain.threadChangedAt).toBeNull();
    expect((await approveAndSend(deps(), approveInput(plain))).kind).toBe("executed");
    expect(sends).toHaveLength(1);
  });

  it("B1: a message landing between the check and the UPDATE makes the conditional UPDATE miss: ack_required, nothing sent", async () => {
    const item = await propose();
    const racing = new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (fn: Parameters<Database["transaction"]>[0]) => {
            await database.update(schema.approvalItems).set({ threadChangedAt: new Date() }).where(eq(schema.approvalItems.id, item.id));
            return target.transaction(fn);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(await approveItem(racing, approveInput(item))).toEqual({ kind: "blocked", reason: "ack_required" });
    const after = (await getOwnItem(database, userId, item.id))!;
    expect(after).toMatchObject({ status: "pending", approvedHash: null, messageIdHeader: null });
    expect((await audits("approval.approved")).length).toBe(0);
    expect(sends).toHaveLength(0);
  });

  // ---- security review S1 and N1 -------------------------------------------------------------

  it("S1: an inbound (non-SENT) message reusing one of our Message-IDs still flags pending items, and doesn't resolve the send", async () => {
    const sentItem = await propose();
    nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
    await approveAndSend(deps(), approveInput(sentItem));
    const header = (await getOwnItem(database, userId, sentItem.id))!.messageIdHeader!;
    const waiting = await propose({ bodyText: "another draft" });
    clock = Date.now() + 60_000;
    gmail.deliver(msg({ id: "reuse1", labelIds: ["INBOX"], internalDate: Date.now() + 1_000, messageIdHeader: header }));
    await syncAccount(syncDeps(), await reload(), "cron");
    expect((await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "reuse1"))).length).toBe(1);
    expect((await getOwnItem(database, userId, waiting.id))!.threadChangedAt).not.toBeNull();
    expect((await getOwnItem(database, userId, sentItem.id))!.status).toBe("unknown");
  });

  it("S1: the genuine SENT copy in the same account resolves the send and doesn't flag pending items", async () => {
    const sentItem = await propose();
    nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
    await approveAndSend(deps(), approveInput(sentItem));
    const header = (await getOwnItem(database, userId, sentItem.id))!.messageIdHeader!;
    const waiting = await propose({ bodyText: "another draft" });
    clock = Date.now() + 60_000;
    gmail.deliver(msg({ id: "real1", labelIds: ["SENT"], from: "work@example.com", internalDate: Date.now() + 1_000, messageIdHeader: header }));
    await syncAccount(syncDeps(), await reload(), "cron");
    expect((await getOwnItem(database, userId, sentItem.id))!.status).toBe("succeeded");
    expect((await getOwnItem(database, userId, waiting.id))!.threadChangedAt).toBeNull();
  });

  it("S1: a SENT copy in a different account carrying our Message-ID isn't treated as ours: no resolve, and it flags that account's pending items", async () => {
    const sentItem = await propose();
    nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
    await approveAndSend(deps(), approveInput(sentItem));
    const header = (await getOwnItem(database, userId, sentItem.id))!.messageIdHeader!;

    // A second account with its own thread and a pending reply in it.
    const saveGmail = gmail;
    const saveAccount = account;
    account = await makeGoogleAccount(database, userId, { email: "personal@example.com" });
    gmail = new FakeGmail();
    gmail.seed(msg({ id: "q1", threadId: "gtB", messageIdHeader: "<q1@mail.example.org>" }));
    await runUntilEmpty();
    const [threadB] = await database.select().from(schema.mailThreads).where(eq(schema.mailThreads.accountId, account.id));
    const [parentB] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "q1"));
    const otherItem = await propose({ threadId: threadB!.id, parentMessageId: parentB!.id });
    expect(otherItem.accountId).toBe(account.id);
    clock = Date.now() + 60_000;
    gmail.deliver(msg({ id: "copyB", threadId: "gtB", labelIds: ["SENT"], from: "personal@example.com", internalDate: Date.now() + 1_000, messageIdHeader: header }));
    await syncAccount(syncDeps(), await reload(), "cron");
    expect((await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "copyB"))).length).toBe(1);
    gmail = saveGmail;
    account = saveAccount;

    expect((await getOwnItem(database, userId, sentItem.id))!.status).toBe("unknown");
    expect((await getOwnItem(database, userId, otherItem.id))!.threadChangedAt).not.toBeNull();
    expect((await audits("approval.reconciled")).length).toBe(0);
  });

  it("N1: markReconciledSent can't change another user's item", async () => {
    const item = await propose();
    nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
    await approveAndSend(deps(), approveInput(item));
    const other = (await makeUser(database, "other@example.com")).id;
    const found = { gmailMessageId: "x1", gmailThreadId: "gt1" };
    expect(await markReconciledSent(database, { id: item.id, userId: other, accountId: account.id }, found, "list_found")).toBe(false);
    expect((await getOwnItem(database, userId, item.id))!).toMatchObject({ status: "unknown", result: null });
    expect((await audits("approval.reconciled")).length).toBe(0);
    // The owner's own call still works.
    expect(await markReconciledSent(database, { id: item.id, userId, accountId: account.id }, found, "list_found")).toBe(true);
    expect((await getOwnItem(database, userId, item.id))!.status).toBe("succeeded");
  });

  it("migration 0002 (after 0001): enums, the check constraint, FKs and indexes (AC1)", async () => {
    const enums = await database.execute(sql`select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typname like 'approval_%' group by t.typname order by t.typname`);
    expect(enums.map((r) => [r.typname, r.labels])).toEqual([
      ["approval_kind", ["email.send"]],
      ["approval_source", ["owner"]],
      ["approval_status", ["pending", "approved", "executing", "succeeded", "failed", "unknown", "rejected", "cancelled"]],
    ]);
    const indexes = await database.execute(sql`select indexname from pg_indexes where tablename = 'approval_items' order by indexname`);
    expect(indexes.map((r) => r.indexname)).toEqual([
      "approval_items_account_message_id_idx",
      "approval_items_pkey",
      "approval_items_status_executing_idx",
      "approval_items_thread_idx",
      "approval_items_user_status_created_idx",
    ]);
    const fks = await database.execute(
      sql`select conname, confdeltype from pg_constraint where conrelid = 'approval_items'::regclass and contype = 'f' order by conname`,
    );
    expect(fks.map((r) => [r.conname, r.confdeltype])).toEqual([
      ["approval_items_account_id_connected_accounts_id_fk", "c"],
      ["approval_items_parent_message_id_mail_messages_id_fk", "n"],
      ["approval_items_thread_id_mail_threads_id_fk", "n"],
      ["approval_items_user_id_users_id_fk", "c"],
    ]);
    // email.send needs an account.
    await expect(
      database.insert(schema.approvalItems).values({ userId, kind: "email.send", source: "owner", payload: {}, contentHash: "x" }),
    ).rejects.toThrow();
    // Disconnecting the account deletes its items (cascade).
    await propose();
    await database.delete(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id));
    expect(await database.select().from(schema.approvalItems)).toEqual([]);
  });

  it("the parent message context and the stored rendering columns are available to the detail page", async () => {
    const item = await propose();
    const view = (await getItemView(database, userId, item.id))!;
    expect(view.account).toMatchObject({ email: "work@example.com", label: "business", status: "active" });
    expect(view.thread).toMatchObject({ id: threadId, messageCount: 1 });
    expect(view.parent).toMatchObject({ id: parentId, fromHeader: "Alice <alice@example.org>" });
    expect(view.shown).toEqual(view.payload);
  });
});
