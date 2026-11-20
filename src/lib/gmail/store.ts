import { and, asc, desc, eq, getTableColumns, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { afterMessageCommitted, onMessageStored, type StoredMessage } from "@/lib/approvals/ingest-hook";
import {
  connectedAccounts,
  mailAttachments,
  mailFetchQueue,
  mailMessages,
  mailSyncState,
  mailThreads,
  mailTriage,
  type MailTriage,
  type MailFetchQueueRow,
  type MailSyncState,
} from "@/db/schema";
import type { RenderFields } from "@/lib/email/types";
import type { ParsedMessage } from "./mime";

/**
 * Database side of mail ingestion. Every function takes an Executor (the shared client, a test
 * client or an open transaction). Nothing here talks to Gmail.
 */

export type FetchSource = MailFetchQueueRow["source"];
type AccountRef = { id: string; userId: string };

/** Queue rows parked after repeated permanent failures sit at this time and are never due. */
export const PARKED_AT = new Date("9999-12-31T00:00:00.000Z");

const LEASE_SECONDS = 290;

// ---------------------------------------------------------------------------------------------
// Sync state and lease
// ---------------------------------------------------------------------------------------------

export async function ensureSyncState(ex: Executor, account: AccountRef): Promise<MailSyncState> {
  await ex.insert(mailSyncState).values({ accountId: account.id, userId: account.userId }).onConflictDoNothing();
  const state = await getSyncState(ex, account.id);
  if (!state) throw new Error("mail_sync_state row missing after insert");
  return state;
}

export async function getSyncState(ex: Executor, accountId: string): Promise<MailSyncState | null> {
  const rows = await ex.select().from(mailSyncState).where(eq(mailSyncState.accountId, accountId)).limit(1);
  return rows[0] ?? null;
}

export async function updateSyncState(
  ex: Executor,
  accountId: string,
  patch: Partial<Omit<typeof mailSyncState.$inferInsert, "accountId" | "userId">>,
): Promise<void> {
  await ex
    .update(mailSyncState)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(mailSyncState.accountId, accountId));
}

/**
 * Takes the per-account lease if it is free or expired. Returns the state row, or null if another
 * run holds it. Uses the database clock so concurrent serverless instances agree.
 */
