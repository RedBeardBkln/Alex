import { and, eq } from "drizzle-orm";
import type { Executor } from "@/db";
import { accountSignatures, type AccountSignature } from "@/db/schema";

/**
 * Page-safe reads of the stored signatures (phase email-signatures). Selects only; imports nothing
 * from the converter, the Gmail client or the sync engine, so pages and actions can use it.
 */

export type StoredSignature = Pick<AccountSignature, "state" | "lastErrorCode" | "checkedAt" | "fetchedAt"> & { text: string | null };

/** The snapshot an `email.send` payload carries: `{ text }` when the stored state is `set`, otherwise null. */
export type SignatureSnapshot = { text: string } | null;

const columns = {
  accountId: accountSignatures.accountId,
  state: accountSignatures.state,
  text: accountSignatures.signatureText,
  lastErrorCode: accountSignatures.lastErrorCode,
  checkedAt: accountSignatures.checkedAt,
  fetchedAt: accountSignatures.fetchedAt,
};

/** The account's stored signature row, or null if it has never been checked. Scoped to the user. */
export async function currentSignature(ex: Executor, userId: string, accountId: string): Promise<StoredSignature | null> {
  const [row] = await ex
    .select(columns)
    .from(accountSignatures)
    .where(and(eq(accountSignatures.accountId, accountId), eq(accountSignatures.userId, userId)))
    .limit(1);
  if (!row) return null;
  return { state: row.state, text: row.text, lastErrorCode: row.lastErrorCode, checkedAt: row.checkedAt, fetchedAt: row.fetchedAt };
}

/** Every stored signature of the user's accounts, by account id (for the Accounts page). */
export async function signaturesByAccount(ex: Executor, userId: string): Promise<Map<string, StoredSignature>> {
  const rows = await ex.select(columns).from(accountSignatures).where(eq(accountSignatures.userId, userId));
  return new Map(
    rows.map((r) => [r.accountId, { state: r.state, text: r.text, lastErrorCode: r.lastErrorCode, checkedAt: r.checkedAt, fetchedAt: r.fetchedAt }]),
  );
}

/** `{ text }` when the row's state is `set` (and it has text), otherwise null. */
export function signatureSnapshot(row: Pick<StoredSignature, "state" | "text"> | null | undefined): SignatureSnapshot {
  return row?.state === "set" && row.text ? { text: row.text } : null;
}
