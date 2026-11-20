import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { parseMessage } from "@/lib/gmail/mime";
import {
  acquireLease,
  changeLabels,
  countPendingQueue,
  deleteStoredMessage,
  dueQueueRows,
  enqueueLabelRefresh,
  enqueueMessages,
  ensureSyncState,
  getThreadView,
  knownThreadIds,
  listInboxThreads,
  releaseLease,
  storeMessage,
  type StoreMessageInput,
} from "@/lib/gmail/store";
import { textPart, toFull } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

describe.skipIf(!testDbUrl)("mail store (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { label: "business" });
    await ensureSyncState(database, account);
  });

  function input(over: Partial<{ id: string; threadId: string; labels: string[]; at: number; withAttachment: boolean }> = {}): StoreMessageInput {
    const id = over.id ?? "m1";
    const threadId = over.threadId ?? "t1";
    const payload = over.withAttachment
      ? {
          mimeType: "multipart/mixed",
          filename: "",
          body: { size: 0 },
          parts: [
            { ...textPart("text/plain", "hi"), partId: "0" },
            { partId: "1", mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "ATT", size: 10 } },
          ],
        }
      : undefined;
    const full = toFull({ id, threadId, labelIds: over.labels ?? ["INBOX", "UNREAD"], internalDate: over.at ?? Date.now(), payload });
    return {
      account,
      gmailMessageId: id,
      gmailThreadId: threadId,
      historyId: "1",
      internalDate: new Date(Number(full.internalDate)),
      labelIds: full.labelIds ?? [],
      snippet: full.snippet ?? null,
      sizeEstimate: 10,
      parsed: parseMessage(full),
      bodyIncomplete: false,
      createThread: true,
    };
  }

  const count = async (table: typeof schema.mailMessages | typeof schema.mailThreads | typeof schema.mailAttachments | typeof schema.mailFetchQueue) =>
    (await database.select({ n: sql<number>`count(*)::int` }).from(table))[0]!.n;

  it("storing the same message twice is idempotent (one message, one thread, no duplicate attachments)", async () => {
    const a = await storeMessage(database, input({ withAttachment: true }));
    const b = await storeMessage(database, input({ withAttachment: true }));
    expect(a!.inserted).toBe(true);
    expect(b!.inserted).toBe(false);
    expect(b!.messageId).toBe(a!.messageId);
    expect(await count(schema.mailMessages)).toBe(1);
    expect(await count(schema.mailThreads)).toBe(1);
    expect(await count(schema.mailAttachments)).toBe(1);
    const [thread] = await database.select().from(schema.mailThreads);
    expect(thread).toMatchObject({ messageCount: 1, inInbox: true, hasUnread: true, accountId: account.id, userId });
  });

  it("stores headers needed for 2b replies and bodies", async () => {
    await storeMessage(database, input());
    const [m] = await database.select().from(schema.mailMessages);
    expect(m!.rfc822MessageId).toBe("<m1@mail.example.com>");
    expect(m!.bodyText).toBe("Body of m1");
    expect(m!.bodyHtml).toBe("<p>Body of m1</p>");
    expect(m!.headers.find((h) => h.name === "Subject")?.value).toBe("Subject m1");
  });

  it("a sent message is not stored without an existing thread (caller defers)", async () => {
    const res = await storeMessage(database, { ...input({ labels: ["SENT"] }), createThread: false });
    expect(res).toBeNull();
    expect(await count(schema.mailMessages)).toBe(0);
    expect(await count(schema.mailThreads)).toBe(0);
  });

  it("deletes the queue row in the same transaction", async () => {
    await enqueueMessages(database, account, [{ gmailMessageId: "m1", gmailThreadId: "t1", source: "history", needsClassify: false }]);
    const [row] = await dueQueueRows(database, account.id, new Date(), 10);
    await storeMessage(database, { ...input(), queueRowId: row!.id });
    expect(await count(schema.mailFetchQueue)).toBe(0);
  });

  it("queue dedupes by (account, message id)", async () => {
    const rows = [{ gmailMessageId: "m1", gmailThreadId: "t1", source: "backfill_inbox" as const, needsClassify: false }];
    expect(await enqueueMessages(database, account, rows)).toBe(1);
    expect(await enqueueMessages(database, account, [{ ...rows[0]!, source: "history" }])).toBe(0);
    expect(await count(schema.mailFetchQueue)).toBe(1);
    const [q] = await database.select().from(schema.mailFetchQueue);
    expect(q!.source).toBe("backfill_inbox");
  });

  it("due rows come out history first, then backfill inbox, then backfill sent", async () => {
    await enqueueMessages(database, account, [{ gmailMessageId: "s", gmailThreadId: "t", source: "backfill_sent", needsClassify: false }]);
    await enqueueMessages(database, account, [{ gmailMessageId: "i", gmailThreadId: "t", source: "backfill_inbox", needsClassify: false }]);
    await enqueueMessages(database, account, [{ gmailMessageId: "h", gmailThreadId: "u", source: "history", needsClassify: true }]);
    const due = await dueQueueRows(database, account.id, new Date(), 10);
    expect(due.map((r) => r.gmailMessageId)).toEqual(["h", "i", "s"]);
    expect(await countPendingQueue(database, account.id, ["backfill_inbox", "backfill_sent"])).toBe(2);
  });

  it("known threads: a stored thread or an inbox-sourced queue row, but not a backfill_sent row", async () => {
    await storeMessage(database, input({ id: "m1", threadId: "stored" }));
    await enqueueMessages(database, account, [
      { gmailMessageId: "q1", gmailThreadId: "queued-inbox", source: "backfill_inbox", needsClassify: false },
      { gmailMessageId: "q2", gmailThreadId: "queued-history", source: "history", needsClassify: true },
      { gmailMessageId: "q3", gmailThreadId: "queued-sent", source: "backfill_sent", needsClassify: false },
    ]);
    const known = await knownThreadIds(database, account.id, ["stored", "queued-inbox", "queued-history", "queued-sent", "nope"]);
    expect([...known].sort()).toEqual(["queued-history", "queued-inbox", "stored"]);
    const other = await makeGoogleAccount(database, userId);
    expect((await knownThreadIds(database, other.id, ["stored"])).size).toBe(0);
  });

  it("lease is exclusive, can be taken over once expired, and only its owner releases it", async () => {
    expect(await acquireLease(database, account.id, "A")).not.toBeNull();
    expect(await acquireLease(database, account.id, "B")).toBeNull();
    await releaseLease(database, account.id, "B"); // not the owner: no effect
    expect(await acquireLease(database, account.id, "B")).toBeNull();
    await database
      .update(schema.mailSyncState)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.mailSyncState.accountId, account.id));
    expect((await acquireLease(database, account.id, "B"))?.leaseOwner).toBe("B");
    await releaseLease(database, account.id, "A"); // stale owner can't release B's lease
    expect(await acquireLease(database, account.id, "C")).toBeNull();
    await releaseLease(database, account.id, "B");
    expect(await acquireLease(database, account.id, "C")).not.toBeNull();
  });

  it("recomputes in_inbox, has_unread, counts, subject and snippet, and deletes empty threads", async () => {
    await storeMessage(database, input({ id: "m1", at: 1_000_000 }));
    await storeMessage(database, input({ id: "m2", at: 2_000_000, labels: ["INBOX"] }));
    let [t] = await database.select().from(schema.mailThreads);
    expect(t).toMatchObject({ messageCount: 2, inInbox: true, hasUnread: true, subject: "Subject m1", snippet: "Snippet m2" });
    expect(t!.lastMessageAt.getTime()).toBe(2_000_000);

    expect(await changeLabels(database, account.id, "m1", { remove: ["UNREAD"] })).toBe(true);
    [t] = await database.select().from(schema.mailThreads);
    expect(t!.hasUnread).toBe(false);

    await changeLabels(database, account.id, "m1", { remove: ["INBOX"] });
    [t] = await database.select().from(schema.mailThreads);
    expect(t!.inInbox).toBe(true); // m2 still in the inbox
    await changeLabels(database, account.id, "m2", { remove: ["INBOX"] });
    [t] = await database.select().from(schema.mailThreads);
    expect(t!.inInbox).toBe(false);

    await changeLabels(database, account.id, "m2", { add: ["INBOX", "UNREAD"] });
    [t] = await database.select().from(schema.mailThreads);
    expect([t!.inInbox, t!.hasUnread]).toEqual([true, true]);

    await changeLabels(database, account.id, "m2", { set: ["SENT"] });
    const [m2] = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "m2"));
    expect(m2!.labelIds).toEqual(["SENT"]);

    expect(await changeLabels(database, account.id, "not-stored", { add: ["INBOX"] })).toBe(false);

    expect(await deleteStoredMessage(database, account.id, "m1")).toBe(true);
    [t] = await database.select().from(schema.mailThreads);
    expect(t!.messageCount).toBe(1);
    expect(t!.subject).toBe("Subject m2");
    expect(await deleteStoredMessage(database, account.id, "m2")).toBe(true);
    expect(await count(schema.mailThreads)).toBe(0);
    expect(await deleteStoredMessage(database, account.id, "m2")).toBe(false);
  });

  it("label refresh queues stored messages in the window and converts existing rows", async () => {
    await storeMessage(database, input({ id: "old", threadId: "a", at: Date.now() - 40 * 86400_000 }));
    await storeMessage(database, input({ id: "new", threadId: "b", at: Date.now() - 86400_000 }));
    await enqueueMessages(database, account, [{ gmailMessageId: "new", gmailThreadId: "b", source: "history", needsClassify: false }]);
    await enqueueLabelRefresh(database, account, new Date(Date.now() - 10 * 86400_000));
    const rows = await database.select().from(schema.mailFetchQueue);
    expect(rows.map((r) => [r.gmailMessageId, r.source, r.needsClassify])).toEqual([["new", "resync", true]]);
  });

  it("inbox lists only in_inbox threads, newest first, with keyset paging and account labels", async () => {
    for (let i = 1; i <= 5; i++) await storeMessage(database, input({ id: `m${i}`, threadId: `t${i}`, at: i * 1_000_000 }));
    await changeLabels(database, account.id, "m3", { remove: ["INBOX"] });
    const first = await listInboxThreads(database, userId, { limit: 2 });
    expect(first.map((t) => t.subject)).toEqual(["Subject m5", "Subject m4"]);
    expect(first[0]).toMatchObject({ accountLabel: "business", accountEmail: account.email, sender: "Sender <sender@example.com>" });
    const last = first[1]!;
    const second = await listInboxThreads(database, userId, { limit: 10, before: { lastMessageAt: last.lastMessageAt, id: last.id } });
    expect(second.map((t) => t.subject)).toEqual(["Subject m2", "Subject m1"]);
  });

  it("scopes inbox and thread view to the user", async () => {
    const stored = await storeMessage(database, input());
    const stranger = await makeUser(database, "stranger@example.com");
    expect(await listInboxThreads(database, stranger.id, { limit: 10 })).toEqual([]);
    expect(await getThreadView(database, stranger.id, stored!.threadId)).toBeNull();
    const view = await getThreadView(database, userId, stored!.threadId);
    expect(view!.messages).toHaveLength(1);
    expect(view!.account.email).toBe(account.email);
  });

  it("deleting the account cascades to all of its mail", async () => {
    await storeMessage(database, input({ withAttachment: true }));
    await enqueueMessages(database, account, [{ gmailMessageId: "x", gmailThreadId: "y", source: "history", needsClassify: true }]);
    await database.delete(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id));
    for (const t of [schema.mailMessages, schema.mailThreads, schema.mailAttachments, schema.mailFetchQueue]) expect(await count(t)).toBe(0);
    expect((await database.select().from(schema.mailSyncState)).length).toBe(0);
  });
});
