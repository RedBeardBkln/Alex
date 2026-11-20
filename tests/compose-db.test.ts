import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { approveAndSend, executeClaimed, type ExecutorDeps, type Sender } from "@/lib/approvals/execute";
import { emailSendPayload } from "@/lib/approvals/payload";
import { reconcileApprovals } from "@/lib/approvals/reconcile";
import {
  approveItem,
  claimItem,
  editItem,
  getItemView,
  getOwnItem,
  proposeNewMessage,
  proposeReply,
  type NewMessageInput,
} from "@/lib/approvals/service";
import { seenAddresses } from "@/lib/approvals/seen";
import type { SendOutcome } from "@/lib/gmail/send";
import { deferQueueRow, dropQueueRow, dueQueueRows, enqueueMessages, enqueueOutbound, failQueueRow, getSyncState, knownThreadIds, PARKED_AT } from "@/lib/gmail/store";
import { deleteAccount } from "@/lib/accounts";
import { syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { FakeGmail } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Phase 2d (compose) with Postgres and a fake Gmail sender: propose (plan §6.2), account checks at
// approve and execute (AC3), the per-recipient confirmation (Q2), the daily first-time-recipient
// cap (Q3 as amended) and "seen" (Q4), execution through the unchanged 2b path (AC4), outbound
// ingestion of the SENT copy (AC9), edit (AC10) and the content-free audit (AC11). No live Google.

const HOST = "alex.example.com";
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The Postgres error behind a drizzle query error (drizzle wraps it as cause). */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause;
    return String(cause?.message ?? (err as Error).message);
  }
  return "no error";
}