export async function acquireLease(
  ex: Executor,
  accountId: string,
  owner: string,
  seconds = LEASE_SECONDS,
): Promise<MailSyncState | null> {
  const rows = await ex
    .update(mailSyncState)
    .set({ leaseOwner: owner, leaseUntil: sql`now() + make_interval(secs => ${seconds})` })
    .where(
      and(
        eq(mailSyncState.accountId, accountId),
        or(isNull(mailSyncState.leaseUntil), lt(mailSyncState.leaseUntil, sql`now()`)),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Releases the lease, but only if `owner` still holds it. */
export async function releaseLease(ex: Executor, accountId: string, owner: string): Promise<void> {
  await ex
    .update(mailSyncState)
    .set({ leaseOwner: null, leaseUntil: null })
    .where(and(eq(mailSyncState.accountId, accountId), eq(mailSyncState.leaseOwner, owner)));
}

// ---------------------------------------------------------------------------------------------
// Fetch queue
// ---------------------------------------------------------------------------------------------

export type EnqueueRow = {
  gmailMessageId: string;
  gmailThreadId: string | null;
  source: FetchSource;
  needsClassify: boolean;
};

/** Adds ids to the fetch queue; ids already queued are left as they are. Returns how many were new. */
export async function enqueueMessages(ex: Executor, account: AccountRef, rows: EnqueueRow[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    if (chunk.length === 0) continue;
    const res = await ex
      .insert(mailFetchQueue)
      .values(chunk.map((r) => ({ ...r, accountId: account.id, userId: account.userId })))
      .onConflictDoNothing({ target: [mailFetchQueue.accountId, mailFetchQueue.gmailMessageId] })
      .returning({ id: mailFetchQueue.id });
    inserted += res.length;
  }
  return inserted;
}

/**
 * Phase 2d (plan §6.4): queues the SENT copy of a new message Alex just sent, so the next sync
 * stores it even though its thread isn't stored yet. Called in the same transaction as the item's
 * move to `succeeded`. The Gmail ids come only from our own send response or from a reconcile hit
 * that carried SENT in this account. A row already queued for the message (for example from
 * history) is converted, so it can't be dropped as "sent mail in an unknown thread".
 */
export async function enqueueOutbound(ex: Executor, account: AccountRef, gmailMessageId: string, gmailThreadId: string): Promise<void> {
  await ex.execute(sql`
    insert into mail_fetch_queue (user_id, account_id, gmail_message_id, gmail_thread_id, source, needs_classify)
    values (${account.userId}::uuid, ${account.id}::uuid, ${gmailMessageId}, ${gmailThreadId}, 'outbound', false)
    on conflict (account_id, gmail_message_id)
    do update set source = 'outbound', needs_classify = false, gmail_thread_id = excluded.gmail_thread_id, attempts = 0,
      next_attempt_at = now(), last_error = null, deferred_at = null, defer_count = 0
  `);
}

/**
 * Due queue rows: history/resync/outbound first, then backfill inbox, then backfill sent, then oldest first.
 * New rows get next_attempt_at from the database clock and retries from the app clock, so a row
 * is due once either clock has passed it (small skew between the two can't strand fresh rows).
 */
export async function dueQueueRows(ex: Executor, accountId: string, now: Date, limit: number): Promise<MailFetchQueueRow[]> {
  return ex
    .select()
    .from(mailFetchQueue)
    .where(
      and(
        eq(mailFetchQueue.accountId, accountId),
        sql`${mailFetchQueue.nextAttemptAt} <= greatest(now(), ${now.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(
      sql`case ${mailFetchQueue.source} when 'history' then 0 when 'resync' then 0 when 'outbound' then 0 when 'backfill_inbox' then 1 else 2 end`,
      asc(mailFetchQueue.createdAt),
      asc(mailFetchQueue.id),
    )
    .limit(limit);
}

export async function deleteQueueRow(ex: Executor, id: string): Promise<void> {
  await ex.delete(mailFetchQueue).where(eq(mailFetchQueue.id, id));
}

/**
 * Deletes a row that `row` (as loaded) decided to drop. If it was loaded from another source but has
 * since been converted to `outbound` (enqueueOutbound ran while it was being processed), it is kept:
 * the outbound decision wins (plan §6.4, R7).
 */
export async function dropQueueRow(ex: Executor, row: Pick<MailFetchQueueRow, "id" | "source">): Promise<void> {
  if (row.source === "outbound") return deleteQueueRow(ex, row.id);
  await ex.delete(mailFetchQueue).where(and(eq(mailFetchQueue.id, row.id), ne(mailFetchQueue.source, "outbound")));
}

export async function deleteQueueRowForMessage(ex: Executor, accountId: string, gmailMessageId: string): Promise<void> {
  await ex
    .delete(mailFetchQueue)
    .where(and(eq(mailFetchQueue.accountId, accountId), eq(mailFetchQueue.gmailMessageId, gmailMessageId)));
}

/**
 * The one definition of "this queue row may still become inbox mail", used both for known
 * threads (6.5.1) and for the sibling a deferred sent message waits on:
 * - from an inbox source (backfill_inbox, history, resync)
 * - not parked (a parked row will never be stored)
 * - not itself a sent message waiting for its thread (deferred_at set)
 * Rows whose labels are still unknown count until their first hydration classifies them.
 */
export function inboxBoundQueueRow() {
  return and(
    inArray(mailFetchQueue.source, ["backfill_inbox", "history", "resync"]),
    lt(mailFetchQueue.nextAttemptAt, PARKED_AT),
    isNull(mailFetchQueue.deferredAt),
  )!;
}

/**
 * Pushes a row out (a sent message whose thread isn't stored yet) and records the deferral in
 * its own columns (deferred_at, defer_count), never in last_error. With `consumeAttempt` (the
 * default) the wait counts towards `maxAttempts` and the row is dropped there; with
 * `consumeAttempt: false` (the thread's inbox message is still queued) it waits without using
 * up an attempt.
 */
export async function deferQueueRow(
  ex: Executor,
  row: MailFetchQueueRow,
  now: Date,
  delayMs: number,
  maxAttempts: number,
  opts: { consumeAttempt?: boolean; gmailThreadId?: string | null } = {},
): Promise<"deferred" | "dropped"> {
  const attempts = opts.consumeAttempt === false ? row.attempts : row.attempts + 1;
  if (attempts >= maxAttempts) {
    await dropQueueRow(ex, row);
    return "dropped";
  }
  await ex
    .update(mailFetchQueue)
    .set({
      attempts,
      nextAttemptAt: new Date(now.getTime() + delayMs),
      deferredAt: row.deferredAt ?? now,
      deferCount: row.deferCount + 1,
      ...(opts.gmailThreadId && !row.gmailThreadId ? { gmailThreadId: opts.gmailThreadId } : {}),
    })
    // A row converted to outbound meanwhile is left alone (see dropQueueRow).
    .where(and(eq(mailFetchQueue.id, row.id), row.source === "outbound" ? undefined : ne(mailFetchQueue.source, "outbound")));
  return "deferred";
}

/**
 * Records a failed fetch. `error` must be content-free.
 * - Transient failures (429/5xx) back off exponentially (30 s doubling, capped at 1 h) and park
 *   after `maxTransientAttempts`, so one message that keeps failing can't hold a backfill open or
 *   produce sync errors forever. A genuine outage of several hours is still ridden out.
 * - Other failures park after `maxAttempts`.
 */
export async function failQueueRow(
  ex: Executor,
  row: MailFetchQueueRow,
  now: Date,
  opts: { transient: boolean; error: string; maxAttempts: number; maxTransientAttempts: number },
): Promise<"retry" | "parked"> {
  const attempts = row.attempts + 1;
  const limit = opts.transient ? opts.maxTransientAttempts : opts.maxAttempts;
  // Round 2, F2: a row converted to outbound since it was loaded is left alone (see dropQueueRow).
  const where = and(eq(mailFetchQueue.id, row.id), row.source === "outbound" ? undefined : ne(mailFetchQueue.source, "outbound"));
  if (attempts >= limit) {
    await ex
      .update(mailFetchQueue)
      .set({ attempts, nextAttemptAt: PARKED_AT, lastError: opts.error })
      .where(where);
    return "parked";
  }
  const delayMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 10));
  await ex
    .update(mailFetchQueue)
    .set({ attempts, nextAttemptAt: new Date(now.getTime() + delayMs), lastError: opts.error })
    .where(where);
  return "retry";
}

/** Rows of the given sources still waiting (parked rows excluded). */
export async function countPendingQueue(ex: Executor, accountId: string, sources: FetchSource[]): Promise<number> {
  const rows = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(mailFetchQueue)
    .where(
      and(
        eq(mailFetchQueue.accountId, accountId),
        inArray(mailFetchQueue.source, sources),
        lt(mailFetchQueue.nextAttemptAt, PARKED_AT),
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Queues every stored message received on or after `after` for a label refresh (format=minimal),
 * used after an expired-history resync. Already-queued rows for those messages are converted.
 */
export async function enqueueLabelRefresh(ex: Executor, account: AccountRef, after: Date): Promise<number> {
  const res = await ex.execute(sql`
    insert into mail_fetch_queue (user_id, account_id, gmail_message_id, gmail_thread_id, source, needs_classify)
    select ${account.userId}::uuid, ${account.id}::uuid, m.gmail_message_id, m.gmail_thread_id, 'resync', true
    from mail_messages m
    where m.account_id = ${account.id}::uuid and m.internal_date >= ${after.toISOString()}::timestamptz
    on conflict (account_id, gmail_message_id)
    do update set source = 'resync', needs_classify = true, attempts = 0, next_attempt_at = now(), last_error = null,
      deferred_at = null, defer_count = 0
  `);
  return (res as unknown as { count?: number }).count ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

export async function storedMessageIds(ex: Executor, accountId: string, gmailMessageIds: string[]): Promise<Set<string>> {
  if (gmailMessageIds.length === 0) return new Set();
  const rows = await ex
    .select({ id: mailMessages.gmailMessageId })
    .from(mailMessages)
    .where(and(eq(mailMessages.accountId, accountId), inArray(mailMessages.gmailMessageId, gmailMessageIds)));
  return new Set(rows.map((r) => r.id));
}

export async function isMessageStored(ex: Executor, accountId: string, gmailMessageId: string): Promise<boolean> {
  return (await storedMessageIds(ex, accountId, [gmailMessageId])).has(gmailMessageId);
}

export async function threadRowId(ex: Executor, accountId: string, gmailThreadId: string): Promise<string | null> {
  const rows = await ex
    .select({ id: mailThreads.id })
    .from(mailThreads)
    .where(and(eq(mailThreads.accountId, accountId), eq(mailThreads.gmailThreadId, gmailThreadId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Thread ids with an inbox-sourced queue row (the inbox message is waiting to be fetched). */
export async function queuedInboxThreadIds(ex: Executor, accountId: string, gmailThreadIds: string[]): Promise<Set<string>> {
  if (gmailThreadIds.length === 0) return new Set();
  const rows = await ex
    .selectDistinct({ id: mailFetchQueue.gmailThreadId })
    .from(mailFetchQueue)
    .where(
      and(
        eq(mailFetchQueue.accountId, accountId),
        inArray(mailFetchQueue.gmailThreadId, gmailThreadIds),
        inboxBoundQueueRow(),
      ),
    );
  return new Set(rows.map((r) => r.id).filter((x): x is string => x !== null));
}

/**
 * Known threads (plan 6.5.1): a mail_threads row exists for the account, or a queue row from an
 * inbox source carries that thread id. Pure database lookup.
 */
export async function knownThreadIds(ex: Executor, accountId: string, gmailThreadIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(gmailThreadIds)];
  if (ids.length === 0) return new Set();
  const stored = await ex
    .select({ id: mailThreads.gmailThreadId })
    .from(mailThreads)
    .where(and(eq(mailThreads.accountId, accountId), inArray(mailThreads.gmailThreadId, ids)));
  const known = new Set(stored.map((r) => r.id));
  const rest = ids.filter((id) => !known.has(id));
  for (const id of await queuedInboxThreadIds(ex, accountId, rest)) known.add(id);
  return known;
}

// ---------------------------------------------------------------------------------------------
// Threads and messages
// ---------------------------------------------------------------------------------------------

/**
 * Recomputes a thread's derived columns from its stored messages, and deletes the thread if it
 * has none left. Call inside the same transaction as the message change.
 */
export async function recomputeThread(ex: Executor, threadId: string): Promise<"updated" | "deleted"> {
  const updated = await ex.execute(sql`
    update mail_threads t set
      message_count = s.cnt,
      last_message_at = s.last,
      in_inbox = s.inbox,
      has_unread = s.unread,
      subject = (select m.subject from mail_messages m where m.thread_id = t.id order by m.internal_date asc, m.id asc limit 1),
      snippet = (select m.snippet from mail_messages m where m.thread_id = t.id order by m.internal_date desc, m.id desc limit 1),
      updated_at = now()
    from (
      select count(*)::int as cnt,
             max(internal_date) as last,
             coalesce(bool_or('INBOX' = any(label_ids)), false) as inbox,
             coalesce(bool_or('INBOX' = any(label_ids) and 'UNREAD' = any(label_ids)), false) as unread
      from mail_messages where thread_id = ${threadId}::uuid
    ) s
    where t.id = ${threadId}::uuid and s.cnt > 0
  `);
  if (((updated as unknown as { count?: number }).count ?? 0) > 0) return "updated";
  await ex.delete(mailThreads).where(eq(mailThreads.id, threadId));
  return "deleted";
}

export type StoreMessageInput = {
  account: AccountRef;
  gmailMessageId: string;
  gmailThreadId: string;
  historyId: string | null;
  internalDate: Date;
  labelIds: string[];
  snippet: string | null;
  sizeEstimate: number | null;
  parsed: ParsedMessage;
  bodyIncomplete: boolean;
  /** Create the thread row if missing (INBOX mail). False for sent mail, which needs an existing thread. */
  createThread: boolean;
  /** Queue row to delete in the same transaction. */
  queueRowId?: string;
  /** Ingest-time rendering (Revision 4), stored in the same transaction. Omitted means "not rendered yet". */
  render?: RenderFields;
};

/**
 * Stores a hydrated message in one transaction: thread upsert, message insert (idempotent),
 * attachment metadata, thread recompute, queue row delete. Returns null when `createThread` is
 * false and the thread isn't stored (the caller defers).
 */
export async function storeMessage(
  ex: Executor,
  input: StoreMessageInput,
): Promise<{ threadId: string; messageId: string; inserted: boolean } | null> {
  const result = await ex.transaction(async (tx) => {
    const { account } = input;
    if (input.createThread) {
      await tx
        .insert(mailThreads)
        .values({
          userId: account.userId,
          accountId: account.id,
          gmailThreadId: input.gmailThreadId,
          lastMessageAt: input.internalDate,
          messageCount: 0,
          inInbox: false,
          hasUnread: false,
        })
        .onConflictDoNothing({ target: [mailThreads.accountId, mailThreads.gmailThreadId] });
    }
    const threadId = await threadRowId(tx, account.id, input.gmailThreadId);
    if (!threadId) return null;

    const p = input.parsed;
    const insertedRows = await tx
      .insert(mailMessages)
      .values({
        userId: account.userId,
        accountId: account.id,
        threadId,
        gmailMessageId: input.gmailMessageId,
        gmailThreadId: input.gmailThreadId,
        historyId: input.historyId,
        internalDate: input.internalDate,
        labelIds: input.labelIds,
        isSent: input.labelIds.includes("SENT"),
        snippet: input.snippet,
        subject: p.subject,
        fromHeader: p.from,
        toHeader: p.to,
        ccHeader: p.cc,
        replyToHeader: p.replyTo,
        dateHeader: p.date,
        rfc822MessageId: p.rfc822MessageId,
        inReplyTo: p.inReplyTo,
        references: p.references,
        headers: p.headers,
        bodyText: p.bodyText,
        bodyHtml: p.bodyHtml,
        sizeEstimate: input.sizeEstimate,
        bodyIncomplete: input.bodyIncomplete,
        ...(input.render ?? {}),
      })
      .onConflictDoNothing({ target: [mailMessages.accountId, mailMessages.gmailMessageId] })
      .returning({ id: mailMessages.id });

    let messageId = insertedRows[0]?.id;
    const inserted = messageId !== undefined;
    if (!messageId) {
      const existing = await tx
        .select({ id: mailMessages.id })
        .from(mailMessages)
        .where(and(eq(mailMessages.accountId, account.id), eq(mailMessages.gmailMessageId, input.gmailMessageId)))
        .limit(1);
      messageId = existing[0]!.id;
    }

    if (inserted && p.attachments.length > 0) {
      await tx
        .insert(mailAttachments)
        .values(p.attachments.map((a) => ({ ...a, userId: account.userId, messageId: messageId! })))
        .onConflictDoNothing({ target: [mailAttachments.messageId, mailAttachments.partId] });
    }

    await recomputeThread(tx, threadId);
    if (input.queueRowId) await deleteQueueRow(tx, input.queueRowId);
    // Phase 2b: reconcile Alex's own sent replies and flag new messages in threads with pending replies.
    let stored: StoredMessage | null = null;
    if (inserted) {
      stored = {
        accountId: account.id,
        threadId,
        messageId: messageId!,
        gmailMessageId: input.gmailMessageId,
        gmailThreadId: input.gmailThreadId,
        rfc822MessageId: p.rfc822MessageId,
        isSent: input.labelIds.includes("SENT"),
        internalDate: input.internalDate,
      };
      await onMessageStored(tx, stored);
    }
    return { threadId, messageId, inserted, stored };
  });
  // Round 3, E2: the Q6 flag again, now that this message is committed (see afterMessageCommitted).
  if (result && result.stored) await afterMessageCommitted(ex, result.stored);
  return result ? { threadId: result.threadId, messageId: result.messageId, inserted: result.inserted } : null;
}

/**
 * Applies a label change to a stored message and recomputes its thread. Returns false if the
 * message isn't stored (nothing changes). `set` replaces the labels (used by the resync refresh).
 */
export async function changeLabels(
  ex: Executor,
  accountId: string,
  gmailMessageId: string,
  change: { add?: string[]; remove?: string[]; set?: string[] },
): Promise<boolean> {
  return ex.transaction(async (tx) => {
    const rows = await tx
      .select({ id: mailMessages.id, threadId: mailMessages.threadId, labelIds: mailMessages.labelIds })
      .from(mailMessages)
      .where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.gmailMessageId, gmailMessageId)))
      .for("update")
      .limit(1);
    const row = rows[0];
    if (!row) return false;
    const labels = new Set(change.set ?? row.labelIds);
    for (const l of change.add ?? []) labels.add(l);
    for (const l of change.remove ?? []) labels.delete(l);
    const next = [...labels].sort();
    if (next.join("\u0000") !== [...row.labelIds].sort().join("\u0000")) {
      await tx.update(mailMessages).set({ labelIds: next, updatedAt: new Date() }).where(eq(mailMessages.id, row.id));
      await recomputeThread(tx, row.threadId);
    }
    return true;
  });
}

/** Deletes a stored message (attachments cascade) and recomputes or deletes its thread. Returns false if not stored. */
export async function deleteStoredMessage(ex: Executor, accountId: string, gmailMessageId: string): Promise<boolean> {
  return ex.transaction(async (tx) => {
    const rows = await tx
      .delete(mailMessages)
      .where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.gmailMessageId, gmailMessageId)))
      .returning({ threadId: mailMessages.threadId });
    const row = rows[0];
    if (!row) return false;
    await recomputeThread(tx, row.threadId);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Re-render (Revision 4, R4.7)
// ---------------------------------------------------------------------------------------------

/** Stored messages with HTML whose rendering is missing or older than `version`, newest first. */
export async function messagesNeedingRender(
  ex: Executor,
  accountId: string,
  version: number,
  limit: number,
): Promise<{ id: string; bodyHtml: string; bodyText: string | null }[]> {
  const rows = await ex
    .select({ id: mailMessages.id, bodyHtml: mailMessages.bodyHtml, bodyText: mailMessages.bodyText })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        sql`${mailMessages.bodyHtml} is not null`,
        or(isNull(mailMessages.sanitizerVersion), lt(mailMessages.sanitizerVersion, version)),
      ),
    )
    .orderBy(desc(mailMessages.internalDate), desc(mailMessages.id))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, bodyHtml: r.bodyHtml!, bodyText: r.bodyText }));
}

export async function countMessagesNeedingRender(ex: Executor, accountId: string, version: number): Promise<number> {
  const rows = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        sql`${mailMessages.bodyHtml} is not null`,
        or(isNull(mailMessages.sanitizerVersion), lt(mailMessages.sanitizerVersion, version)),
      ),
    );
  return rows[0]?.n ?? 0;
}

export async function updateMessageRender(ex: Executor, messageId: string, render: RenderFields): Promise<void> {
  await ex
    .update(mailMessages)
    .set({ ...render, updatedAt: new Date() })
    .where(eq(mailMessages.id, messageId));
}

// ---------------------------------------------------------------------------------------------
// Read side (UI). Always scoped by user id.
// ---------------------------------------------------------------------------------------------

export type InboxCursor = { lastMessageAt: Date; id: string };

export type InboxThreadRow = {
  id: string;
  accountId: string;
  accountEmail: string;
  accountLabel: "personal" | "business";
  subject: string | null;
  snippet: string | null;
  sender: string | null;
  lastMessageAt: Date;
  messageCount: number;
  hasUnread: boolean;
  /** Phase 2c: the latest inbound message's triage result (advisory), or null if it has none. */
  triage: { category: string; needs_reply: boolean | null; summary: string | null } | null;
};

/** The latest inbound message's most recent `ok` triage row, as JSON (Phase 2c). Content is model output; shown as React text. */
const threadTriageJson = sql<InboxThreadRow["triage"]>`(
  select json_build_object('category', t.category, 'needs_reply', t.needs_reply, 'summary', t.summary)
  from mail_triage t
  where t.status = 'ok' and t.message_id = (
    select m2.id from mail_messages m2
    where m2.thread_id = ${mailThreads.id} and not m2.is_sent
    order by m2.internal_date desc, m2.id desc limit 1
  )
  order by t.updated_at desc limit 1
)`;

/** Threads currently in the inbox across all of the user's accounts, newest first, keyset-paged. */
export async function listInboxThreads(
  ex: Executor,
  userId: string,
  opts: { before?: InboxCursor; limit: number; needsReply?: boolean },
): Promise<InboxThreadRow[]> {
  const conditions = [eq(mailThreads.userId, userId), eq(mailThreads.inInbox, true)];
  // Phase 2c "Needs reply" tab: the triage flag only filters the view; nothing is hidden elsewhere.
  if (opts.needsReply) conditions.push(sql`(${threadTriageJson})->>'needs_reply' = 'true'`);
  if (opts.before) {
    conditions.push(
      sql`(${mailThreads.lastMessageAt}, ${mailThreads.id}) < (${opts.before.lastMessageAt.toISOString()}::timestamptz, ${opts.before.id}::uuid)`,
    );
  }
  return ex
    .select({
      id: mailThreads.id,
      accountId: mailThreads.accountId,
      accountEmail: connectedAccounts.email,
      accountLabel: connectedAccounts.label,
      subject: mailThreads.subject,
      snippet: mailThreads.snippet,
      sender: sql<string | null>`(select m.from_header from mail_messages m where m.thread_id = ${mailThreads.id} order by m.internal_date desc, m.id desc limit 1)`,
      lastMessageAt: mailThreads.lastMessageAt,
      messageCount: mailThreads.messageCount,
      hasUnread: mailThreads.hasUnread,
      triage: threadTriageJson,
    })
    .from(mailThreads)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, mailThreads.accountId))
    .where(and(...conditions))
    .orderBy(desc(mailThreads.lastMessageAt), desc(mailThreads.id))
    .limit(opts.limit);
}

/** Message columns the thread page reads: everything except the raw `body_html` (Revision 4, R4.5). */
const { bodyHtml: _bodyHtml, ...threadViewMessageColumns } = getTableColumns(mailMessages);

export type ThreadViewMessage = Omit<typeof mailMessages.$inferSelect, "bodyHtml"> & {
  attachments: (typeof mailAttachments.$inferSelect)[];
};

export type ThreadView = {
  thread: typeof mailThreads.$inferSelect;
  account: { id: string; email: string; label: "personal" | "business" };
  messages: ThreadViewMessage[];
};

/** A thread with its messages (oldest first) and attachment metadata, or null if it isn't the user's. */
export async function getThreadView(ex: Executor, userId: string, threadId: string): Promise<ThreadView | null> {
  const rows = await ex
    .select({
      thread: mailThreads,
      account: { id: connectedAccounts.id, email: connectedAccounts.email, label: connectedAccounts.label },
    })
    .from(mailThreads)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, mailThreads.accountId))
    .where(and(eq(mailThreads.id, threadId), eq(mailThreads.userId, userId)))
    .limit(1);
  const head = rows[0];
  if (!head) return null;
  const messages = await ex
    .select(threadViewMessageColumns)
    .from(mailMessages)
    .where(and(eq(mailMessages.threadId, threadId), eq(mailMessages.userId, userId)))
    .orderBy(asc(mailMessages.internalDate), asc(mailMessages.id));
  const ids = messages.map((m) => m.id);
  const attachments =
    ids.length === 0
      ? []
      : await ex
          .select()
          .from(mailAttachments)
          .where(and(inArray(mailAttachments.messageId, ids), eq(mailAttachments.userId, userId)))
          .orderBy(asc(mailAttachments.partId));
  return {
    thread: head.thread,
    account: head.account,
    messages: messages.map((m) => ({ ...m, attachments: attachments.filter((a) => a.messageId === m.id) })),
  };
}

export type AccountMailStatus = {
  accountId: string;
  backfillStatus: MailSyncState["backfillStatus"];
  backfillListed: number;
  resyncing: boolean;
  queued: number;
  lastHistorySyncAt: Date | null;
  lastError: string | null;
  watchExpiresAt: Date | null;
};

/** Per-account ingestion status for the user's accounts that have a sync state row. */
export async function mailStatusByAccount(ex: Executor, userId: string): Promise<Map<string, AccountMailStatus>> {
  const rows = await ex
    .select({
      accountId: mailSyncState.accountId,
      backfillStatus: mailSyncState.backfillStatus,
      backfillListed: mailSyncState.backfillListed,
      resyncAfter: mailSyncState.resyncAfter,
      lastHistorySyncAt: mailSyncState.lastHistorySyncAt,
      lastError: mailSyncState.lastError,
      watchExpiresAt: mailSyncState.watchExpiresAt,
      queued: sql<number>`(select count(*)::int from mail_fetch_queue q where q.account_id = ${mailSyncState.accountId} and q.next_attempt_at < ${PARKED_AT.toISOString()}::timestamptz)`,
    })
    .from(mailSyncState)
    .where(eq(mailSyncState.userId, userId));
  return new Map(
    rows.map((r) => [
      r.accountId,
      {
        accountId: r.accountId,
        backfillStatus: r.backfillStatus,
        backfillListed: r.backfillListed,
        resyncing: r.resyncAfter !== null,
        queued: r.queued,
        lastHistorySyncAt: r.lastHistorySyncAt,
        lastError: r.lastError,
        watchExpiresAt: r.watchExpiresAt,
      },
    ]),
  );
}

/** Phase 2c: the thread's latest inbound message's triage row (any status), for the thread page. */
export async function latestThreadTriage(ex: Executor, userId: string, threadId: string): Promise<MailTriage | null> {
  const [latest] = await ex
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(and(eq(mailMessages.threadId, threadId), eq(mailMessages.userId, userId), eq(mailMessages.isSent, false)))
    .orderBy(desc(mailMessages.internalDate), desc(mailMessages.id))
    .limit(1);
  if (!latest) return null;
  const [row] = await ex
    .select()
    .from(mailTriage)
    .where(and(eq(mailTriage.messageId, latest.id), eq(mailTriage.userId, userId)))
    .orderBy(desc(mailTriage.updatedAt))
    .limit(1);
  return row ?? null;
}
