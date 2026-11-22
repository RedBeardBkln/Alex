import type { Executor } from "@/db";
import { audit } from "@/lib/audit";
import { errorName, sqlState } from "@/lib/pg-errors";

/**
 * E5 follow-up (owner Q5): the post-commit Q6 re-checks (afterMessageCommitted after storeMessage,
 * and the one at the end of proposeReply) are advisory. A failure is logged and audited here, with
 * ids and a content-free code only, and the caller carries on: the sync run continues and a saved
 * reply stays saved.
 *
 * SF2 (phase-2-followups-2, owner Q1 option c): a failed or skipped re-check can no longer let the
 * owner approve past an unseen message: approveItem recomputes the thread's newer-message set and
 * requires it to equal what the approval page showed. The audit stays as a diagnostic.
 */
export type RecheckStage = "ingest" | "propose";

// N6 (phase-2-followups-2): the helpers live in src/lib/pg-errors.ts; re-exported for existing importers.
export { errorName, sqlState };

/**
 * Logs and audits one failed re-check, outside any transaction. If the audit write fails too (for
 * example the database is down), that is only logged. Never throws.
 */
export async function recordRecheckFailure(
  ex: Executor,
  at: { stage: RecheckStage; userId: string; accountId: string | null; threadId: string; itemId?: string },
  err: unknown,
): Promise<void> {
  const code = sqlState(err);
  const error = errorName(err);
  console.error("approval re-check failed", { stage: at.stage, accountId: at.accountId, threadId: at.threadId, itemId: at.itemId ?? null, error, code });
  try {
    await audit(
      {
        userId: at.userId,
        accountId: at.accountId,
        action: "approval.recheck_failed",
        detail: { stage: at.stage, threadId: at.threadId, ...(at.itemId ? { itemId: at.itemId } : {}), code: code ?? error },
      },
      ex,
    );
  } catch (auditErr) {
    console.error("approval re-check audit failed", { stage: at.stage, error: errorName(auditErr), code: sqlState(auditErr) });
  }
}