describe.skipIf(!testDbUrl)("compose new messages (Postgres + fake Gmail)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let accountA: ConnectedAccount;
  let accountB: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  let sends: { accountId: string; raw: string; threadId: string | null }[];
  let nextOutcome: (n: number) => SendOutcome;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });

  const send: Sender = async (acc, req) => {
    sends.push({ accountId: acc.id, raw: req.raw, threadId: req.threadId });
    await sleep(10);
    return nextOutcome(sends.length);
  };
  const deps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({ db: database, send, ...over });
  const audits = async (prefix = "approval.") =>
    (await database.select().from(schema.auditLog).orderBy(asc(schema.auditLog.createdAt))).filter((a) => a.action.startsWith(prefix));
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
  const reloadA = async () => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, accountA.id)))[0]!;
  async function syncA() {
    for (let i = 0; i < 10; i++) {
      await syncAccount(syncDeps(), await reloadA(), "cron");
      const q = await database.select().from(schema.mailFetchQueue).where(eq(schema.mailFetchQueue.accountId, accountA.id));
      if ((await getSyncState(database, accountA.id))?.backfillStatus === "complete" && q.length === 0) return;
      clock += 5 * 60_000;
    }
  }

  async function compose(over: Partial<NewMessageInput> = {}) {
    const r = await proposeNewMessage(database, { userId, accountId: accountA.id, to: "bob@example.org", cc: "", subject: "Hello", bodyText: "Hi Bob", ...over });
    if (!r.ok) throw new Error(r.error);
    return (await getOwnItem(database, userId, r.itemId))!;
  }
  const allRecipients = (item: schema.ApprovalItem) => {
    const p = emailSendPayload.parse(item.payload);
    return [...p.to, ...p.cc];
  };
  const approveInput = (item: schema.ApprovalItem, over: Partial<Parameters<typeof approveItem>[1]> = {}): Parameters<typeof approveItem>[1] => ({
    userId,
    itemId: item.id,
    revision: item.revision,
    contentHash: item.contentHash,
    ackThreadChange: false,
    shownThreadChangedAt: item.threadChangedAt ? item.threadChangedAt.getTime() : null,
    messageIdHost: HOST,
    confirmedRecipients: allRecipients(item),
    newRecipientLimit: 10,
    ...over,
  });

  /** A stored thread in account A with one inbound message (direct inserts). */
  async function storedThread(opts: { gmailThreadId?: string; from?: string; to?: string; cc?: string | null; replyTo?: string | null; labels?: string[]; isSent?: boolean } = {}) {
    const gt = opts.gmailThreadId ?? `gt-${Math.random().toString(36).slice(2)}`;
    const [thread] = await database
      .insert(schema.mailThreads)
      .values({ userId, accountId: accountA.id, gmailThreadId: gt, subject: "Lunch", lastMessageAt: new Date(clock - DAY), messageCount: 1, inInbox: true, hasUnread: false })
      .returning();
    const [m] = await database
      .insert(schema.mailMessages)
      .values({
        userId,
        accountId: accountA.id,
        threadId: thread!.id,
        gmailMessageId: `m-${gt}`,
        gmailThreadId: gt,
        internalDate: new Date(clock - DAY),
        labelIds: opts.labels ?? ["INBOX"],
        isSent: opts.isSent ?? false,
        subject: "Lunch",
        fromHeader: opts.from ?? "Alice <alice@example.org>",
        toHeader: opts.to ?? "work@example.com",
        ccHeader: opts.cc ?? null,
        replyToHeader: opts.replyTo ?? null,
        rfc822MessageId: `<m-${gt}@mail.example.org>`,
        headers: [],
        bodyText: "Hello",
      })
      .returning();
    return { thread: thread!, message: m! };
  }

  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    accountA = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    accountB = await makeGoogleAccount(database, userId, { email: "home@example.com", label: "personal" });
    gmail = new FakeGmail();
    clock = Date.now();
    sends = [];
    nextOutcome = (n) => ({ kind: "succeeded", gmailMessageId: `sent${n}`, gmailThreadId: `newthread${n}` });
  });

  // ---- propose (plan §6.2, AC3, AC4) ---------------------------------------------------------

  it("propose: pending, no thread, no parent, threading and quote null, audited with counts and variant only, nothing sent", async () => {
    const item = await compose({ to: "bob@example.org\nAmy@example.net", cc: "carl@example.net", bodyText: "Hi\r\nthere" });
    expect(item).toMatchObject({ status: "pending", kind: "email.send", source: "owner", accountId: accountA.id, threadId: null, parentMessageId: null, parentInternalDate: null, threadChangedAt: null, newRecipientCount: null, revision: 1 });
    expect(emailSendPayload.parse(item.payload)).toEqual({ to: ["bob@example.org", "Amy@example.net"], cc: ["carl@example.net"], subject: "Hello", bodyText: "Hi\nthere", quote: null, threading: null, replyToNotice: false });
    expect((await audits()).map((a) => [a.action, a.detail])).toEqual([["approval.proposed", { itemId: item.id, kind: "email.send", source: "owner", recipients: 3, variant: "new" }]]);
    expect(sends).toEqual([]);
  });

  it("propose refuses another user's account, a missing account, a non-Google account and an inactive account; no row, no audit", async () => {
    const other = (await makeUser(database, "other@example.com")).id;
    const otherAcc = await makeGoogleAccount(database, other, { email: "intruder@example.com" });
    const [slack] = await database
      .insert(schema.connectedAccounts)
      .values({ userId, provider: "slack", providerAccountId: "S1", email: "slack@example.com" })
      .returning();
    const base = { userId, to: "bob@example.org", cc: "", subject: "Hello", bodyText: "Hi" };
    expect(await proposeNewMessage(database, { ...base, accountId: otherAcc.id })).toEqual({ ok: false, error: "not_found" });
    expect(await proposeNewMessage(database, { ...base, accountId: "00000000-0000-4000-8000-000000000000" })).toEqual({ ok: false, error: "not_found" });
    expect(await proposeNewMessage(database, { ...base, accountId: slack!.id })).toEqual({ ok: false, error: "account_not_google" });
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, accountB.id));
    expect(await proposeNewMessage(database, { ...base, accountId: accountB.id })).toEqual({ ok: false, error: "account_inactive" });
    // Validation failures (form bypass) are refused too.
    expect(await proposeNewMessage(database, { ...base, accountId: accountA.id, subject: "x\r\nBcc: evil@example.net" })).toEqual({ ok: false, error: "invalid_subject" });
    expect(await proposeNewMessage(database, { ...base, accountId: accountA.id, to: "bob@example.org\r\nBcc: evil@example.net" })).toMatchObject({ ok: false, error: "invalid_recipients" });
    expect(await proposeNewMessage(database, { ...base, accountId: accountA.id, bodyText: "   " })).toEqual({ ok: false, error: "empty_body" });
    expect(await database.select().from(schema.approvalItems)).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  // ---- account checks at approve and execute (AC3) --------------------------------------------

  it("an account flipped to reauth_required after propose blocks approve; reassigned to another user it is account_mismatch", async () => {
    const item = await compose();
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, accountA.id));
    expect(await approveAndSend(deps(), approveInput(item))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "account_inactive" } });
    await database.update(schema.connectedAccounts).set({ status: "active" }).where(eq(schema.connectedAccounts.id, accountA.id));
    const other = (await makeUser(database, "other@example.com")).id;
    await database.update(schema.connectedAccounts).set({ userId: other }).where(eq(schema.connectedAccounts.id, accountA.id));
    expect(await approveAndSend(deps(), approveInput(item))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "account_mismatch" } });
    expect(sends).toHaveLength(0);
  });

  it("the check constraint refuses a new-message row linked to a thread; with it bypassed, approve and the executor refuse it", async () => {
    const item = await compose();
    const { thread, message } = await storedThread();
    expect(await pgError(database.update(schema.approvalItems).set({ threadId: thread.id }).where(eq(schema.approvalItems.id, item.id)))).toMatch(/violates check constraint "approval_items_new_message_shape_chk"/);
    expect(await pgError(database.update(schema.approvalItems).set({ parentMessageId: message.id }).where(eq(schema.approvalItems.id, item.id)))).toMatch(/violates check constraint "approval_items_new_message_shape_chk"/);
    // A reply row is unaffected by the constraint (threading is an object).
    const reply = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: message.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
    expect(reply.ok).toBe(true);

    // Defence in depth: drop the constraint and tamper.
    await database.execute(sql`alter table approval_items drop constraint approval_items_new_message_shape_chk`);
    try {
      await database.update(schema.approvalItems).set({ threadId: thread.id }).where(eq(schema.approvalItems.id, item.id));
      expect(await approveAndSend(deps(), approveInput(item))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "account_mismatch" } });
      // Approved while clean, then linked to a thread before the claim: the executor refuses.
      await database.update(schema.approvalItems).set({ threadId: null }).where(eq(schema.approvalItems.id, item.id));
      expect((await approveItem(database, approveInput(item))).kind).toBe("approved");
      await database.update(schema.approvalItems).set({ parentMessageId: message.id }).where(eq(schema.approvalItems.id, item.id));
      const claim = (await claimItem(database, userId, item.id))!;
      expect(await executeClaimed(deps(), item.id, claim.executionId)).toEqual({ kind: "failed", code: "stale_account", status: null });
      expect(sends).toHaveLength(0);
    } finally {
      await database.update(schema.approvalItems).set({ threadId: null, parentMessageId: null }).where(eq(schema.approvalItems.id, item.id));
      await database.execute(
        sql`alter table approval_items add constraint approval_items_new_message_shape_chk check (kind <> 'email.send' OR payload->'threading' <> 'null'::jsonb OR (thread_id IS NULL AND parent_message_id IS NULL))`,
      );
    }
  });

  it("regression: a reply whose thread was deleted is still refused (it is not a new message)", async () => {
    const { thread, message } = await storedThread();
    const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: message.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
    const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    await database.delete(schema.mailThreads).where(eq(schema.mailThreads.id, thread.id));
    const orphan = (await getOwnItem(database, userId, item.id))!;
    expect(orphan).toMatchObject({ threadId: null, parentMessageId: null });
    expect(await approveAndSend(deps(), approveInput(orphan))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "account_mismatch" } });
    expect(sends).toHaveLength(0);
  });

  // ---- confirmation (Q2) ----------------------------------------------------------------------

  it("approve needs exactly the to ∪ cc set ticked; anything else is blocked and the item stays pending", async () => {
    const item = await compose({ to: "bob@example.org", cc: "amy@example.net" });
    for (const confirmed of [[], ["bob@example.org"], ["bob@example.org", "amy@example.net", "carl@example.net"], ["bob@example.org", "bob@example.org"]]) {
      expect(await approveAndSend(deps(), approveInput(item, { confirmedRecipients: confirmed })), JSON.stringify(confirmed)).toEqual({
        kind: "approval",
        result: { kind: "blocked", reason: "recipients_unconfirmed" },
      });
    }
    expect(await approveAndSend(deps(), approveInput(item, { confirmedRecipients: undefined }))).toMatchObject({ result: { reason: "recipients_unconfirmed" } });
    expect((await getOwnItem(database, userId, item.id))!.status).toBe("pending");
    expect(await audits("approval.approved")).toEqual([]);
    expect(sends).toHaveLength(0);
    const ok = await approveAndSend(deps(), approveInput(item, { confirmedRecipients: ["AMY@example.net", "Bob@Example.org"] }));
    expect(ok).toMatchObject({ kind: "executed", outcome: { kind: "succeeded" } });
    const approved = (await audits("approval.approved"))[0]!;
    expect(approved.detail).toEqual({ itemId: item.id, revision: 1, contentHash: item.contentHash, confirmedRecipients: 2, newRecipients: 2 });
  });

  it("an edit after a failed send clears the approval and new_recipient_count, keeps the account, and needs re-confirming", async () => {
    nextOutcome = () => ({ kind: "failed", code: "gmail_400", status: 400 });
    const item = await compose();
    await approveAndSend(deps(), approveInput(item));
    const failed = (await getOwnItem(database, userId, item.id))!;
    expect(failed).toMatchObject({ status: "failed", newRecipientCount: 1 });
    expect(await editItem(database, { userId, itemId: item.id, revision: failed.revision, to: "bob@example.org\ncarl@example.net", cc: "", subject: "", bodyText: "x", includeQuote: true })).toEqual({ ok: false, error: "empty_subject" });
    expect(await editItem(database, { userId, itemId: item.id, revision: failed.revision, to: "bob@example.org\ncarl@example.net", cc: "", subject: "Hello again", bodyText: "x", includeQuote: true })).toEqual({ ok: true, revision: failed.revision + 1 });
    const edited = (await getOwnItem(database, userId, item.id))!;
    expect(edited).toMatchObject({ status: "pending", accountId: accountA.id, threadId: null, approvedPayload: null, approvedHash: null, newRecipientCount: null });
    expect(emailSendPayload.parse(edited.payload)).toMatchObject({ to: ["bob@example.org", "carl@example.net"], quote: null, threading: null });
    expect(await approveAndSend(deps(), approveInput(edited, { confirmedRecipients: ["bob@example.org"] }))).toMatchObject({ result: { reason: "recipients_unconfirmed" } });
    nextOutcome = (n) => ({ kind: "succeeded", gmailMessageId: `sent${n}`, gmailThreadId: `newthread${n}` });
    expect(await approveAndSend(deps(), approveInput(edited))).toMatchObject({ kind: "executed", outcome: { kind: "succeeded" } });
  });

  // ---- daily cap (Q3) and seen (Q4) -----------------------------------------------------------

  it("the limit holds across items on the same UTC day; a blocked item stays pending and the audit holds only counts", async () => {
    const i1 = await compose({ to: "a1@example.org\na2@example.org" });
    const i2 = await compose({ to: "b1@example.org\nb2@example.org" });
    const i3 = await compose({ to: "c1@example.org" });
    expect((await approveAndSend(deps(), approveInput(i1, { newRecipientLimit: 3 }))).kind).toBe("executed");
    expect(await approveAndSend(deps(), approveInput(i2, { newRecipientLimit: 3 }))).toEqual({ kind: "approval", result: { kind: "blocked", reason: "new_recipient_limit" } });
    expect((await getOwnItem(database, userId, i2.id))!).toMatchObject({ status: "pending", newRecipientCount: null, approvedAt: null });
    expect((await audits("approval.new_recipient_limit")).map((a) => a.detail)).toEqual([{ itemId: i2.id, newRecipients: 2, usedToday: 2, limit: 3 }]);
    expect((await approveAndSend(deps(), approveInput(i3, { newRecipientLimit: 3 }))).kind).toBe("executed");
    expect(sends).toHaveLength(2);
    // Yesterday's approvals don't count today.
    await database.update(schema.approvalItems).set({ approvedAt: new Date(Date.now() - 2 * DAY) });
    expect((await approveAndSend(deps(), approveInput(i2, { newRecipientLimit: 3 }))).kind).toBe("executed");
  });

  it("a failed send releases its count; re-approving recomputes it", async () => {
    nextOutcome = (n) => (n === 1 ? { kind: "failed", code: "gmail_400", status: 400 } : { kind: "succeeded", gmailMessageId: `sent${n}`, gmailThreadId: `t${n}` });
    const i1 = await compose({ to: "a1@example.org\na2@example.org" });
    const i2 = await compose({ to: "b1@example.org\nb2@example.org" });
    await approveAndSend(deps(), approveInput(i1, { newRecipientLimit: 2 }));
    expect((await getOwnItem(database, userId, i1.id))!.status).toBe("failed");
    expect((await approveAndSend(deps(), approveInput(i2, { newRecipientLimit: 2 }))).kind).toBe("executed");
    const again = (await getOwnItem(database, userId, i1.id))!;
    expect(await approveAndSend(deps(), approveInput(again, { newRecipientLimit: 2 }))).toMatchObject({ result: { reason: "new_recipient_limit" } });
  });

  it("two parallel approves on two connections that fit alone but not together: exactly one wins", async () => {
    const second = postgres(testDbUrl!, { max: 1, onnotice: () => {} });
    const db2 = drizzle(second, { schema }) as unknown as Database;
    try {
      for (let round = 0; round < 3; round++) {
        await database.delete(schema.approvalItems);
        const i1 = await compose({ to: `x${round}a@example.org\nx${round}b@example.org` });
        const i2 = await compose({ to: `y${round}a@example.org\ny${round}b@example.org` });
        const results = await Promise.all([approveItem(database, approveInput(i1, { newRecipientLimit: 3 })), approveItem(db2, approveInput(i2, { newRecipientLimit: 3 }))]);
        expect(results.map((r) => r.kind).sort(), `round ${round}`).toEqual(["approved", "blocked"]);
        const rows = await database.select().from(schema.approvalItems);
        expect(rows.filter((r) => r.status === "approved")).toHaveLength(1);
        expect(rows.reduce((n, r) => n + (r.newRecipientCount ?? 0), 0)).toBe(2);
      }
    } finally {
      await second.end();
    }
  });

  it("limit 0 blocks any first-time recipient, but an all-seen message (own accounts) still sends", async () => {
    const fresh = await compose({ to: "stranger@example.org" });
    expect(await approveAndSend(deps(), approveInput(fresh, { newRecipientLimit: 0 }))).toMatchObject({ result: { reason: "new_recipient_limit" } });
    const own = await compose({ to: "HOME@example.com", cc: "work@example.com" });
    expect(await approveAndSend(deps(), approveInput(own, { newRecipientLimit: 0 }))).toMatchObject({ kind: "executed", outcome: { kind: "succeeded" } });
    expect((await getOwnItem(database, userId, own.id))!.newRecipientCount).toBe(0);
  });

  it("seen: (a) own accounts, (b) To/Cc of stored sent mail, (c) recipients of succeeded sends, (d) From/Reply-To of inbound mail", async () => {
    await storedThread({ isSent: true, labels: ["SENT"], from: "work@example.com", to: "Sent To <sentto@example.org>", cc: "sentcc@example.org" });
    await storedThread({ from: "Fred <inbound@example.org>", replyTo: "replyto@example.org", to: "work@example.com, notseen-to@example.org" });
    const prior = await compose({ to: "earlier@example.org" });
    await approveAndSend(deps(), approveInput(prior));
    const candidates = ["home@example.com", "SentTo@example.org", "sentcc@example.org", "earlier@example.org", "inbound@example.org", "replyto@example.org", "notseen-to@example.org", "stranger@example.org"];
    expect([...(await seenAddresses(database, userId, candidates))].sort()).toEqual(
      ["earlier@example.org", "home@example.com", "inbound@example.org", "replyto@example.org", "sentcc@example.org", "sentto@example.org"].sort(),
    );
    const item = await compose({ to: candidates.slice(0, 6).join("\n") });
    expect(await approveAndSend(deps(), approveInput(item, { newRecipientLimit: 0 }))).toMatchObject({ kind: "executed" });
    // Another user's mail never makes an address seen.
    const other = (await makeUser(database, "other@example.com")).id;
    expect([...(await seenAddresses(database, other, candidates))]).toEqual([]);
  });

  it("seen is whole-address: a substring match isn't seen; SPAM or TRASH inbound senders aren't seen", async () => {
    await storedThread({ from: "abob@example.org, bob@example.org.evil.example" });
    await storedThread({ from: "spammer@example.org", labels: ["SPAM"] });
    await storedThread({ from: "trashed@example.org", labels: ["INBOX", "TRASH"] });
    expect([...(await seenAddresses(database, userId, ["bob@example.org", "spammer@example.org", "trashed@example.org", "abob@example.org"]))]).toEqual(["abob@example.org"]);
    const item = await compose({ to: "bob@example.org" });
    expect(await approveAndSend(deps(), approveInput(item, { newRecipientLimit: 0 }))).toMatchObject({ result: { reason: "new_recipient_limit" } });
  });

  // ---- round 2: D1 (charges survive disconnect), F1 (TRASH/SPAM parent), F2 (failQueueRow) -----

  it("D1: disconnecting an account keeps today's charges; a deleted item keeps counting", async () => {
    const fromB = await compose({ accountId: accountB.id, to: "g1@example.org\ng2@example.org" });
    expect((await approveAndSend(deps(), approveInput(fromB, { newRecipientLimit: 3 }))).kind).toBe("executed");
    await deleteAccount(database, userId, accountB.id);
    expect(await database.select().from(schema.approvalItems).where(eq(schema.approvalItems.id, fromB.id))).toEqual([]);
    expect(await database.select().from(schema.approvalRecipientCharges)).toMatchObject([{ itemId: fromB.id, userId, newRecipients: 2 }]);
    const fromA = await compose({ to: "h1@example.org\nh2@example.org" });
    expect(await approveItem(database, approveInput(fromA, { newRecipientLimit: 3 }))).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
    const one = await compose({ to: "h3@example.org" });
    expect((await approveItem(database, approveInput(one, { newRecipientLimit: 3 }))).kind).toBe("approved");
    // Deleting the user removes the charges (the only cascade).
    await database.delete(schema.users);
    expect(await database.select().from(schema.approvalRecipientCharges)).toEqual([]);
  });

  it("D1: a charge stops counting when its item fails (as marked-not-sent items do) or goes back to pending by an edit; a re-approval replaces it", async () => {
    nextOutcome = () => ({ kind: "failed", code: "gmail_400", status: 400 });
    const i1 = await compose({ to: "a1@example.org\na2@example.org" });
    await approveAndSend(deps(), approveInput(i1, { newRecipientLimit: 2 }));
    expect((await getOwnItem(database, userId, i1.id))!.status).toBe("failed");
    const i2 = await compose({ to: "b1@example.org\nb2@example.org" });
    expect((await approveItem(database, approveInput(i2, { newRecipientLimit: 2 }))).kind).toBe("approved");
    // Back to pending with an edit (approved -> failed first, via a send failure).
    const claim = (await claimItem(database, userId, i2.id))!;
    await executeClaimed(deps(), i2.id, claim.executionId);
    const failed2 = (await getOwnItem(database, userId, i2.id))!;
    await editItem(database, { userId, itemId: i2.id, revision: failed2.revision, to: "b1@example.org", cc: "", subject: "Hello", bodyText: "x", includeQuote: false });
    // Re-approving i1 after one of its recipients became seen (an own account) replaces the charge with n = 1.
    await database.update(schema.connectedAccounts).set({ email: "a1@example.org" }).where(eq(schema.connectedAccounts.id, accountB.id));
    nextOutcome = (n) => ({ kind: "succeeded", gmailMessageId: `s${n}`, gmailThreadId: `t${n}` });
    const again = (await getOwnItem(database, userId, i1.id))!;
    expect((await approveAndSend(deps(), approveInput(again, { newRecipientLimit: 2 }))).kind).toBe("executed");
    expect((await database.select().from(schema.approvalRecipientCharges).where(eq(schema.approvalRecipientCharges.itemId, i1.id)))[0]!.newRecipients).toBe(1);
    const view = (await getItemView(database, userId, i1.id, { newRecipientLimit: 2 }))!;
    expect(view.cap).toEqual({ limit: 2, usedToday: 1, remaining: 1 });
  });

  it("F1: a reply's parent in TRASH or SPAM doesn't exempt its addresses; the normal rules apply", async () => {
    for (const label of ["TRASH", "SPAM"]) {
      await database.delete(schema.approvalItems);
      const { thread, message } = await storedThread({ cc: `cc-${label}@example.net`, labels: ["INBOX", label] });
      const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: message.id, to: "alice@example.org", cc: `cc-${label}@example.net`, subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
      const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
      expect([...(await seenAddresses(database, userId, [`cc-${label}@example.net`], { messageId: message.id, accountId: accountA.id }))], label).toEqual([]);
      // alice@ (the parent's From) isn't seen either: (d) excludes TRASH/SPAM senders.
      expect((await getItemView(database, userId, item.id, { newRecipientLimit: 0 }))!.firstTime.sort()).toEqual(["alice@example.org", `cc-${label.toLowerCase()}@example.net`].sort());
      expect(await approveItem(database, approveInput(item, { confirmedRecipients: undefined, newRecipientLimit: 0 })), label).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
    }
  });

  it("F2: failQueueRow leaves a row converted to outbound since it was loaded; an outbound row itself still fails normally", async () => {
    await enqueueMessages(database, accountA, [{ gmailMessageId: "f1", gmailThreadId: "tf1", source: "history", needsClassify: true }]);
    await database.update(schema.mailFetchQueue).set({ attempts: 4 });
    const [loaded] = await dueQueueRows(database, accountA.id, new Date(Date.now() + 1000), 10);
    await enqueueOutbound(database, accountA, "f1", "tf1");
    await failQueueRow(database, loaded!, new Date(), { transient: false, error: "400", maxAttempts: 5, maxTransientAttempts: 10 });
    await failQueueRow(database, { ...loaded!, attempts: 0 }, new Date(), { transient: false, error: "400", maxAttempts: 5, maxTransientAttempts: 10 });
    const [row] = await database.select().from(schema.mailFetchQueue);
    expect(row).toMatchObject({ source: "outbound", attempts: 0, lastError: null });
    expect(row!.nextAttemptAt.getTime()).not.toBe(PARKED_AT.getTime());
    await failQueueRow(database, row!, new Date(), { transient: false, error: "400", maxAttempts: 1, maxTransientAttempts: 10 });
    expect((await database.select().from(schema.mailFetchQueue))[0]!.nextAttemptAt.getTime()).toBe(PARKED_AT.getTime());
  });

  // ---- the Q3 amendment: replies ---------------------------------------------------------------

  it("reply all to a parent with more than 10 never-seen Cc addresses is not blocked (they are on the parent)", async () => {
    const cc = Array.from({ length: 14 }, (_, i) => `cc${i}@example.net`);
    const { thread, message } = await storedThread({ to: "work@example.com, team@example.net", cc: cc.join(", "), replyTo: "lists@example.net" });
    const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: message.id, to: "alice@example.org", cc: ["team@example.net", "lists@example.net", ...cc].join("\n"), subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
    const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    expect(await approveAndSend(deps(), approveInput(item, { confirmedRecipients: undefined, newRecipientLimit: 10 }))).toMatchObject({ kind: "executed", outcome: { kind: "succeeded" } });
    expect((await getOwnItem(database, userId, item.id))!.newRecipientCount).toBe(0);
  });

  it("a reply that adds a Cc beyond the parent's addresses counts it; a parent in another account doesn't count", async () => {
    const { thread, message } = await storedThread({ cc: "known@example.net" });
    const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: message.id, to: "alice@example.org", cc: "known@example.net\nadded@example.net", subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
    const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    expect(await approveAndSend(deps(), approveInput(item, { confirmedRecipients: undefined, newRecipientLimit: 0 }))).toMatchObject({ result: { reason: "new_recipient_limit" } });
    expect((await audits("approval.new_recipient_limit"))[0]!.detail).toEqual({ itemId: item.id, newRecipients: 1, usedToday: 0, limit: 0 });
    // Account scoping of the parent lookup: the parent's addresses count only with the item's own account.
    expect([...(await seenAddresses(database, userId, ["known@example.net"], { messageId: message.id, accountId: accountB.id }))]).toEqual([]);
    expect([...(await seenAddresses(database, userId, ["known@example.net"], { messageId: message.id, accountId: accountA.id }))]).toEqual(["known@example.net"]);
    expect(await approveAndSend(deps(), approveInput(item, { confirmedRecipients: undefined, newRecipientLimit: 1 }))).toMatchObject({ kind: "executed" });
    expect((await getOwnItem(database, userId, item.id))!.newRecipientCount).toBe(1);
  });

  it("a reply whose stored parent is gone falls back to (a)–(d): the parent's Cc addresses count again", async () => {
    const { thread } = await storedThread({ cc: "onparent@example.net" });
    const [p2] = await database
      .insert(schema.mailMessages)
      .values({
        userId,
        accountId: accountA.id,
        threadId: thread.id,
        gmailMessageId: "p2",
        gmailThreadId: thread.gmailThreadId,
        internalDate: new Date(clock - DAY / 2),
        labelIds: ["INBOX"],
        isSent: false,
        fromHeader: "alice@example.org",
        toHeader: "work@example.com",
        ccHeader: "onparent2@example.net",
        rfc822MessageId: "<p2@mail.example.org>",
        headers: [],
        bodyText: "Second",
      })
      .returning();
    const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: p2!.id, to: "alice@example.org", cc: "onparent2@example.net", subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
    const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    expect((await getItemView(database, userId, item.id, { newRecipientLimit: 0 }))!.firstTime).toEqual([]);
    await database.delete(schema.mailMessages).where(eq(schema.mailMessages.id, p2!.id));
    const orphan = (await getOwnItem(database, userId, item.id))!;
    expect(orphan).toMatchObject({ threadId: thread.id, parentMessageId: null });
    expect((await getItemView(database, userId, item.id, { newRecipientLimit: 0 }))!.firstTime).toEqual(["onparent2@example.net"]);
    expect(await approveAndSend(deps(), approveInput(orphan, { confirmedRecipients: undefined, newRecipientLimit: 0 }))).toMatchObject({ result: { reason: "new_recipient_limit" } });
  });

  // ---- execute (AC4) --------------------------------------------------------------------------

  it("execute: threadId null, the raw message is exactly the approved To/Cc/subject/body, sent once under 10 parallel approves", async () => {
    const item = await compose({ to: "bob@example.org", cc: "amy@example.net", subject: "Plans", bodyText: "Line 1\nLine 2" });
    const results = await Promise.all(Array.from({ length: 10 }, () => approveAndSend(deps(), approveInput(item))));
    expect(results.filter((r) => r.kind === "executed")).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.threadId).toBeNull();
    expect(sends[0]!.accountId).toBe(accountA.id);
    const text = Buffer.from(sends[0]!.raw, "base64url").toString("utf8");
    const head = text.slice(0, text.indexOf("\r\n\r\n"));
    expect(head).toContain("From: work@example.com\r\nTo: bob@example.org\r\nCc: amy@example.net\r\nSubject: Plans\r\n");
    expect(head).not.toMatch(/In-Reply-To|References|Bcc/i);
    const after = (await getOwnItem(database, userId, item.id))!;
    expect(head).toContain(`Message-ID: ${after.messageIdHeader}`);
    const body = Buffer.from(text.slice(text.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(body).toBe("Line 1\r\nLine 2");
    expect(after).toMatchObject({ status: "succeeded", result: { gmailMessageId: "sent1", gmailThreadId: "newthread1" } });
    expect((await audits("approval.approved")).length).toBe(1);
  });

  // ---- outbound ingestion (AC9) ----------------------------------------------------------------

  it("success enqueues an outbound row; the next sync stores it as a new sent-only thread, linked from the item, which ingestion doesn't change", async () => {
    await syncA(); // empty mailbox: backfill completes
    const item = await compose({ to: "bob@example.org", subject: "Plans" });
    expect((await getItemView(database, userId, item.id))!.sentThread).toBeNull();
    await approveAndSend(deps(), approveInput(item));
    const [q] = await database.select().from(schema.mailFetchQueue);
    expect(q).toMatchObject({ source: "outbound", gmailMessageId: "sent1", gmailThreadId: "newthread1", needsClassify: false, accountId: accountA.id });
    const before = (await getOwnItem(database, userId, item.id))!;
    // Gmail has the SENT copy; history reports it without labels (as it typically does).
    gmail.deliver({ id: "sent1", threadId: "newthread1", labelIds: ["SENT"], internalDate: clock, from: "work@example.com", subject: "Plans", messageIdHeader: before.messageIdHeader! });
    await syncA();
    const threads = await database.select().from(schema.mailThreads);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ gmailThreadId: "newthread1", accountId: accountA.id, inInbox: false, messageCount: 1 });
    const [stored] = await database.select().from(schema.mailMessages);
    expect(stored).toMatchObject({ gmailMessageId: "sent1", isSent: true, rfc822MessageId: before.messageIdHeader });
    expect(await database.select().from(schema.mailFetchQueue)).toEqual([]);
    const after = (await getOwnItem(database, userId, item.id))!;
    expect(after).toEqual(before);
    expect((await database.select().from(schema.approvalItems)).every((r) => r.threadChangedAt === null)).toBe(true);
    const view = (await getItemView(database, userId, item.id))!;
    expect(view.sentThread).toMatchObject({ id: threads[0]!.id });
    // Not in the Inbox list (sent-only), and only the thread of the item's own account is found.
    expect(threads[0]!.inInbox).toBe(false);
  });

  it("a reconcile hit (list_found) for a new message enqueues outbound too; a reply's doesn't", async () => {
    nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
    const item = await compose();
    await approveAndSend(deps(), approveInput(item));
    const unknown = (await getOwnItem(database, userId, item.id))!;
    expect(unknown.status).toBe("unknown");
    expect(await database.select().from(schema.mailFetchQueue)).toEqual([]);
    gmail.seed({ id: "g1", threadId: "gt-new", labelIds: ["SENT"], internalDate: clock, messageIdHeader: unknown.messageIdHeader! });
    const r = await reconcileApprovals({ db: database, gmailFor: () => gmail });
    expect(r.found).toBe(1);
    expect(await database.select().from(schema.mailFetchQueue)).toMatchObject([{ source: "outbound", gmailMessageId: "g1", gmailThreadId: "gt-new" }]);
  });

  it("a SENT copy that is in SPAM or TRASH is dropped, and no thread is created", async () => {
    await syncA();
    const item = await compose();
    await approveAndSend(deps(), approveInput(item));
    gmail.seed({ id: "sent1", threadId: "newthread1", labelIds: ["SENT", "TRASH"], internalDate: clock });
    await syncA();
    expect(await database.select().from(schema.mailThreads)).toEqual([]);
    expect(await database.select().from(schema.mailFetchQueue)).toEqual([]);
  });

  it("a send to the owner's own account (SENT + INBOX) takes the normal inbox path", async () => {
    await syncA();
    const item = await compose({ to: "work@example.com" });
    await approveAndSend(deps(), approveInput(item));
    const it2 = (await getOwnItem(database, userId, item.id))!;
    gmail.deliver({ id: "sent1", threadId: "newthread1", labelIds: ["SENT", "INBOX", "UNREAD"], internalDate: clock, messageIdHeader: it2.messageIdHeader! });
    await syncA();
    expect((await database.select().from(schema.mailThreads))[0]).toMatchObject({ gmailThreadId: "newthread1", inInbox: true });
  });

  it("race (R7): a history row converted to outbound mid-processing isn't lost by the history row's drop or defer", async () => {
    await enqueueMessages(database, accountA, [{ gmailMessageId: "x1", gmailThreadId: "tx", source: "history", needsClassify: true }]);
    const [loaded] = await dueQueueRows(database, accountA.id, new Date(), 10);
    expect(loaded!.source).toBe("history");
    await enqueueOutbound(database, accountA, "x1", "tx");
    await dropQueueRow(database, loaded!); // what hydrate does for "SENT in an unknown thread"
    await deferQueueRow(database, loaded!, new Date(), 60_000, 1); // and the defer-and-drop path
    const rows = await database.select().from(schema.mailFetchQueue);
    expect(rows).toMatchObject([{ gmailMessageId: "x1", source: "outbound", needsClassify: false, deferredAt: null, attempts: 0 }]);
    // An outbound row itself is dropped normally.
    await dropQueueRow(database, rows[0]!);
    expect(await database.select().from(schema.mailFetchQueue)).toEqual([]);
    // A later history enqueue leaves an outbound row as it is.
    await enqueueOutbound(database, accountA, "x2", "ty");
    await enqueueMessages(database, accountA, [{ gmailMessageId: "x2", gmailThreadId: "ty", source: "history", needsClassify: true }]);
    expect((await database.select().from(schema.mailFetchQueue))[0]).toMatchObject({ source: "outbound" });
  });

  it("outbound rows don't count as inbox siblings or make a thread known, and come out first", async () => {
    await enqueueMessages(database, accountA, [{ gmailMessageId: "b1", gmailThreadId: "tb", source: "backfill_inbox", needsClassify: false }]);
    await enqueueOutbound(database, accountA, "o1", "to");
    expect([...(await knownThreadIds(database, accountA.id, ["to", "tb"]))]).toEqual(["tb"]);
    expect((await dueQueueRows(database, accountA.id, new Date(Date.now() + 1000), 10)).map((r) => r.gmailMessageId)).toEqual(["o1", "b1"]);
  });

  // ---- audit sweep (AC11) ----------------------------------------------------------------------

  it("a full compose lifecycle writes no recipient address, subject or body text into audit_log", async () => {
    await syncA();
    const subject = "Confidential plans";
    const bodyText = "The secret body text";
    const recipients = ["bob@example.org", "amy@example.net", "carl@example.net"];
    const item = await compose({ to: recipients.slice(0, 2).join("\n"), cc: recipients[2], subject, bodyText });
    await approveAndSend(deps(), approveInput(item, { confirmedRecipients: recipients.slice(0, 2) }));
    await approveAndSend(deps(), approveInput(item, { newRecipientLimit: 1 }));
    await editItem(database, { userId, itemId: item.id, revision: 1, to: recipients.slice(0, 2).join("\n"), cc: recipients[2]!, subject, bodyText: `${bodyText}!`, includeQuote: false });
    const edited = (await getOwnItem(database, userId, item.id))!;
    await approveAndSend(deps(), approveInput(edited));
    const sent = (await getOwnItem(database, userId, item.id))!;
    gmail.deliver({ id: "sent1", threadId: "newthread1", labelIds: ["SENT"], internalDate: clock, subject, messageIdHeader: sent.messageIdHeader! });
    await syncA();
    const all = await database.select().from(schema.auditLog);
    expect(all.map((a) => a.action)).toEqual(expect.arrayContaining(["approval.proposed", "approval.new_recipient_limit", "approval.edited", "approval.approved", "approval.executed"]));
    const blob = JSON.stringify(all.map((a) => a.detail)).toLowerCase();
    for (const needle of [...recipients, subject, bodyText, "work@example.com"]) expect(blob, needle).not.toContain(needle.toLowerCase());
  });
});
