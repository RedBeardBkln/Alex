import { and, eq } from "drizzle-orm";
import type { Executor } from "@/db";
import { connectedAccounts, type ApprovalItem, type ConnectedAccount } from "@/db/schema";
import type { GmailClient } from "@/lib/gmail/client";
import { itemsToReconcile, markReconciledSent, markStuckUnknown } from "./service";

/**
 * Reconciles sends whose outcome isn't known (plan §5.4): `unknown` items, and `executing` items
 * older than 10 minutes. For each it looks the message up by our Message-ID with
 * `messages.list?q=rfc822msgid:<id>` (a documented messages.list query; read-only), then
 * `messages.get?format=minimal` for its labels. A hit in this account that carries SENT means
 * it was sent. Nothing is ever re-sent from here.
 */

export type ReconcileDeps = { db: Executor; gmailFor: (account: ConnectedAccount) => GmailClient; now?: () => Date };

export type ReconcileResult = { checked: number; found: number; markedUnknown: number; errors: number };

async function reconcileOne(deps: ReconcileDeps, item: ApprovalItem, now: Date): Promise<"found" | "marked_unknown" | "none" | "error"> {
  if (!item.accountId || !item.messageIdHeader) return "none";
  const [account] = await deps.db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.id, item.accountId), eq(connectedAccounts.userId, item.userId)))
    .limit(1);
  if (!account || account.status !== "active") return "none";
  try {
    // The lookup runs in this account's own mailbox. A hit only counts if it carries SENT (review D3,
    // as the ingest hook requires): an inbound copy with our Message-ID is not proof of sending.
    const gmail = deps.gmailFor(account);
    const list = await gmail.listMessages({ labelIds: [], q: `rfc822msgid:${item.messageIdHeader}` });
    for (const hit of (list.messages ?? []).slice(0, 5)) {
      const meta = await gmail.getMessageMinimal(hit.id);
      if (!(meta.labelIds ?? []).includes("SENT")) continue;
      return (await markReconciledSent(deps.db, item, { gmailMessageId: meta.id, gmailThreadId: meta.threadId }, "list_found")) ? "found" : "none";
    }
  } catch (err) {
    console.error("approval reconcile lookup failed", { itemId: item.id, error: err instanceof Error ? err.name : "unknown" });
    return "error";
  }
  if (item.status === "executing") return (await markStuckUnknown(deps.db, item, now)) ? "marked_unknown" : "none";
  return "none";
}

/** The `gmail-sync` cron stage: up to 20 items per run. */
export async function reconcileApprovals(deps: ReconcileDeps, opts: { userId?: string; itemId?: string } = {}): Promise<ReconcileResult> {
  const now = (deps.now ?? (() => new Date()))();
  const items = await itemsToReconcile(deps.db, now, 20, opts.userId, opts.itemId);
  const result: ReconcileResult = { checked: items.length, found: 0, markedUnknown: 0, errors: 0 };
  for (const item of items) {
    const r = await reconcileOne(deps, item, now);
    if (r === "found") result.found++;
    else if (r === "marked_unknown") result.markedUnknown++;
    else if (r === "error") result.errors++;
  }
  return result;
}
