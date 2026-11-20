import { eq } from "drizzle-orm";
import type { Executor } from "@/db";
import { connectedAccounts } from "@/db/schema";

/**
 * Lock order for Disconnect (phase-2-followups-1, owner Q6). Every transaction that writes a row the
 * account's deletion cascades to (or sets null) and also inserts a row with an `account_id` foreign
 * key calls this as its FIRST statement, before any row write or advisory lock.
 *
 * Why: the FK check on that insert takes FOR KEY SHARE on the account row, and Disconnect's DELETE
 * takes FOR UPDATE on it and then, in its cascade, the transaction's rows. Taken late, the two orders
 * cross and Postgres aborts one side (40P01). Taken first, KEY SHARE simply waits for a Disconnect
 * that holds the account (after which the row is gone and this returns false), or makes the
 * Disconnect wait until this transaction commits. KEY SHARE doesn't conflict with the FOR NO KEY
 * UPDATE that token refreshes and status updates take, so sign-in and sync aren't slowed.
 *
 * Returns true if the account row exists (and is now locked), false if it doesn't.
 */
export async function lockAccountForWrite(tx: Executor, accountId: string): Promise<boolean> {
  const rows = await tx.select({ id: connectedAccounts.id }).from(connectedAccounts).where(eq(connectedAccounts.id, accountId)).for("key share");
  return rows.length > 0;
}
