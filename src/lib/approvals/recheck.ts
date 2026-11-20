import type { Executor } from "@/db";
import { audit } from "@/lib/audit";

/**
 * E5 follow-up (owner Q5): the post-commit Q6 re-checks (afterMessageCommitted after storeMessage,
 * and the one at the end of proposeReply) are advisory. A failure is logged and audited here, with
 * ids and a content-free code only, and the caller carries on: the sync run continues and a saved
 * reply stays saved.
 */
export type RecheckStage = "ingest" | "propose";

/** A Postgres SQLSTATE (five characters, digits and capitals) from a drizzle or postgres-js error, or null. */
export function sqlState(err: unknown): string | null {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  const code = typeof e?.cause?.code === "string" ? e.cause.code : typeof e?.code === "string" ? e.code : null;
  return code !== null && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/** The error's class name if it looks like one, otherwise "unknown" (never the message). */
export function errorName(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "unknown";
}

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
