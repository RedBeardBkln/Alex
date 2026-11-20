import { db, schema } from "@/db";
import type { Executor } from "@/db";

/**
 * Appends an audit entry. Pass `database` to write through a specific client or transaction
 * (defaults to the shared client). Never put message content, addresses or tokens in `detail`.
 */
export async function audit(
  entry: {
    userId: string | null;
    accountId?: string | null;
    action: string;
    detail?: Record<string, unknown>;
  },
  database: Executor = db(),
): Promise<void> {
  await database
    .insert(schema.auditLog)
    .values({ userId: entry.userId, accountId: entry.accountId ?? null, action: entry.action, detail: entry.detail });
}
