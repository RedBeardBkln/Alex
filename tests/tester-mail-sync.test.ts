import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { createGmailClient, GmailApiError, GmailShapeError, type GmailClient } from "@/lib/gmail/client";
import { handlePush } from "@/lib/gmail/push";
import { getSyncState, getThreadView, listInboxThreads, PARKED_AT } from "@/lib/gmail/store";
import { MAX_DEFERRALS, MAX_TRANSIENT_ATTEMPTS, runCronSync, runWatchRenewal, stopWatchBeforeDisconnect, syncAccount, syncAfterConnect, syncAfterPush, type SyncDeps } from "@/lib/gmail/sync";
import { b64url, FakeGmail, textPart, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

/**
 * Tester-added flows (plan 6 edge cases). TEST_DATABASE_URL only: the schema is dropped and recreated.
 */

const DAY = 86400_000;
const TOPIC = "projects/test-project/topics/gmail-push";

describe.skipIf(!testDbUrl)("tester: mail sync edge cases (Postgres + fake Gmail)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  let msPerCall: number;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.auditLog);
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    gmail = new FakeGmail();
    clock = Date.now();
    msPerCall = 0;
  });

  function ticking(inner: GmailClient): GmailClient {
    return new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return async (...args: unknown[]) => {
          clock += msPerCall;
          return v.apply(target, args);
        };
      },
    });
  }

  function deps(over: Partial<SyncDeps> = {}): SyncDeps {
    return {
      db: database,
      gmailFor: () => ticking(gmail),
      topic: TOPIC,
      now: () => new Date(clock),
      sleep: async () => {},
      unitsPerMinute: 1e9,
      ...over,
    };
  }

  const reloadAccount = async () =>
    (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
  const state = async () => (await getSyncState(database, account.id))!;
  const stored = async () =>
    (await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.accountId, account.id)).orderBy(asc(schema.mailMessages.internalDate))).map(
      (m) => m.gmailMessageId,
    );
  const audits = async () =>
    (await database.select().from(schema.auditLog).orderBy(asc(schema.auditLog.createdAt))).filter((a) => a.action.startsWith("mail."));
  const queue = async () => database.select().from(schema.mailFetchQueue).where(eq(schema.mailFetchQueue.accountId, account.id));
  const threadRow = async (gmailThreadId: string) =>
    (await database.select().from(schema.mailThreads).where(eq(schema.mailThreads.gmailThreadId, gmailThreadId)))[0];

  const msg = (id: string, threadId: string, labels: string[], ageMs: number, extra: Partial<FakeMessage> = {}): FakeMessage => ({
    id,
    threadId,
    labelIds: labels,
    internalDate: clock - ageMs,
    ...extra,
  });

  async function cron() {
    const r = await syncAccount(deps(), await reloadAccount(), "cron");
    clock += 5 * 60_000;
    return r;
  }

  async function runUntilComplete(max = 15) {
    for (let i = 0; i < max; i++) {
      await cron();
      if ((await state()).backfillStatus === "complete" && (await queue()).length === 0) return i + 1;
    }
    return max;
  }

  // ---- 1. Sent reply during a long backfill (AC 12, plan 6.6 deferral) --------------------------

  it("a sent reply arriving through history while its thread's inbox message is still queued for backfill is eventually stored", async () => {
    // Realistic shape: Gmail lists newest first in pages, so older threads are queued later and hydrated last.
    gmail.listPageSize = 5;
    for (let i = 0; i < 29; i++) gmail.seed(msg(`i${i}`, `t${i}`, ["INBOX"], (i + 1) * 3600_000));
    gmail.seed(msg("iOld", "tOld", ["INBOX"], 20 * DAY)); // oldest: last listing page, hydrated last
    msPerCall = 50_000; // a handful of Gmail calls per 240 s run, like a busy 30-day backfill

    await syncAfterConnect(deps(), account.id);
    clock += 5 * 60_000;
    for (let i = 0; i < 10 && ["listing_inbox", "listing_sent"].includes((await state()).backfillStatus); i++) await cron();
    expect((await state()).backfillStatus).toBe("hydrating");
    expect(await stored()).not.toContain("iOld");

    // The owner replies in Gmail to the old thread while Alex is still hydrating the backfill.
    gmail.deliver(msg("r1", "tOld", ["SENT"], 0, { inReplyTo: "<iOld@mail.example.com>" }));

    gmail.calls = [];
    await runUntilComplete(40);
    expect(await stored()).toContain("iOld");
    const r1Ops = gmail.calls.filter((c) => c.args[0] === "r1").map((c) => c.op);
    // Plan AC 12: "A messagesAdded sent message in a known thread is stored and shown."
    expect(await stored(), `Gmail calls for r1: ${r1Ops.join(",")}; queue row: ${JSON.stringify((await queue()).find((q) => q.gmailMessageId === "r1") ?? null)}`).toContain("r1");
  });

  // ---- 2. Resync while the initial backfill is still hydrating ---------------------------------

  it("a 404 resync during an unfinished backfill does not mark the backfill complete while backfill rows are still queued", async () => {
    for (let i = 0; i < 20; i++) gmail.seed(msg(`i${i}`, `t${i}`, ["INBOX"], (i + 1) * 3600_000));
    msPerCall = 50_000;
    await syncAfterConnect(deps(), account.id); // lists everything, hydrates a little
    clock += 5 * 60_000;
    expect((await state()).backfillStatus).toBe("hydrating");

    gmail.historyId += 50;
    gmail.expiredBefore = BigInt(gmail.historyId);

    const violations: string[] = [];
    for (let i = 0; i < 20; i++) {
      await cron();
      const s = await state();
      const pending = await database
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.mailFetchQueue)
        .where(
          and(
            eq(schema.mailFetchQueue.accountId, account.id),
            inArray(schema.mailFetchQueue.source, ["backfill_inbox", "backfill_sent"]),
            lt(schema.mailFetchQueue.nextAttemptAt, PARKED_AT),
          ),
        );
      if (s.backfillStatus === "complete" && pending[0]!.n > 0) violations.push(`run ${i}: complete with ${pending[0]!.n} backfill rows queued`);
      if (s.backfillStatus === "complete" && (await queue()).length === 0) break;
    }
    expect((await stored()).length).toBe(20);
    const completed = (await audits()).filter((a) => a.action === "mail.backfill_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.detail, "backfill_completed counts").toEqual({ inbox: 20, sent: 0 });
    expect(violations).toEqual([]);
  });

  // ---- 3. 429 on history.list ------------------------------------------------------------------

  it("429 on the first history page: cursor unchanged, nothing applied, error recorded; next run recovers", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    const cursor = (await state()).historyId;
    gmail.deliver(msg("n1", "t2", ["INBOX"], 0));
    gmail.failNext("listHistory", 429, "rateLimitExceeded");
    gmail.calls = [];
    const res = await cron();
    expect(res).toMatchObject({ outcome: "error", stage: "history" });
    expect((await state()).historyId).toBe(cursor);
    expect((await state()).lastError).toBe("history: 429 rateLimitExceeded");
    expect(gmail.count("getMessageFull")).toBe(0);
    expect(await stored()).toEqual(["i1"]);
    await cron();
    expect((await stored()).sort()).toEqual(["i1", "n1"]);
    expect((await state()).historyId).toBe(String(gmail.historyId));
    expect((await state()).lastError).toBeNull();
    expect((await state()).consecutiveFailures).toBe(0);
  });

  it("5xx on a body-part fetch is transient: the row stays queued and nothing is stored as incomplete", async () => {
    gmail.bodies.set("B1", b64url("<p>html</p>"));
    gmail.seed(msg("big", "tb", ["INBOX"], DAY, { payload: { mimeType: "text/html", filename: "", body: { attachmentId: "B1", size: 10 } } }));
    await syncAfterConnect(deps({ budgetMs: 0 }), account.id);
    gmail.failNext("getBodyPartData", 503, "backendError");
    const res = await cron();
    expect(res.outcome).toBe("error");
    expect(await stored()).toEqual([]);
    expect((await queue()).map((q) => [q.gmailMessageId, q.attempts])).toEqual([["big", 1]]);
    clock += 10 * 60_000;
    await runUntilComplete();
    const [m] = await database.select().from(schema.mailMessages);
    expect([m!.bodyHtml, m!.bodyIncomplete]).toEqual(["<p>html</p>", false]);
  });

  // ---- 4. Lease expiry through the real entry point --------------------------------------------

  it("an expired lease left by a crashed run is taken over; a live one blocks; the lease is released after the run", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await syncAfterConnect(deps({ budgetMs: 0 }), account.id);
    await database
      .update(schema.mailSyncState)
      .set({ leaseOwner: "crashed", leaseUntil: sql`now() + interval '200 seconds'` })
      .where(eq(schema.mailSyncState.accountId, account.id));
    expect((await cron()).outcome).toBe("busy");
    expect((await syncAfterPush(deps(), account.id))!.outcome).toBe("busy");
    await database
      .update(schema.mailSyncState)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(schema.mailSyncState.accountId, account.id));
    expect((await cron()).outcome).toBe("ok");
    expect(await stored()).toEqual(["i1"]);
    const s = await state();
    expect([s.leaseOwner, s.leaseUntil]).toEqual([null, null]);
  });

  it("two concurrent cron runs on the same account: exactly one does the work", async () => {
    for (let i = 0; i < 5; i++) gmail.seed(msg(`i${i}`, `t${i}`, ["INBOX"], (i + 1) * 3600_000));
    const acct = await reloadAccount();
    const results = await Promise.all([syncAccount(deps(), acct, "cron"), syncAccount(deps(), acct, "cron")]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["busy", "ok"]);
    expect(gmail.count("getProfile")).toBe(1);
    expect((await stored()).length).toBe(5);
  });

  // ---- 5. Real attachments are never fetched (AC 14) -------------------------------------------

  it("never fetches real attachments: filename, Content-Disposition: attachment without filename, inline image, attached text", async () => {
    for (const id of ["REAL-PDF", "REAL-DISP", "REAL-INLINE", "REAL-TXT", "BODY-TXT"]) gmail.bodies.set(id, b64url(`content of ${id}`));
    gmail.seed(
      msg("m1", "t1", ["INBOX"], DAY, {
        payload: {
          mimeType: "multipart/mixed",
          filename: "",
          body: { size: 0 },
          parts: [
            {
              partId: "0",
              mimeType: "multipart/related",
              filename: "",
              body: { size: 0 },
              parts: [
                { partId: "0.0", mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }], body: { attachmentId: "BODY-TXT", size: 900_000 } },
                {
                  partId: "0.1",
                  mimeType: "image/png",
                  filename: "logo.png",
                  headers: [{ name: "Content-ID", value: "<logo@x>" }, { name: "Content-Disposition", value: "inline; filename=logo.png" }],
                  body: { attachmentId: "REAL-INLINE", size: 100 },
                },
              ],
            },
            { partId: "1", mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "REAL-PDF", size: 1000 } },
            {
              partId: "2",
              mimeType: "text/html",
              filename: "",
              headers: [{ name: "Content-Disposition", value: 'ATTACHMENT; name="x"' }],
              body: { attachmentId: "REAL-DISP", size: 10 },
            },
            { partId: "3", mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "REAL-TXT", size: 10 } },
          ],
        },
      }),
    );
    await runUntilComplete();
    expect(gmail.calls.filter((c) => c.op === "getBodyPartData").map((c) => c.args[1])).toEqual(["BODY-TXT"]);
    const [m] = await database.select().from(schema.mailMessages);
    expect(m!.bodyText).toBe("content of BODY-TXT");
    expect(m!.bodyHtml).toBeNull();
    const atts = await database.select().from(schema.mailAttachments).orderBy(asc(schema.mailAttachments.partId));
    expect(atts.map((a) => [a.partId, a.filename, a.gmailAttachmentId, a.isInline])).toEqual([
      ["0.1", "logo.png", "REAL-INLINE", true],
      ["1", "invoice.pdf", "REAL-PDF", false],
      ["2", null, "REAL-DISP", false],
      ["3", "notes.txt", "REAL-TXT", false],
    ]);
    // No attachment row carries content.
    expect(JSON.stringify(atts)).not.toContain("content of");
  });

  // ---- 6. Authorization (AC 17) ----------------------------------------------------------------

  it("inbox and thread view are scoped by user, even when two users' accounts share Gmail ids", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY, { subject: "Owner subject" }));
    await runUntilComplete();
    const stranger = await makeUser(database, "stranger@example.com");
    const strangerAcct = await makeGoogleAccount(database, stranger.id, { email: "s@example.com" });
    const g2 = new FakeGmail();
    g2.seed(msg("i1", "t1", ["INBOX"], DAY, { subject: "Stranger subject" }));
    await syncAccount(deps({ gmailFor: () => g2 }), strangerAcct, "cron");
    await syncAccount(deps({ gmailFor: () => g2 }), strangerAcct, "cron");

    const mine = await listInboxThreads(database, userId, { limit: 50 });
    const theirs = await listInboxThreads(database, stranger.id, { limit: 50 });
    expect(mine.map((t) => t.subject)).toEqual(["Owner subject"]);
    expect(theirs.map((t) => t.subject)).toEqual(["Stranger subject"]);
    expect(await getThreadView(database, stranger.id, mine[0]!.id)).toBeNull();
    expect(await getThreadView(database, userId, theirs[0]!.id)).toBeNull();
    expect(await getThreadView(database, userId, "00000000-0000-4000-8000-000000000000")).toBeNull();
    const view = await getThreadView(database, userId, mine[0]!.id);
    expect(view!.messages.map((m) => m.subject)).toEqual(["Owner subject"]);
  });

  // ---- 7. Label reconciliation and deletes ------------------------------------------------------

  it("trash, unarchive, partial delete and full delete update the thread without any message fetch", async () => {
    gmail.seed(msg("a1", "tA", ["INBOX", "UNREAD"], 2 * DAY));
    gmail.seed(msg("a2", "tA", ["INBOX"], DAY));
    gmail.seed(msg("b1", "tB", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.calls = [];

    // Trash a2 (Gmail shows this as TRASH added, INBOX removed) and read a1.
    gmail.addLabels("a2", ["TRASH"]);
    gmail.removeLabels("a2", ["INBOX"]);
    gmail.removeLabels("a1", ["UNREAD"]);
    await cron();
    let tA = await threadRow("tA");
    expect([tA!.inInbox, tA!.hasUnread, tA!.messageCount]).toEqual([true, false, 2]);
    const view = await getThreadView(database, userId, tA!.id);
    expect(view!.messages.find((m) => m.gmailMessageId === "a2")!.labelIds).toContain("TRASH");

    // Archive a1: thread leaves the inbox; unarchive it again: back.
    gmail.removeLabels("a1", ["INBOX"]);
    await cron();
    expect((await threadRow("tA"))!.inInbox).toBe(false);
    expect((await listInboxThreads(database, userId, { limit: 10 })).map((t) => t.subject)).toEqual(["Subject b1"]);
    gmail.addLabels("a1", ["INBOX", "UNREAD"]);
    await cron();
    tA = await threadRow("tA");
    expect([tA!.inInbox, tA!.hasUnread]).toEqual([true, true]);

    // Permanently delete a2: thread stays with one message; delete a1: thread row is gone.
    gmail.deleteForever("a2");
    await cron();
    expect((await threadRow("tA"))!.messageCount).toBe(1);
    gmail.deleteForever("a1");
    await cron();
    expect(await threadRow("tA")).toBeUndefined();
    expect((await stored()).sort()).toEqual(["b1"]);
    expect(gmail.calls.filter((c) => ["getMessageFull", "getMessageMinimal", "getBodyPartData"].includes(c.op))).toEqual([]);
  });

  it("a message that is added then deleted before hydration never gets stored and leaves no queue row", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.deliver(msg("gone", "t9", ["INBOX"], 0));
    gmail.deleteForever("gone");
    gmail.calls = [];
    await cron();
    expect(await stored()).toEqual(["i1"]);
    expect(await queue()).toEqual([]);
    expect(gmail.count("getMessageFull")).toBe(0);
  });

  it("with labels present in history: drafts, spam and trash are dropped with no Gmail get at all", async () => {
    gmail.historyLabels = true;
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.calls = [];
    gmail.deliver(msg("d1", "t1", ["DRAFT"], 0));
    gmail.deliver(msg("sp", "t2", ["SPAM", "INBOX"], 0));
    gmail.deliver(msg("tr", "t1", ["TRASH", "SENT"], 0));
    gmail.deliver(msg("n1", "t3", ["INBOX"], 0));
    await cron();
    expect((await stored()).sort()).toEqual(["i1", "n1"]);
    expect(gmail.calls.filter((c) => c.op === "getMessageMinimal")).toEqual([]);
    expect(gmail.calls.filter((c) => c.op === "getMessageFull").map((c) => c.args[0])).toEqual(["n1"]);
  });

  it("a stored message that is later moved to SPAM stays stored but leaves the inbox", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.addLabels("i1", ["SPAM"]);
    gmail.removeLabels("i1", ["INBOX"]);
    await cron();
    expect(await stored()).toEqual(["i1"]);
    expect(await listInboxThreads(database, userId, { limit: 10 })).toEqual([]);
  });

  // ---- 8. Push and resync interplay -------------------------------------------------------------

  it("a push whose history 404s starts a resync but defers listing to cron; the cursor comes from getProfile", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.seed(msg("n1", "t2", ["INBOX"], 60_000)); // arrives during the gap
    gmail.historyId += 100;
    gmail.expiredBefore = BigInt(gmail.historyId);
    const scheduled: string[] = [];
    const body = JSON.stringify({ message: { data: b64url(JSON.stringify({ emailAddress: "work@example.com", historyId: "1" })) } });
    expect(
      await handlePush(
        { authorization: "Bearer x", body },
        { audience: "a", serviceAccount: "s" },
        { db: database, verify: async () => ({ ok: true }), schedule: (id) => scheduled.push(id), now: () => new Date(clock) },
      ),
    ).toBe(204);
    expect(scheduled).toEqual([account.id]);
    gmail.calls = [];
    await syncAfterPush(deps(), account.id);
    expect(gmail.calls.map((c) => c.op)).not.toContain("listMessages");
    const s = await state();
    expect(s.historyId).toBe(String(gmail.historyId));
    expect(s.resyncAfter).not.toBeNull();
    expect(s.lastPushHistoryId).toBe("1");
    await runUntilComplete();
    expect((await stored()).sort()).toEqual(["i1", "n1"]);
    expect((await state()).resyncAfter).toBeNull();
  });

  it("the notification historyId is never used as the cursor, even when it is larger", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    const cursor = (await state()).historyId!;
    const body = JSON.stringify({ message: { data: b64url(JSON.stringify({ emailAddress: "WORK@example.com", historyId: "18446744073709551615" })) } });
    await handlePush({ authorization: "x", body }, { audience: "a", serviceAccount: "s" }, { db: database, verify: async () => ({ ok: true }), schedule: () => {} });
    expect((await state()).historyId).toBe(cursor);
    await syncAfterPush(deps(), account.id);
    expect((await state()).historyId).toBe(String(gmail.historyId));
    expect(gmail.calls.filter((c) => c.op === "listHistory").at(-1)!.args[0]).toMatchObject({ startHistoryId: cursor });
  });

  // ---- 9. Reauth and reconnect ------------------------------------------------------------------

  it("reauth pauses with no Gmail calls; reconnect resumes from the stored cursor without a new backfill", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    const cursor = (await state()).historyId!;
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, account.id));
    gmail.deliver(msg("n1", "t2", ["INBOX"], 0));
    gmail.calls = [];
    await cron();
    await cron();
    await runWatchRenewal(deps());
    expect(gmail.calls).toEqual([]);
    expect((await state()).lastError).toBe("reauth_required");
    expect((await audits()).filter((a) => a.action === "mail.sync_skipped_reauth")).toHaveLength(1);

    await database.update(schema.connectedAccounts).set({ status: "active" }).where(eq(schema.connectedAccounts.id, account.id));
    await syncAfterConnect(deps(), account.id);
    expect(gmail.calls.find((c) => c.op === "listHistory")!.args[0]).toMatchObject({ startHistoryId: cursor });
    expect(gmail.count("listMessages")).toBe(0);
    expect(gmail.count("watch")).toBe(1);
    expect((await stored()).sort()).toEqual(["i1", "n1"]);
    expect((await audits()).filter((a) => a.action === "mail.backfill_started")).toHaveLength(1);
    expect((await state()).lastError).toBeNull();

    // A second reauth transition is audited again.
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, account.id));
    await cron();
    expect((await audits()).filter((a) => a.action === "mail.sync_skipped_reauth")).toHaveLength(2);
  });

  it("disconnecting a reauth_required account skips users.stop and still cascades", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, account.id));
    gmail.calls = [];
    expect(await stopWatchBeforeDisconnect(database, await reloadAccount(), gmail)).toBe(false);
    expect(gmail.calls).toEqual([]);
    await database.delete(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id));
    for (const t of [schema.mailMessages, schema.mailThreads, schema.mailFetchQueue, schema.mailSyncState, schema.mailAttachments]) {
      expect(await database.select().from(t)).toEqual([]);
    }
  });

  // ---- 10. Audit hygiene across every lifecycle and error path (AC 16) --------------------------

  it("every mail.* audit row uses only content-free detail keys and contains no content, address or token", async () => {
    const SECRET_BITS = ["Top secret subject", "Secret Sender", "secret.sender@example.com", "Snippet ", "Body of", "work@example.com", "owner@example.com"];
    gmail.seed(msg("i1", "t1", ["INBOX", "UNREAD"], DAY, { subject: "Top secret subject", from: "Secret Sender <secret.sender@example.com>" }));
    gmail.failNext("watch", 400, "invalidArgument");
    await syncAfterConnect(deps(), account.id); // watch_failed, backfill_started
    await runUntilComplete(); // backfill_completed
    gmail.failNext("listHistory", 429, "rateLimitExceeded");
    await cron(); // sync_error
    gmail.historyId += 100;
    gmail.expiredBefore = BigInt(gmail.historyId);
    await runUntilComplete(); // resync
    await database.update(schema.mailSyncState).set({ watchExpiresAt: new Date(clock + 3600_000) }).where(eq(schema.mailSyncState.accountId, account.id));
    await cron(); // watch_renewed
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, account.id));
    await runCronSync(deps()); // sync_skipped_reauth
    await database.update(schema.connectedAccounts).set({ status: "active" }).where(eq(schema.connectedAccounts.id, account.id));
    gmail.failNext("stop", 500, "backendError");
    await stopWatchBeforeDisconnect(database, await reloadAccount(), gmail); // watch_failed {op: stop}
    await stopWatchBeforeDisconnect(database, await reloadAccount(), gmail); // watch_stopped

    const rows = await audits();
    const actions = new Set(rows.map((a) => a.action));
    for (const a of [
      "mail.watch_registered",
      "mail.watch_failed",
      "mail.backfill_started",
      "mail.backfill_completed",
      "mail.sync_error",
      "mail.resync",
      "mail.watch_renewed",
      "mail.sync_skipped_reauth",
      "mail.watch_stopped",
    ]) {
      if (a === "mail.watch_registered") continue; // first watch failed in this flow
      expect(actions, a).toContain(a);
    }
    const allowedKeys = new Set(["expiresAt", "after", "inbox", "sent", "reason", "status", "stage", "op"]);
    for (const row of rows) {
      for (const k of Object.keys((row.detail as Record<string, unknown> | null) ?? {})) expect(allowedKeys, `${row.action}.${k}`).toContain(k);
    }
    const all = JSON.stringify(rows);
    for (const bad of SECRET_BITS) expect(all).not.toContain(bad);
    const enc = (await reloadAccount()).accessTokenEnc;
    if (enc) expect(all).not.toContain(enc);
    // last_error and queue errors are content-free too.
    const s = await state();
    expect(JSON.stringify([s.lastError, ...(await queue()).map((q) => q.lastError)])).not.toMatch(/secret|example\.com/i);
  });

  // ---- 11. Deferral gives up when the thread never appears --------------------------------------

  it("a sent message whose only 'inbox' sibling is dropped (draft in a new thread) is dropped too, not retried forever", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    // A draft in a brand-new thread, then the draft is sent: the history-sourced draft row makes the thread "known".
    gmail.deliver(msg("draft1", "tNew", ["DRAFT"], 0));
    gmail.deliver(msg("sent1", "tNew", ["SENT"], 0));
    gmail.messages.delete("draft1");
    for (let i = 0; i < 10; i++) await cron();
    expect(await stored()).toEqual(["i1"]);
    expect(await queue()).toEqual([]);
    expect(await threadRow("tNew")).toBeUndefined();
  });

  it("a body-part message whose part data comes back empty is stored with an empty body, not incomplete", async () => {
    gmail.bodies.set("EMPTY", "");
    gmail.seed(msg("m1", "t1", ["INBOX"], DAY, { payload: { ...textPart("text/plain", "x"), body: { attachmentId: "EMPTY", size: 0 } } }));
    await runUntilComplete();
    const [m] = await database.select().from(schema.mailMessages);
    expect([m!.bodyText, m!.bodyIncomplete]).toEqual(["", false]);
  });

  it("parked rows (permanent 4xx after 5 attempts) don't block backfill completion and aren't counted", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    gmail.seed(msg("bad", "t2", ["INBOX"], 2 * DAY));
    const origFull = gmail.getMessageFull.bind(gmail);
    gmail.getMessageFull = async (id: string) => {
      if (id === "bad") throw new GmailApiError(400, "failedPrecondition", "messages.get");
      return origFull(id);
    };
    for (let i = 0; i < 12; i++) {
      await cron();
      clock += 2 * 60 * 60_000; // let backoff expire
    }
    expect(await stored()).toEqual(["i1"]);
    const s = await state();
    expect(s.backfillStatus).toBe("complete");
    const rows = await queue();
    expect(rows.map((r) => [r.gmailMessageId, r.attempts, r.nextAttemptAt.getTime()])).toEqual([["bad", 5, PARKED_AT.getTime()]]);
    expect(rows[0]!.lastError).toBe("400 failedPrecondition");
  });

  // ---- Round 2: try to break the D1 "wait while an inbox sibling is pending" logic ---------------

  /** Setup only (cursor + watch, listing not started), then mail is placed so the backfill lists it. */
  async function setupOnly() {
    await syncAfterConnect(deps({ budgetMs: 0 }), account.id);
    clock += 60_000;
  }

  /** Runs `n` cron passes with `stepMs` between them; returns the queue size after each. */
  async function runs(n: number, stepMs = 5 * 60_000) {
    const sizes: number[] = [];
    for (let i = 0; i < n; i++) {
      await syncAccount(deps(), await reloadAccount(), "cron");
      clock += stepMs;
      sizes.push((await queue()).length);
    }
    return sizes;
  }

  it("D1/parked sibling: the reply stops waiting once its inbox sibling is parked, and is dropped within the attempt limit", async () => {
    await setupOnly();
    gmail.seed(msg("i1", "tX", ["INBOX"], DAY));
    gmail.deliver(msg("r1", "tX", ["SENT"], 0));
    const orig = gmail.getMessageFull.bind(gmail);
    gmail.getMessageFull = async (id: string) => {
      if (id === "i1") throw new GmailApiError(400, "failedPrecondition", "messages.get");
      return orig(id);
    };
    await runs(30, 2 * 60 * 60_000);
    const rows = await queue();
    expect(rows.map((r) => r.gmailMessageId)).toEqual(["i1"]); // parked sibling only; r1 gone
    expect(rows[0]!.nextAttemptAt.getTime()).toBe(PARKED_AT.getTime());
    expect(await stored()).toEqual([]);
    expect((await state()).backfillStatus).toBe("complete");
  });

  it("D1/sibling 404: the sibling row is deleted, then the reply is dropped within the attempt limit", async () => {
    await setupOnly();
    gmail.seed(msg("i1", "tX", ["INBOX"], DAY));
    gmail.deliver(msg("r1", "tX", ["SENT"], 0));
    // i1 gets listed, then disappears from Gmail without a history record before it is fetched.
    const origList = gmail.listMessages.bind(gmail);
    gmail.listMessages = async (req) => {
      const res = await origList(req);
      gmail.messages.delete("i1");
      return res;
    };
    const sizes = await runs(15);
    expect(sizes.at(-1)).toBe(0);
    expect(await stored()).toEqual([]);
  });

  it("D1/sibling deleted through history: both rows go away, nothing loops", async () => {
    await setupOnly();
    gmail.seed(msg("i1", "tX", ["INBOX"], DAY));
    gmail.deliver(msg("r1", "tX", ["SENT"], 0));
    gmail.failNext("getMessageFull", 503, "backendError"); // first fetch attempt fails, so i1 is still queued
    await runs(1);
    gmail.deleteForever("i1");
    const sizes = await runs(15);
    expect(sizes.at(-1)).toBe(0);
    expect(await stored()).toEqual([]);
  });

  it("D1/thread never appears: a lone sent message in an unknown thread is dropped, with bounded Gmail calls", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.calls = [];
    gmail.deliver(msg("s1", "tNew", ["SENT"], 0));
    const sizes = await runs(10);
    expect(sizes.at(-1)).toBe(0);
    expect(await stored()).toEqual(["i1"]);
    expect(gmail.calls.filter((c) => c.args[0] === "s1").length).toBeLessThanOrEqual(5);
  });

  it("D1/several sent messages in a brand-new outbound thread (no inbox mail at all) are dropped, not left waiting on each other", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    // The owner starts a new conversation and sends a follow-up before the next sync.
    gmail.deliver(msg("s1", "tOut", ["SENT"], 2 * 60_000));
    gmail.deliver(msg("s2", "tOut", ["SENT"], 60_000));
    gmail.deliver(msg("s3", "tOut", ["SENT"], 0));
    const sizes = await runs(30);
    const left = (await queue()).map((q) => [q.gmailMessageId, q.attempts, q.lastError]);
    expect(await stored()).toEqual(["i1"]);
    expect(left, `queue sizes per run: ${sizes.join(",")}`).toEqual([]);
  });

  it("D1/many sent replies for one thread whose inbox message is still queued: all are stored once it is", async () => {
    gmail.listPageSize = 5;
    for (let i = 0; i < 29; i++) gmail.seed(msg(`i${i}`, `t${i}`, ["INBOX"], (i + 1) * 3600_000));
    gmail.seed(msg("iOld", "tOld", ["INBOX"], 20 * DAY));
    msPerCall = 50_000;
    await syncAfterConnect(deps(), account.id);
    clock += 5 * 60_000;
    for (let i = 0; i < 10 && ["listing_inbox", "listing_sent"].includes((await state()).backfillStatus); i++) await cron();
    for (let k = 0; k < 6; k++) gmail.deliver(msg(`r${k}`, "tOld", ["SENT"], 0));
    gmail.calls = [];
    await runUntilComplete(60);
    const ids = await stored();
    for (let k = 0; k < 6; k++) expect(ids).toContain(`r${k}`);
    expect((await threadRow("tOld"))!.messageCount).toBe(7);
    expect(await queue()).toEqual([]);
    // No per-wait Gmail calls: each reply costs a bounded handful (observed: 2 minimal + 1 full).
    for (let k = 0; k < 6; k++) {
      const ops = gmail.calls.filter((c) => c.args[0] === `r${k}`).map((c) => c.op);
      expect(ops.length, ops.join(",")).toBeLessThanOrEqual(3);
      expect(ops.filter((o) => o === "getMessageFull"), ops.join(",")).toHaveLength(1);
    }
  });

  it("D1/sibling stuck on 429 for a long time: the reply waits without losing attempts, then is stored", async () => {
    await setupOnly();
    gmail.seed(msg("i1", "tX", ["INBOX"], DAY));
    gmail.deliver(msg("r1", "tX", ["SENT"], 0));
    let throttled = true;
    const orig = gmail.getMessageFull.bind(gmail);
    gmail.getMessageFull = async (id: string) => {
      if (id === "i1" && throttled) throw new GmailApiError(429, "rateLimitExceeded", "messages.get");
      return orig(id);
    };
    await runs(12, 30 * 60_000);
    const r1 = (await queue()).find((q) => q.gmailMessageId === "r1");
    expect(r1, "reply still queued while the sibling is throttled").toBeDefined();
    expect(r1!.attempts).toBe(0);
    throttled = false;
    await runs(6, 2 * 60 * 60_000);
    expect((await stored()).sort()).toEqual(["i1", "r1"]);
  });

  it("D1/sent rows in an outbound-only thread are dropped within the attempt limit, and a later resync completes", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    gmail.seed(msg("s0", "tOut", ["SENT"], 3600_000)); // earlier message in an outbound-only thread (not known at backfill)
    await runUntilComplete();
    gmail.deliver(msg("s1", "tOut", ["SENT"], 60_000));
    gmail.deliver(msg("s2", "tOut", ["SENT"], 0));
    await runs(3);
    // Required (plan 6.6): no stored thread and no real inbox sibling, so both are dropped within the attempt limit.
    expect(await queue()).toEqual([]);
    // Later the history cursor expires.
    gmail.historyId += 100;
    gmail.expiredBefore = BigInt(gmail.historyId);
    await runs(30);
    const s = await state();
    expect([s.backfillStatus, s.resyncAfter], `queue: ${JSON.stringify((await queue()).map((q) => [q.gmailMessageId, q.source, q.attempts]))}`).toEqual([
      "complete",
      null,
    ]);
    expect(await queue()).toEqual([]);
    expect(await stored()).toEqual(["i1"]);
  });

  it("R3/a resync that starts while outbound-thread sent rows are still unclassified completes and drains", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    gmail.seed(msg("s0", "tOut", ["SENT"], 3600_000));
    await runUntilComplete();
    // s1/s2 land in history, and the cursor expires before Alex ever classifies them.
    gmail.deliver(msg("s1", "tOut", ["SENT"], 60_000));
    gmail.deliver(msg("s2", "tOut", ["SENT"], 0));
    await syncAccount(deps({ budgetMs: 0 }), await reloadAccount(), "cron"); // no work: just proves nothing is queued yet
    gmail.historyId += 100;
    gmail.expiredBefore = BigInt(gmail.historyId);
    const sizes = await runs(30);
    const s = await state();
    expect([s.backfillStatus, s.resyncAfter], `sizes ${sizes.join(",")}`).toEqual(["complete", null]);
    expect(await queue()).toEqual([]);
    expect(await stored()).toEqual(["i1"]);
  });

  // ---- Round 3: attack the "unknown labels still count" exception and the 24 h ceiling ----------

  it("R3/draft + several sent messages, all unclassified, in one new thread: everything drains", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.deliver(msg("d1", "tN", ["DRAFT"], 3 * 60_000));
    gmail.deliver(msg("s1", "tN", ["SENT"], 2 * 60_000));
    gmail.deliver(msg("d2", "tN", ["DRAFT"], 60_000));
    gmail.deliver(msg("s2", "tN", ["SENT"], 0));
    gmail.deliver(msg("s3", "tN", ["SENT"], 0));
    const sizes = await runs(10);
    expect(await queue(), `sizes ${sizes.join(",")}`).toEqual([]);
    expect(await stored()).toEqual(["i1"]);
  });

  it("R3/an unclassified row that keeps failing classification with 429 holds a sent sibling only until it recovers", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.deliver(msg("s1", "tN", ["SENT"], 60_000));
    gmail.deliver(msg("s2", "tN", ["SENT"], 0));
    let throttled = true;
    const orig = gmail.getMessageMinimal.bind(gmail);
    gmail.getMessageMinimal = async (id: string) => {
      if (id === "s1" && throttled) throw new GmailApiError(429, "rateLimitExceeded", "messages.get");
      return orig(id);
    };
    await runs(12, 30 * 60_000); // 6 h of throttling on s1
    throttled = false;
    const sizes = await runs(20, 30 * 60_000);
    expect(await queue(), `sizes ${sizes.join(",")}`).toEqual([]);
    expect(await stored()).toEqual(["i1"]);
  });

  it("R3/R4: a sent row waiting on a sibling that 5xx's forever is released only once the sibling is parked (bounded)", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.deliver(msg("x1", "tN", ["INBOX"], 60_000)); // a real inbox sibling, but Gmail never lets Alex fetch it
    gmail.deliver(msg("s1", "tN", ["SENT"], 0));
    const orig = gmail.getMessageMinimal.bind(gmail);
    gmail.getMessageMinimal = async (id: string) => {
      if (id === "x1") throw new GmailApiError(503, "backendError", "messages.get");
      return orig(id);
    };
    const start = clock;
    let goneAt: number | null = null;
    let parkedAt: number | null = null;
    for (let i = 0; i < 80 && goneAt === null; i++) {
      await syncAccount(deps(), await reloadAccount(), "cron");
      clock += 30 * 60_000;
      const rows = await queue();
      const x1 = rows.find((q) => q.gmailMessageId === "x1");
      if (parkedAt === null && x1 && x1.nextAttemptAt.getTime() === PARKED_AT.getTime()) parkedAt = clock;
      if (!rows.some((q) => q.gmailMessageId === "s1")) goneAt = clock;
    }
    // Bounded: the reply leaves the queue.
    expect(goneAt, "s1 still queued after 40 h").not.toBeNull();
    expect(goneAt! - start).toBeLessThanOrEqual(30 * 3600_000);
    // The reply must not be dropped while its inbox sibling is still genuinely pending (round-1 D1):
    // the sibling (O1: parked after MAX_TRANSIENT_ATTEMPTS) has to be parked first.
    expect(parkedAt, "x1 never parked").not.toBeNull();
    expect(goneAt!).toBeGreaterThanOrEqual(parkedAt!);
    const x1 = (await queue()).find((q) => q.gmailMessageId === "x1");
    expect(x1?.attempts).toBe(24);
    expect(await stored()).toEqual(["i1"]);
  });

  it("R3/R4 D7: a reply queued before a 5-day reauth outage mid-backfill is still stored after reconnect", async () => {
    gmail.listPageSize = 5;
    for (let i = 0; i < 29; i++) gmail.seed(msg(`i${i}`, `t${i}`, ["INBOX"], (i + 1) * 3600_000));
    gmail.seed(msg("iOld", "tOld", ["INBOX"], 20 * DAY));
    msPerCall = 50_000;
    await syncAfterConnect(deps(), account.id);
    clock += 5 * 60_000;
    for (let i = 0; i < 10 && ["listing_inbox", "listing_sent"].includes((await state()).backfillStatus); i++) await cron();
    gmail.deliver(msg("r1", "tOld", ["SENT"], 0));
    await cron();
    await cron();
    const before = (await queue()).find((q) => q.gmailMessageId === "r1")!;
    expect(before.attempts).toBe(0);
    expect(before.deferredAt).not.toBeNull();
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, account.id));
    for (let i = 0; i < 60; i++) {
      await cron(); // every cron skips the account; deferrals must not be counted
      clock += 2 * 3600_000; // 60 x 2 h = 5 days
    }
    const during = (await queue()).find((q) => q.gmailMessageId === "r1")!;
    expect([during.attempts, during.deferCount]).toEqual([before.attempts, before.deferCount]);
    await database.update(schema.connectedAccounts).set({ status: "active" }).where(eq(schema.connectedAccounts.id, account.id));
    await runUntilComplete(60);
    expect(await queue()).toEqual([]);
    expect(await stored()).toContain("iOld");
    expect(await stored()).toContain("r1");
  });

  it("R3/R4 O1: backfill completes even when an inbox sibling 5xx's forever; the waiting backfill_sent row is released", async () => {
    await setupOnly();
    gmail.seed(msg("i1", "t1", ["INBOX"], 2 * DAY));
    gmail.seed(msg("x1", "tX", ["INBOX"], DAY));
    gmail.seed(msg("s0", "tX", ["SENT"], DAY / 2));
    const orig = gmail.getMessageFull.bind(gmail);
    gmail.getMessageFull = async (id: string) => {
      if (id === "x1") throw new GmailApiError(503, "backendError", "messages.get");
      return orig(id);
    };
    await syncAccount(deps(), await reloadAccount(), "cron");
    clock += 30 * 60_000;
    expect((await queue()).find((q) => q.gmailMessageId === "s0")?.source, "precondition: s0 listed as backfill_sent").toBe("backfill_sent");
    for (let i = 0; i < 100 && (await state()).backfillStatus !== "complete"; i++) {
      await syncAccount(deps(), await reloadAccount(), "cron");
      clock += 30 * 60_000;
    }
    expect((await state()).backfillStatus).toBe("complete");
    const rows = await queue();
    expect(rows.map((r) => [r.gmailMessageId, r.attempts, r.nextAttemptAt.getTime()])).toEqual([["x1", MAX_TRANSIENT_ATTEMPTS, PARKED_AT.getTime()]]);
    expect(await stored()).toEqual(["i1"]);
    expect((await audits()).filter((a) => a.action === "mail.backfill_completed")).toHaveLength(1);
  });

  it("R4 O1: after the failing row parks, mail.sync_error audits stop and last_error clears", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.deliver(msg("x1", "tX", ["INBOX"], 0));
    const orig = gmail.getMessageFull.bind(gmail);
    gmail.getMessageFull = async (id: string) => {
      if (id === "x1") throw new GmailApiError(500, "backendError", "messages.get");
      return orig(id);
    };
    let parked = false;
    for (let i = 0; i < 80 && !parked; i++) {
      await syncAccount(deps(), await reloadAccount(), "cron");
      clock += 60 * 60_000;
      const x1 = (await queue()).find((q) => q.gmailMessageId === "x1");
      parked = !!x1 && x1.nextAttemptAt.getTime() === PARKED_AT.getTime();
    }
    expect(parked, "x1 never parked").toBe(true);
    await syncAccount(deps(), await reloadAccount(), "cron"); // first clean run after parking
    clock += 60 * 60_000;
    const errsAfterPark = (await audits()).filter((a) => a.action === "mail.sync_error").length;
    for (let i = 0; i < 10; i++) {
      await syncAccount(deps(), await reloadAccount(), "cron");
      clock += 60 * 60_000;
    }
    expect((await audits()).filter((a) => a.action === "mail.sync_error").length).toBe(errsAfterPark);
    expect((await state()).lastError).toBeNull();
    expect((await state()).consecutiveFailures).toBe(0);
    gmail.deliver(msg("n1", "tY", ["INBOX"], 0));
    await syncAccount(deps(), await reloadAccount(), "cron");
    expect(await stored()).toContain("n1");
  });

  it("R4 O1: a few hours of 5xx on one message still recovers (not parked)", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.deliver(msg("x1", "tX", ["INBOX"], 0));
    let failing = true;
    const orig = gmail.getMessageFull.bind(gmail);
    gmail.getMessageFull = async (id: string) => {
      if (id === "x1" && failing) throw new GmailApiError(503, "backendError", "messages.get");
      return orig(id);
    };
    await runs(12, 30 * 60_000); // 6 h
    const x1 = (await queue()).find((q) => q.gmailMessageId === "x1")!;
    expect(x1.nextAttemptAt.getTime()).toBeLessThan(PARKED_AT.getTime());
    expect(x1.attempts).toBeLessThan(MAX_TRANSIENT_ATTEMPTS);
    failing = false;
    await runs(4, 2 * 3600_000);
    expect(await stored()).toContain("x1");
  });

  it("R4 D7 ceiling: a reply whose sibling stays pending forever (never due, never parked) is bounded by MAX_DEFERRALS", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.deliver(msg("x1", "tX", ["INBOX"], 60_000));
    gmail.deliver(msg("s1", "tX", ["SENT"], 0));
    // Enqueue both via history without hydrating, then hold x1 pending forever (due in year 3000, not parked).
    gmail.failNext("getMessageMinimal", 503, "backendError"); // x1 (first in queue) fails, stopping the run before s1
    await syncAccount(deps(), await reloadAccount(), "cron");
    expect((await queue()).map((q) => q.gmailMessageId).sort(), "precondition").toEqual(["s1", "x1"]);
    await database
      .update(schema.mailFetchQueue)
      .set({ nextAttemptAt: new Date("3000-01-01T00:00:00Z") })
      .where(eq(schema.mailFetchQueue.gmailMessageId, "x1"));
    await cron();
    const s1 = (await queue()).find((q) => q.gmailMessageId === "s1")!;
    expect([s1.attempts, s1.deferCount > 0]).toEqual([0, true]);
    await database.update(schema.mailFetchQueue).set({ deferCount: MAX_DEFERRALS - 2 }).where(eq(schema.mailFetchQueue.gmailMessageId, "s1"));
    const present: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      await cron();
      present.push((await queue()).some((q) => q.gmailMessageId === "s1"));
      if (!present.at(-1)) break;
    }
    expect(present.at(-1), `s1 present per run: ${present.join(",")}`).toBe(false);
    expect(present.length).toBeLessThanOrEqual(10);
  });

  it("R4 N1: pushes within the debounce window schedule one sync; a steady stream still schedules; the cron picks up mail", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    const scheduled: string[] = [];
    const body = (h: number) => JSON.stringify({ message: { data: b64url(JSON.stringify({ emailAddress: "work@example.com", historyId: String(h) })) } });
    const push = (h: number) =>
      handlePush(
        { authorization: "Bearer x", body: body(h) },
        { audience: "a", serviceAccount: "s" },
        { db: database, verify: async () => ({ ok: true }), schedule: (id) => scheduled.push(id), now: () => new Date(clock) },
      );
    for (let i = 0; i < 20; i++) {
      expect(await push(5000 + i)).toBe(204);
      clock += 200; // 20 pushes over 4 s
    }
    expect(scheduled).toHaveLength(1);
    expect((await state()).lastPushHistoryId).toBe("5019");
    clock += 6_000;
    await push(6000);
    expect(scheduled).toHaveLength(2);
    for (let i = 0; i < 30; i++) {
      await push(7000 + i);
      clock += 1_000; // one push per second for 30 s
    }
    expect(scheduled.length).toBeGreaterThanOrEqual(2 + 5);
    gmail.deliver(msg("n1", "t2", ["INBOX"], 0));
    await push(8000);
    await cron();
    expect(await stored()).toContain("n1");
  });

  it("R4 N2: odd or path-changing Gmail ids never reach a URL; through the engine such a row parks", async () => {
    const urls: string[] = [];
    const real = createGmailClient(
      async () => "tok",
      async (input: string) => {
        urls.push(input);
        return new Response("{}", { status: 200 });
      },
    );
    const bads = ["..", ".", "a/b", "a%2Fb", "", "a b", "a\nb", "é", "a?x", "a#x", "a\\b", "a".repeat(257)];
    for (const bad of bads) {
      await expect(real.getMessageFull(bad), JSON.stringify(bad)).rejects.toBeInstanceOf(GmailShapeError);
      await expect(real.getMessageMinimal(bad)).rejects.toBeInstanceOf(GmailShapeError);
      await expect(real.getBodyPartData(bad, "att")).rejects.toBeInstanceOf(GmailShapeError);
    }
    for (const bad of ["..", "a/b", "a%2F", "", "a".repeat(4097)]) {
      await expect(real.getBodyPartData("okid", bad), JSON.stringify(bad)).rejects.toBeInstanceOf(GmailShapeError);
    }
    expect(urls).toEqual([]);

    // Engine: an id like "../profile" arriving in history is queued but parks without crashing the account.
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    const ids = new Set<string>();
    const wrapped: GmailClient = {
      ...gmail,
      getProfile: () => gmail.getProfile(),
      watch: (r) => gmail.watch(r),
      stop: () => gmail.stop(),
      listMessages: (r) => gmail.listMessages(r),
      getBodyPartData: (m, a) => gmail.getBodyPartData(m, a),
      listHistory: async () => ({ history: [{ id: "1", messagesAdded: [{ message: { id: "../profile", threadId: "t9" } }] }], historyId: String(gmail.historyId) }),
      getMessageMinimal: async (id) => {
        ids.add(id);
        return real.getMessageMinimal(id);
      },
      getMessageFull: async (id) => {
        ids.add(id);
        return real.getMessageFull(id);
      },
    };
    for (let i = 0; i < 8; i++) {
      const r = await syncAccount(deps({ gmailFor: () => wrapped }), await reloadAccount(), "cron");
      expect(r.outcome).toBe("ok");
      clock += 2 * 3600_000;
    }
    expect(urls).toEqual([]);
    const row = (await queue()).find((q) => q.gmailMessageId === "../profile")!;
    expect(row.nextAttemptAt.getTime()).toBe(PARKED_AT.getTime());
    expect(row.lastError).toMatch(/unexpected_shape|Gmail messages\.get returned an unexpected response shape/);
  });

  it("R4: a users.stop that never settles is abandoned within the timeout, audited, and the cascade still runs", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    const hanging = { ...gmail, stop: () => new Promise<void>(() => {}) } as unknown as GmailClient;
    const t0 = Date.now();
    expect(await stopWatchBeforeDisconnect(database, await reloadAccount(), hanging, 300)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
    const failed = (await audits()).filter((a) => a.action === "mail.watch_failed").at(-1);
    expect(failed?.detail).toEqual({ op: "stop", status: null, reason: "timeout" });
    await database.delete(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id));
    expect(await database.select().from(schema.mailMessages)).toEqual([]);
  });
});
