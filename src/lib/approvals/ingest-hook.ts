import { and, eq, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
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
 */
export async function onMessageStored(
  tx: Executor,
  m: {
    accountId: string;
    threadId: string;
    /** mail_messages.id of the stored message. */
    messageId: string;
    gmailMessageId: string;
    gmailThreadId: string;
    rfc822MessageId: string | null;
    isSent: boolean;
    internalDate: Date;
  },
): Promise<void> {
  const header = m.rfc822MessageId?.trim() || null;
  if (header) {
    const own = await tx
      .select({ id: approvalItems.id, userId: approvalItems.userId, accountId: approvalItems.accountId, status: approvalItems.status })
      .from(approvalItems)
      .where(and(eq(approvalItems.accountId, m.accountId), eq(approvalItems.messageIdHeader, header)));
    // Only a SENT copy in the same account (the query is account-scoped) is one of Alex's own sends,
    // the same rule reconcile uses (D3). An inbound or other non-SENT message that reuses one of our
    // Message-IDs is treated like any other new message and still raises the Q6 warning below
    // (security review S1).
    if (own.length > 0 && m.isSent) {
      for (const item of own) {
        if (item.status === "unknown" || item.status === "executing") {
          await markReconciledSent(tx, item, { gmailMessageId: m.gmailMessageId, gmailThreadId: m.gmailThreadId }, "ingest_match");
        }
      }
      return;
    }
  }
  // Review D1: compare with the message the owner replied to, not the item's creation time. A message
  // Gmail received shortly before the reply was saved may only be synced afterwards (push or cron
  // lag), and the owner never saw it. The baseline is parent_internal_date, copied at propose time, so it
  // still holds if the parent row is deleted (review D5). Only an item without it uses created_at.
  await tx
    .update(approvalItems)
    .set({ threadChangedAt: new Date() })
    .where(
      and(
        eq(approvalItems.threadId, m.threadId),
        inArray(approvalItems.status, ["pending", "failed"]),
        isNotNull(approvalItems.threadId),
        or(isNull(approvalItems.parentMessageId), ne(approvalItems.parentMessageId, m.messageId)),
        or(
          lt(approvalItems.parentInternalDate, m.internalDate),
          and(isNull(approvalItems.parentInternalDate), lt(approvalItems.createdAt, m.internalDate)),
        ),
      ),
    );
}
