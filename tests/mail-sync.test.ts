import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { and, asc, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { ReauthRequiredError } from "@/lib/accounts";
import { GmailApiError, type GmailClient } from "@/lib/gmail/client";
import { handlePush, PUSH_DEBOUNCE_MS } from "@/lib/gmail/push";
import { acquireLease, getSyncState, listInboxThreads, PARKED_AT } from "@/lib/gmail/store";
import {
  MAX_DEFERRALS,
  MAX_TRANSIENT_ATTEMPTS,
  runCronSync,
  runWatchRenewal,
  stopWatchBeforeDisconnect,
  syncAccount,
  syncAfterConnect,
  syncAfterPush,
  type SyncDeps,
} from "@/lib/gmail/sync";
import { b64url, FakeGmail, textPart, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

const DAY = 86400_000;
const TOPIC = "projects/test-project/topics/gmail-push";

describe.skipIf(!testDbUrl)("mail sync flows (Postgres + fake Gmail)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  /** Milliseconds each Gmail call advances the clock (to exercise the run budget). */
  let msPerCall: number;

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

  const msg = (id: string, threadId: string, labels: string[], ageMs: number, extra: Partial<FakeMessage> = {}): FakeMessage => ({
    id,
    threadId,
    labelIds: labels,
    internalDate: clock - ageMs,
    ...extra,
  });

  /** Runs cron passes until the backfill is complete (or `max` runs). */
  async function runUntilComplete(max = 10) {
    for (let i = 0; i < max; i++) {
      await syncAccount(deps(), await reloadAccount(), "cron");
      if ((await state()).backfillStatus === "complete" && (await queue()).length === 0) return i + 1;
      clock += 5 * 60_000;
    }
    return max;
  }

  it("setup stores the profile cursor before listing, registers the INBOX watch and starts the backfill", async () => {
    gmail.seed(msg("a1", "ta", ["INBOX", "UNREAD"], 2 * DAY));
    await syncAfterConnect(deps(), account.id);
    const ops = gmail.calls.map((c) => c.op);
    expect(ops.indexOf("getProfile")).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf("getProfile")).toBeLessThan(ops.indexOf("listMessages"));
    const watch = gmail.calls.find((c) => c.op === "watch")!;
    expect(watch.args[0]).toEqual({ topicName: TOPIC, labelIds: ["INBOX"], labelFilterBehavior: "include" });
    const s = await state();
    expect(s.historyId).toBe("1000");
    expect(s.watchExpiresAt).not.toBeNull();
    expect(s.watchTopic).toBe(TOPIC);
    expect(s.backfillAfter!.getTime()).toBe(clock - 30 * DAY);
    const actions = (await audits()).map((a) => a.action);
    expect(actions.slice(0, 2)).toEqual(["mail.watch_registered", "mail.backfill_started"]);
  });

  it("without a topic, setup runs polling-only and records why", async () => {
    await syncAfterConnect(deps({ topic: undefined }), account.id);
    expect(gmail.count("watch")).toBe(0);
    const failed = (await audits()).find((a) => a.action === "mail.watch_failed");
    expect(failed?.detail).toEqual({ reason: "topic_not_configured" });
  });

  it("two-phase backfill over several runs: INBOX, then SENT for known threads only, then complete", async () => {
    gmail.listPageSize = 2;
    msPerCall = 50_000; // ~5 Gmail calls per 240 s budget
    gmail.seed(msg("i1", "t1", ["INBOX", "UNREAD"], 1 * DAY));
    gmail.seed(msg("i2", "t1", ["INBOX"], 2 * DAY));
    gmail.seed(msg("i3", "t2", ["INBOX"], 3 * DAY));
    gmail.seed(msg("i4", "t3", ["INBOX", "CATEGORY_UPDATES"], 4 * DAY));
    gmail.seed(msg("i5", "t4", ["INBOX"], 5 * DAY));
    gmail.seed(msg("old", "t5", ["INBOX"], 40 * DAY)); // outside the window
    gmail.seed(msg("s1", "t2", ["SENT"], 2.5 * DAY)); // reply in a known thread
    gmail.seed(msg("s2", "t9", ["SENT"], 1 * DAY)); // thread Alex doesn't know
    gmail.seed(msg("d1", "t2", ["DRAFT"], 1 * DAY));

    const runs = await runUntilComplete();
    expect(runs).toBeGreaterThanOrEqual(3);

    const ids = await stored();
    expect(ids.sort()).toEqual(["i1", "i2", "i3", "i4", "i5", "s1"]);
    for (const c of gmail.calls.filter((c) => c.op === "listMessages")) {
      const q = (c.args[0] as { q: string }).q;
      expect(q).toMatch(/^after:\d+$/);
    }
    const listed = gmail.calls.filter((c) => c.op === "listMessages").map((c) => (c.args[0] as { labelIds: string[] }).labelIds[0]);
    expect(listed.indexOf("SENT")).toBeGreaterThan(listed.lastIndexOf("INBOX"));
    expect(gmail.calls.filter((c) => c.op === "getMessageFull").map((c) => c.args[0])).not.toContain("s2");

    const s = await state();
    expect(s.backfillStatus).toBe("complete");
    expect(s.backfillCompletedAt).not.toBeNull();
    const completed = (await audits()).filter((a) => a.action === "mail.backfill_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.detail).toEqual({ inbox: 5, sent: 1 });

    const inbox = await listInboxThreads(database, userId, { limit: 10 });
    expect(inbox.map((t) => t.messageCount).reduce((a, b) => a + b, 0)).toBe(6);
    const t2 = await database.select().from(schema.mailThreads).where(eq(schema.mailThreads.gmailThreadId, "t2"));
    expect(t2[0]!.messageCount).toBe(2);
  });

  it("a push during backfill is deduped against the listing; the notification's historyId never becomes the cursor", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    msPerCall = 120_000; // setup only gets a couple of calls in
    await syncAfterConnect(deps(), account.id);
    expect((await state()).backfillStatus).not.toBe("complete");

    gmail.deliver(msg("new1", "t7", ["INBOX", "UNREAD"], 0));
    const scheduled: string[] = [];
    const body = JSON.stringify({ message: { data: b64url(JSON.stringify({ emailAddress: "Work@Example.com", historyId: 999999999 })) } });
    const status = await handlePush(
      { authorization: "Bearer test", body },
      { audience: "aud", serviceAccount: "sa" },
      { db: database, verify: async () => ({ ok: true }), schedule: (id) => scheduled.push(id), now: () => new Date(clock) },
    );
    expect(status).toBe(204);
    expect(scheduled).toEqual([account.id]);
    expect((await state()).lastPushHistoryId).toBe("999999999");

    msPerCall = 0;
    await syncAfterPush(deps(), account.id);
    expect(await stored()).toContain("new1");
    expect((await state()).historyId).not.toBe("999999999");

    await runUntilComplete();
    const ids = await stored();
    expect(ids.filter((x) => x === "new1")).toHaveLength(1);
    expect(ids.sort()).toEqual(["i1", "new1"]);
  });

  it("push: unknown or inactive account, or no cursor yet, gets 204 and no sync", async () => {
    const body = (email: string) => JSON.stringify({ message: { data: b64url(JSON.stringify({ emailAddress: email, historyId: 5 })) } });
    const scheduled: string[] = [];
    const pushDeps = { db: database, verify: async () => ({ ok: true as const }), schedule: (id: string) => scheduled.push(id) };
    const cfg = { audience: "aud", serviceAccount: "sa" };
    expect(await handlePush({ authorization: "x", body: body("nobody@example.com") }, cfg, pushDeps)).toBe(204);
    expect(await handlePush({ authorization: "x", body: body("work@example.com") }, cfg, pushDeps)).toBe(204); // no state yet
    await syncAfterConnect(deps(), account.id);
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, account.id));
    expect(await handlePush({ authorization: "x", body: body("work@example.com") }, cfg, pushDeps)).toBe(204);
    expect(scheduled).toEqual([]);
    const before = gmail.calls.length;
    expect((await syncAfterPush(deps(), account.id))!.outcome).toBe("skipped_reauth");
    expect(gmail.calls.length).toBe(before);
  });

  it("a sent reply arriving through history (labels absent) is classified with one minimal get, then stored", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.calls = [];
    gmail.deliver(msg("r1", "t1", ["SENT"], 0, { inReplyTo: "<i1@mail.example.com>" }));
    gmail.deliver(msg("r2", "t-unknown", ["SENT"], 0));
    await syncAccount(deps(), await reloadAccount(), "cron");
    const r1Ops = gmail.calls.filter((c) => c.args[0] === "r1").map((c) => c.op);
    expect(r1Ops).toEqual(["getMessageMinimal", "getMessageFull"]);
    expect(gmail.calls.filter((c) => c.args[0] === "r2").map((c) => c.op)).toEqual(["getMessageMinimal"]);
    expect((await stored()).sort()).toEqual(["i1", "r1"]);
    const [r1] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "r1"));
    expect(r1!.isSent).toBe(true);
    expect(r1!.inReplyTo).toBe("<i1@mail.example.com>");
  });

  it("defers a sent message whose thread's inbox message is still queued, then stores it", async () => {
    await syncAfterConnect(deps({ budgetMs: 0 }), account.id); // setup only
    gmail.seed(msg("i1", "tT", ["INBOX"], DAY)); // will be listed by the backfill
    gmail.deliver(msg("r1", "tT", ["SENT"], 0)); // arrives through history first
    await syncAccount(deps(), await reloadAccount(), "cron");
    const r1Row = (await queue()).find((q) => q.gmailMessageId === "r1");
    // Deferred while i1 was still queued: waiting doesn't use up an attempt (round 2, D1).
    expect(r1Row?.deferredAt).not.toBeNull();
    expect(r1Row?.deferCount).toBe(1);
    expect(r1Row?.lastError).toBeNull(); // deferral state lives in its own columns (round 4)
    expect(r1Row?.attempts).toBe(0);
    expect(await stored()).toEqual(["i1"]);
    clock += 61_000;
    await syncAccount(deps(), await reloadAccount(), "cron");
    expect((await stored()).sort()).toEqual(["i1", "r1"]);
  });

  it("a deferred sent message waiting on a queued inbox sibling makes no Gmail calls while it waits", async () => {
    await syncAfterConnect(deps({ budgetMs: 0 }), account.id);
    gmail.deliver(msg("r1", "tW", ["SENT"], 0));
    // The inbox sibling is queued but keeps failing transiently, so it stays pending.
    await database.insert(schema.mailFetchQueue).values({
      userId,
      accountId: account.id,
      gmailMessageId: "i1",
      gmailThreadId: "tW",
      source: "backfill_inbox",
      needsClassify: false,
      nextAttemptAt: new Date(clock + 365 * DAY),
    });
    await syncAccount(deps(), await reloadAccount(), "cron"); // classify r1, defer
    gmail.calls = [];
    for (let i = 0; i < 8; i++) {
      clock += 61_000;
      await syncAccount(deps(), await reloadAccount(), "cron");
    }
    expect(gmail.calls.filter((c) => c.args[0] === "r1")).toEqual([]);
    const r1Row = (await queue()).find((q) => q.gmailMessageId === "r1");
    expect(r1Row).toMatchObject({ attempts: 0 });
    expect(r1Row!.deferCount).toBeGreaterThanOrEqual(8);
  });

  async function waitingReplyWithPendingSibling(threadId: string) {
    await syncAfterConnect(deps({ budgetMs: 0 }), account.id);
    gmail.deliver(msg("r1", threadId, ["SENT"], 0));
    await database.insert(schema.mailFetchQueue).values({
      userId,
      accountId: account.id,
      gmailMessageId: "i1",
      gmailThreadId: threadId,
      source: "backfill_inbox",
      needsClassify: false,
      nextAttemptAt: new Date(clock + 365 * DAY), // pending (not parked) for a year
    });
    await syncAccount(deps(), await reloadAccount(), "cron");
    expect((await queue()).find((q) => q.gmailMessageId === "r1")).toMatchObject({ attempts: 0, deferCount: 1 });
  }

  it("backstop: after MAX_DEFERRALS deferrals, a waiting sent message uses up attempts even if its sibling is still pending", async () => {
    await waitingReplyWithPendingSibling("tW");
    await database
      .update(schema.mailFetchQueue)
      .set({ deferCount: MAX_DEFERRALS })
      .where(eq(schema.mailFetchQueue.gmailMessageId, "r1"));
    for (let i = 0; i < 6; i++) {
      clock += 61_000;
      await syncAccount(deps(), await reloadAccount(), "cron");
    }
    expect((await queue()).find((q) => q.gmailMessageId === "r1")).toBeUndefined();
  });

  it("D7: a long outage (no sync runs for 3 days, e.g. reauth) doesn't use up the wait; the reply is still stored", async () => {
    await waitingReplyWithPendingSibling("tR");
    gmail.seed(msg("i1", "tR", ["INBOX"], DAY));
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, account.id));
    for (let i = 0; i < 3; i++) {
      clock += DAY;
      await syncAccount(deps(), await reloadAccount(), "cron"); // skipped: no hydration, no deferrals
    }
    expect((await queue()).find((q) => q.gmailMessageId === "r1")).toMatchObject({ attempts: 0, deferCount: 1 });
    await database.update(schema.connectedAccounts).set({ status: "active" }).where(eq(schema.connectedAccounts.id, account.id));
    await database.update(schema.mailFetchQueue).set({ nextAttemptAt: new Date(clock) }).where(eq(schema.mailFetchQueue.gmailMessageId, "i1"));
    await runUntilComplete();
    expect((await stored()).sort()).toEqual(["i1", "r1"]);
  });

  it("O1: an inbox row failing with 5xx forever is parked after MAX_TRANSIENT_ATTEMPTS, so the backfill completes", async () => {
    gmail.seed(msg("good", "tg", ["INBOX"], DAY));
    gmail.seed(msg("bad", "tb", ["INBOX"], DAY));
    const orig = gmail.getMessageFull.bind(gmail);
    gmail.getMessageFull = async (id: string) => {
      if (id === "bad") throw new GmailApiError(503, "backendError", "messages.get");
      return orig(id);
    };
    for (let i = 0; i < MAX_TRANSIENT_ATTEMPTS + 10; i++) {
      await syncAccount(deps(), await reloadAccount(), "cron");
      clock += 2 * 3600_000; // past the 1 h backoff cap
      if ((await state()).backfillStatus === "complete") break;
    }
    const s = await state();
    expect(s.backfillStatus).toBe("complete");
    const bad = (await queue()).find((q) => q.gmailMessageId === "bad")!;
    expect(bad.attempts).toBe(MAX_TRANSIENT_ATTEMPTS);
    expect(bad.nextAttemptAt.getTime()).toBe(PARKED_AT.getTime());
    expect(await stored()).toEqual(["good"]);
    const errs = (await audits()).filter((a) => a.action === "mail.sync_error");
    expect(errs.length).toBeLessThanOrEqual(MAX_TRANSIENT_ATTEMPTS);
    // Once parked, further runs add no more sync_error audits.
    for (let i = 0; i < 5; i++) {
      await syncAccount(deps(), await reloadAccount(), "cron");
      clock += 2 * 3600_000;
    }
    expect((await audits()).filter((a) => a.action === "mail.sync_error")).toHaveLength(errs.length);
  });

  it("O1: a short outage still recovers (backoff, no parking)", async () => {
    gmail.seed(msg("m1", "t1", ["INBOX"], DAY));
    await syncAfterConnect(deps({ budgetMs: 0 }), account.id);
    for (let i = 0; i < 3; i++) gmail.failNext("getMessageFull", 503, "backendError");
    for (let i = 0; i < 6; i++) {
      await syncAccount(deps(), await reloadAccount(), "cron");
      clock += 2 * 3600_000;
    }
    expect(await stored()).toEqual(["m1"]);
  });

  it("N1: push-triggered syncs are debounced per account", async () => {
    await syncAfterConnect(deps(), account.id);
    const scheduled: string[] = [];
    const body = (h: number) => JSON.stringify({ message: { data: b64url(JSON.stringify({ emailAddress: "work@example.com", historyId: h })) } });
    const push = (h: number) =>
      handlePush(
        { authorization: "x", body: body(h) },
        { audience: "aud", serviceAccount: "sa" },
        { db: database, verify: async () => ({ ok: true }), schedule: (id) => scheduled.push(id), now: () => new Date(clock) },
      );
    expect(await push(1)).toBe(204);
    clock += 1000;
    expect(await push(2)).toBe(204);
    clock += 1000;
    expect(await push(3)).toBe(204);
    expect(scheduled).toHaveLength(1);
    expect((await state()).lastPushHistoryId).toBe("3");
    clock += PUSH_DEBOUNCE_MS;
    await push(4);
    expect(scheduled).toHaveLength(2);
  });

  it("disconnect: users.stop that hangs is abandoned after the timeout and reported as failed", async () => {
    await syncAfterConnect(deps(), account.id);
    const hanging = { ...gmail, stop: () => new Promise<void>(() => {}) } as unknown as GmailClient;
    const started = Date.now();
    expect(await stopWatchBeforeDisconnect(database, await reloadAccount(), hanging, 200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
    const failed = (await audits()).filter((a) => a.action === "mail.watch_failed").at(-1);
    expect(failed?.detail).toEqual({ op: "stop", status: null, reason: "timeout" });
  });

  it("a deferred sent message is dropped after the attempt limit once no inbox sibling is pending", async () => {
    await syncAfterConnect(deps({ budgetMs: 0 }), account.id);
    gmail.deliver(msg("r1", "tGone", ["SENT"], 0));
    // A parked sibling (permanent failures) will never be stored, so it doesn't keep r1 waiting.
    await database.insert(schema.mailFetchQueue).values({
      userId,
      accountId: account.id,
      gmailMessageId: "i1",
      gmailThreadId: "tGone",
      source: "backfill_inbox",
      needsClassify: false,
      attempts: 5,
      nextAttemptAt: new Date("9999-12-31T00:00:00Z"),
    });
    for (let i = 0; i < 10; i++) {
      await syncAccount(deps(), await reloadAccount(), "cron");
      clock += 61_000;
    }
    expect((await queue()).find((q) => q.gmailMessageId === "r1")).toBeUndefined();
    expect(await stored()).toEqual([]);
  });

  it("archive, read and delete in Gmail are reflected without any message fetch", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX", "UNREAD"], DAY));
    gmail.seed(msg("i2", "t2", ["INBOX", "UNREAD"], DAY));
    await runUntilComplete();
    gmail.calls = [];
    gmail.removeLabels("i1", ["UNREAD"]);
    gmail.removeLabels("i2", ["INBOX"]);
    await syncAccount(deps(), await reloadAccount(), "cron");
    let threads = await database.select().from(schema.mailThreads).orderBy(asc(schema.mailThreads.gmailThreadId));
    expect(threads.map((t) => [t.gmailThreadId, t.inInbox, t.hasUnread])).toEqual([
      ["t1", true, false],
      ["t2", false, false], // UNREAD without INBOX doesn't count as unread in the inbox
    ]);
    expect((await listInboxThreads(database, userId, { limit: 10 })).map((t) => t.messageCount)).toHaveLength(1);

    gmail.addLabels("i2", ["INBOX"]); // unarchive
    gmail.deleteForever("i1");
    await syncAccount(deps(), await reloadAccount(), "cron");
    threads = await database.select().from(schema.mailThreads);
    expect(threads.map((t) => [t.gmailThreadId, t.inInbox])).toEqual([["t2", true]]);
    expect(await stored()).toEqual(["i2"]);
    expect(gmail.calls.filter((c) => c.op === "getMessageFull" || c.op === "getMessageMinimal")).toEqual([]);
  });

  it("adding INBOX to an unstored message ingests it", async () => {
    await runUntilComplete();
    gmail.seed(msg("arch", "tA", ["CATEGORY_UPDATES"], DAY)); // archived, never listed
    gmail.addLabels("arch", ["INBOX"]);
    await syncAccount(deps(), await reloadAccount(), "cron");
    expect(await stored()).toEqual(["arch"]);
  });

  it("draft replacements are classified and dropped, never stored", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    gmail.calls = [];
    gmail.deliver(msg("d1", "t1", ["DRAFT"], 0));
    await syncAccount(deps(), await reloadAccount(), "cron");
    gmail.deleteForever("d1"); // draft updated: old message destroyed...
    gmail.deliver(msg("d2", "t1", ["DRAFT"], 0)); // ...and replaced
    await syncAccount(deps(), await reloadAccount(), "cron");
    expect(await stored()).toEqual(["i1"]);
    expect(gmail.count("getMessageFull")).toBe(0);
    expect(gmail.count("getMessageMinimal")).toBe(2);
    expect(await queue()).toEqual([]);

    // With labels present in history, drafts cost nothing.
    gmail.historyLabels = true;
    gmail.calls = [];
    gmail.deliver(msg("d3", "t1", ["DRAFT"], 0));
    await syncAccount(deps(), await reloadAccount(), "cron");
    expect(gmail.count("getMessageMinimal")).toBe(0);
  });

  it("an expired cursor (404) triggers a bounded resync with label refresh and no duplicates", async () => {
    // The resync window is max(last_history_sync_at - 1 day, now - 30 days) (plan 6.5, 13b-2).
    gmail.seed(msg("i1", "t1", ["INBOX"], 3600_000));
    gmail.seed(msg("i2", "t2", ["INBOX"], 3600_000));
    gmail.seed(msg("i3", "t3", ["INBOX"], 3600_000));
    gmail.seed(msg("old", "t0", ["INBOX"], 5 * DAY)); // outside the resync window
    await runUntilComplete();
    const oldCursor = (await state()).historyId!;

    // Changes Alex never hears about through history:
    gmail.silentlySetLabels("i1", []); // archived
    gmail.messages.delete("i2"); // deleted
    gmail.silentlySetLabels("old", []); // archived, but older than the window
    gmail.seed(msg("n1", "t4", ["INBOX"], 60_000)); // new mail
    gmail.historyId += 50;
    gmail.expiredBefore = BigInt(gmail.historyId);
    gmail.calls = [];

    await runUntilComplete();
    const s = await state();
    expect(BigInt(s.historyId!)).toBeGreaterThan(BigInt(oldCursor));
    expect(s.resyncAfter).toBeNull();
    expect(s.backfillStatus).toBe("complete");
    expect((await stored()).sort()).toEqual(["i1", "i3", "n1", "old"]);
    const inbox = await listInboxThreads(database, userId, { limit: 10 });
    // i1's archive is picked up by the label refresh; "old" keeps its last-known labels (R11).
    expect(inbox.map((t) => t.subject).sort()).toEqual(["Subject i3", "Subject n1", "Subject old"]);
    expect(gmail.calls.filter((c) => c.op === "getMessageMinimal").map((c) => c.args[0]).sort()).toEqual(["i1", "i2", "i3"]);
    expect(gmail.calls.filter((c) => c.op === "getMessageFull").map((c) => c.args[0])).toEqual(["n1"]);
    const resync = (await audits()).filter((a) => a.action === "mail.resync");
    expect(resync).toHaveLength(1);
    expect(resync[0]!.detail).toMatchObject({ reason: "history_expired" });
    expect((await audits()).filter((a) => a.action === "mail.backfill_completed")).toHaveLength(1);
  });

  it("history is applied page by page; the cursor only moves after the last page", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    const cursor = (await state()).historyId;
    gmail.historyPageSize = 1;
    gmail.deliver(msg("n1", "t2", ["INBOX"], 0));
    gmail.deliver(msg("n2", "t3", ["INBOX"], 0));
    gmail.calls = [];
    let n = 0;
    const orig = gmail.listHistory.bind(gmail);
    gmail.listHistory = async (req) => {
      n += 1;
      if (n === 2) throw new GmailApiError(500, "backendError", "history.list");
      return orig(req);
    };
    const res = await syncAccount(deps(), await reloadAccount(), "cron");
    expect(res.outcome).toBe("error");
    expect((await state()).historyId).toBe(cursor);
    expect((await state()).lastError).toBe("history: 500 backendError");
    gmail.listHistory = orig;
    await syncAccount(deps(), await reloadAccount(), "cron");
    expect((await state()).historyId).toBe(String(gmail.historyId));
    expect((await state()).lastError).toBeNull();
    expect((await stored()).sort()).toEqual(["i1", "n1", "n2"]);
    const errs = (await audits()).filter((a) => a.action === "mail.sync_error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.detail).toEqual({ stage: "history", status: 500, reason: "backendError" });
  });

  it("429 on a fetch backs the row off, keeps it, and stops the account for this run", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    gmail.seed(msg("i2", "t2", ["INBOX"], 2 * DAY));
    await syncAfterConnect(deps({ budgetMs: 0 }), account.id);
    gmail.failNext("getMessageFull", 429, "rateLimitExceeded");
    const res = await syncAccount(deps(), await reloadAccount(), "cron");
    expect(res.outcome).toBe("error");
    const rows = await queue();
    expect(rows).toHaveLength(2);
    const failed = rows.find((r) => r.attempts === 1)!;
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(clock);
    expect(failed.lastError).toBe("429 rateLimitExceeded");
    expect(gmail.count("getMessageFull")).toBe(1);
    clock += 10 * 60_000;
    await runUntilComplete();
    expect((await stored()).sort()).toEqual(["i1", "i2"]);
  });

  it("reauth_required accounts get no Gmail calls and one audit per transition; ReauthRequiredError stops only that account", async () => {
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, account.id));
    const other = await makeGoogleAccount(database, userId, { email: "home@example.com" });
    const otherGmail = new FakeGmail();
    otherGmail.seed(msg("h1", "th", ["INBOX"], DAY));
    const d = deps({ gmailFor: (a) => (a.id === other.id ? otherGmail : gmail) });
    await runCronSync(d);
    await runCronSync(d);
    expect(gmail.calls).toEqual([]);
    expect((await audits()).filter((a) => a.action === "mail.sync_skipped_reauth")).toHaveLength(1);
    const otherStored = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.accountId, other.id));
    expect(otherStored.map((m) => m.gmailMessageId)).toEqual(["h1"]);

    // Token refresh rejected mid-run (getAccessToken marks the account and throws).
    await database.update(schema.connectedAccounts).set({ status: "active" }).where(eq(schema.connectedAccounts.id, account.id));
    gmail.getProfile = async () => {
      throw new ReauthRequiredError(account.id, "test");
    };
    const results = await runCronSync(d);
    expect(results.find((r) => r.accountId === account.id)?.outcome).toBe("skipped_reauth");
    expect(results.find((r) => r.accountId === other.id)?.outcome).toBe("ok");
    expect((await state()).leaseOwner).toBeNull();
  });

  it("a held lease makes a concurrent run skip the account", async () => {
    await syncAfterConnect(deps(), account.id);
    gmail.calls = [];
    expect(await acquireLease(database, account.id, "someone-else")).not.toBeNull();
    expect((await syncAccount(deps(), await reloadAccount(), "cron")).outcome).toBe("busy");
    expect(gmail.calls).toEqual([]);
  });

  it("fetches a body part delivered by attachmentId, and never a real attachment", async () => {
    gmail.bodies.set("ATT-BODY", b64url("<p>large html body</p>"));
    gmail.bodies.set("ATT-REAL", b64url("PDF bytes"));
    gmail.seed(
      msg("big", "tb", ["INBOX"], DAY, {
        payload: {
          mimeType: "multipart/mixed",
          filename: "",
          body: { size: 0 },
          parts: [
            {
              partId: "0",
              mimeType: "multipart/alternative",
              filename: "",
              body: { size: 0 },
              parts: [
                { ...textPart("text/plain", "plain"), partId: "0.0" },
                { partId: "0.1", mimeType: "text/html", filename: "", headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { attachmentId: "ATT-BODY", size: 2_000_000 } },
              ],
            },
            { partId: "1", mimeType: "text/html", filename: "page.html", body: { attachmentId: "ATT-REAL", size: 500 } },
          ],
        },
      }),
    );
    await runUntilComplete();
    const fetched = gmail.calls.filter((c) => c.op === "getBodyPartData").map((c) => c.args[1]);
    expect(fetched).toEqual(["ATT-BODY"]);
    const [m] = await database.select().from(schema.mailMessages);
    expect(m!.bodyHtml).toBe("<p>large html body</p>");
    expect(m!.bodyText).toBe("plain");
    expect(m!.bodyIncomplete).toBe(false);
    const atts = await database.select().from(schema.mailAttachments);
    expect(atts.map((a) => [a.filename, a.gmailAttachmentId])).toEqual([["page.html", "ATT-REAL"]]);
  });

  it("a body part that can't be fetched is stored as incomplete", async () => {
    gmail.seed(
      msg("big", "tb", ["INBOX"], DAY, {
        payload: { mimeType: "text/html", filename: "", body: { attachmentId: "MISSING", size: 10 } },
      }),
    );
    await runUntilComplete();
    const [m] = await database.select().from(schema.mailMessages);
    expect(m!.bodyIncomplete).toBe(true);
  });

  it("watch renewal: the daily job renews active accounts; the 5-minute job renews within 24h of expiry", async () => {
    await syncAfterConnect(deps(), account.id);
    gmail.calls = [];
    const out = await runWatchRenewal(deps());
    expect(out).toEqual([{ accountId: account.id, outcome: "renewed" }]);
    expect(gmail.count("watch")).toBe(1);
    expect((await audits()).filter((a) => a.action === "mail.watch_renewed")).toHaveLength(1);

    gmail.calls = [];
    await syncAccount(deps(), await reloadAccount(), "cron");
    expect(gmail.count("watch")).toBe(0); // 7 days left
    await database
      .update(schema.mailSyncState)
      .set({ watchExpiresAt: new Date(clock + 3600_000) })
      .where(eq(schema.mailSyncState.accountId, account.id));
    await syncAccount(deps(), await reloadAccount(), "cron");
    expect(gmail.count("watch")).toBe(1);

    gmail.failNext("watch", 403, "forbidden");
    await runWatchRenewal(deps());
    const failed = (await audits()).filter((a) => a.action === "mail.watch_failed");
    expect(failed.at(-1)!.detail).toEqual({ status: 403, reason: "forbidden" });

    // A persistent failure keeps being retried but is audited at most every 6 hours.
    gmail.failNext("watch", 403, "forbidden");
    gmail.calls = [];
    await runWatchRenewal(deps());
    expect(gmail.count("watch")).toBe(1);
    expect((await audits()).filter((a) => a.action === "mail.watch_failed")).toHaveLength(1);
  });

  it("disconnect: users.stop is best-effort and the account's mail is removed by the cascade", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    await runUntilComplete();
    expect(await stopWatchBeforeDisconnect(database, await reloadAccount(), gmail)).toBe(true);
    expect(gmail.count("stop")).toBe(1);
    gmail.failNext("stop", 500, "backendError");
    expect(await stopWatchBeforeDisconnect(database, await reloadAccount(), gmail)).toBe(false);
    await database.delete(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id));
    expect(await database.select().from(schema.mailMessages)).toEqual([]);
    expect(await database.select().from(schema.mailThreads)).toEqual([]);
    const actions = (await audits()).map((a) => a.action);
    expect(actions).toContain("mail.watch_stopped");
  });

  it("audit entries never contain message content, addresses or tokens", async () => {
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY, { subject: "Very secret subject", from: "Secret Person <secret@example.com>" }));
    await runUntilComplete();
    gmail.historyPageSize = 1;
    gmail.failNext("listHistory", 500);
    await syncAccount(deps(), await reloadAccount(), "cron");
    const all = JSON.stringify(await audits());
    for (const bad of ["Very secret subject", "secret@example.com", "Secret Person", "Snippet", "Body of", "work@example.com", "access", "refresh"]) {
      expect(all).not.toContain(bad);
    }
  });

  it("enqueued rows from different accounts don't collide", async () => {
    const other = await makeGoogleAccount(database, userId);
    const g2 = new FakeGmail();
    g2.seed(msg("i1", "t1", ["INBOX"], DAY));
    gmail.seed(msg("i1", "t1", ["INBOX"], DAY));
    const d = deps({ gmailFor: (a) => (a.id === other.id ? g2 : gmail) });
    await runCronSync(d);
    await runCronSync(d);
    const rows = await database
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.mailThreads)
      .where(and(eq(schema.mailThreads.gmailThreadId, "t1")));
    expect(rows[0]!.n).toBe(2);
  });
});
