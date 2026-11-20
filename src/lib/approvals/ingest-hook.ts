import { and, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { approvalItems } from "@/db/schema";
import { markReconciledSent } from "./service";

/**
 * Called by 2a's storeMessage, in its transaction, when a message is newly stored (plan §5.4 and
 * owner Q6):
 * - a SENT message in the same account whose Message-ID is an `unknown` or `executing` item's
 *   header means that send happened: the item becomes `succeeded` (approval.reconciled, outcome
 *   ingest_match). A SENT copy of one of our sends never raises the warning.
 * - any other new message (including an inbound one reusing one of our Message-IDs) in the thread
 *   of a pending or failed item, newer than the message being replied to, sets thread_changed_at,
 *   so the approval screen warns and asks for confirmation. The item itself is never changed.
 *   Every flag write moves the value strictly forward (see flagThreadItems), so a new flag never
 *   equals a value a page could have shown.
 */
export type StoredMessage = {
  accountId: string;
  threadId: string;
  /** mail_messages.id of the stored message. */
  messageId: string;
  gmailMessageId: string;
  gmailThreadId: string;
  rfc822MessageId: string | null;
  isSent: boolean;
  internalDate: Date;
  /**
   * E5 follow-up (owner Q4, round 2): the ids of the items this message's in-transaction step
   * flagged (onMessageStored's result). The post-commit step skips exactly these, so the message never
   * moves its own flag twice, and re-flags every other matching item. storeMessage sets it; a direct
   * caller that omits it gets the unguarded re-flag (the pre-E5 behaviour).
   */
  flaggedIds?: string[];
};

/**
 * The approval items this message is Alex's own SENT copy of, or null if it isn't one. Only a SENT
 * copy in the same account (the query is account-scoped) counts, the same rule reconcile uses
 * (D3). An inbound or other non-SENT message reusing one of our Message-IDs is a new message like
 * any other and raises the Q6 warning (security review S1).
 */
async function ownSentCopyOf(ex: Executor, m: StoredMessage) {
  const header = m.rfc822MessageId?.trim() || null;
  if (!header || !m.isSent) return null;
  const own = await ex
    .select({ id: approvalItems.id, userId: approvalItems.userId, accountId: approvalItems.accountId, status: approvalItems.status })
    .from(approvalItems)
    .where(and(eq(approvalItems.accountId, m.accountId), eq(approvalItems.messageIdHeader, header)));
  return own.length > 0 ? own : null;
}

/** Returns the ids of the items it flagged (none for Alex's own SENT copy). */
export async function onMessageStored(tx: Executor, m: StoredMessage): Promise<string[]> {
  const own = await ownSentCopyOf(tx, m);
  if (own) {
    for (const item of own) {
      if (item.status === "unknown" || item.status === "executing") {
        await markReconciledSent(tx, item, { gmailMessageId: m.gmailMessageId, gmailThreadId: m.gmailThreadId }, "ingest_match");
      }
    }
    return [];
  }
  return flagThreadItems(tx, m, false);
}

/**
 * Round 3, E2: runs again after storeMessage's transaction has committed. proposeReply also
 * re-checks after its own commit. Whichever of the two commits second, its post-commit step runs
 * after both are committed and sees the other (READ COMMITTED: every statement reads the latest
 * committed data), so a reply saved while this message was being stored is always flagged, with no
 * lock and no waiting on each other.
 *
 * E5 follow-up: advisory. storeMessage catches an error from here, logs and audits it
 * (approval.recheck_failed) and carries on, so the sync run isn't ended by it. The re-flag skips
 * only the items this message's own in-transaction step flagged (`flaggedIds`, owner Q4 round 2).
 * Neither a literal IS NULL guard nor a timestamp comparison is used: either could skip an item
 * created with an older (or same-millisecond) flag that then raced this message.
 */
export async function afterMessageCommitted(ex: Executor, m: StoredMessage): Promise<void> {
  if (await ownSentCopyOf(ex, m)) return;
  await flagThreadItems(ex, m, true);
}

async function flagThreadItems(tx: Executor, m: StoredMessage, postCommit: boolean): Promise<string[]> {
  // Review D1: compare with the message the owner replied to, not the item's creation time. A message
  // Gmail received shortly before the reply was saved may only be synced afterwards (push or cron
  // lag), and the owner never saw it. The baseline is parent_internal_date, copied at propose time, so it
  // still holds if the parent row is deleted (review D5). Only an item without it uses created_at.
  // Round 2 (D1): the new value is strictly later than the stored one (at least 1 ms, so it stays a
  // whole millisecond like every value Alex writes), so it never equals what a page showed, even
  // when two flags are taken in the same millisecond. GREATEST ignores a NULL stored value.
  const now = new Date().toISOString();
  const own = postCommit ? (m.flaggedIds ?? []) : [];
  const rows = await tx
    .update(approvalItems)
    .set({ threadChangedAt: sql`greatest(${now}::timestamptz, ${approvalItems.threadChangedAt} + interval '1 millisecond')` })
    .where(
      and(
        eq(approvalItems.threadId, m.threadId),
        own.length > 0 ? notInArray(approvalItems.id, own) : undefined,
        inArray(approvalItems.status, ["pending", "failed"]),
        isNotNull(approvalItems.threadId),
        or(isNull(approvalItems.parentMessageId), ne(approvalItems.parentMessageId, m.messageId)),
        or(
          lt(approvalItems.parentInternalDate, m.internalDate),
          and(isNull(approvalItems.parentInternalDate), lt(approvalItems.createdAt, m.internalDate)),
        ),
      ),
    )
    .returning({ id: approvalItems.id });
  return rows.map((r) => r.id);
}
