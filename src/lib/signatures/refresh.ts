import { eq } from "drizzle-orm";
import type { Executor } from "@/db";
import { accountSignatures, type AccountSignature, type ConnectedAccount } from "@/db/schema";
import { ReauthRequiredError } from "@/lib/accounts";
import { audit } from "@/lib/audit";
import { signatureUpdatedDetail, type SignatureAuditState } from "@/lib/audit-details";
import { lockAccountForWrite } from "@/lib/db-locks";
import { GmailApiError, GmailShapeError, type GmailClient } from "@/lib/gmail/client";
import { GOOGLE_REQUEST_TIMEOUT_MS } from "@/lib/google-api";
import { signatureToText } from "./convert";

/**
 * The signature stage of the sync (phase email-signatures, plan step 4). It runs in every cron and
 * connect run after the ingestion stages, also after a failed one, or before them for an account
 * that has never had a successful read (owner Round 4, R-1 A); never in push runs. It reads the account's own send-as entry once (1 quota unit),
 * converts its signature to plain text and stores the result in `account_signatures`.
 *
 * A failed read keeps the last good copy (owner Q3e): only `checked_at` and `last_error_code` change.
 * Nothing here ever fails the sync: every error except ReauthRequiredError (re-thrown, so the sync's
 * own reconnect path runs) is caught and logged as `{ accountId, code }`, never `mail.sync_error`.
 */

export type SignatureRead = { ok: true; state: NonNullable<AccountSignature["state"]>; text: string | null } | { ok: false; code: string };

const NAME_RE = /^[A-Za-z]{1,40}$/;

/**
 * Least run budget left for the signature read: one Google request timeout (googleRequest's default,
 * which settings.sendAs.get uses). A 401 refresh-and-retry can double it in the worst case, which the
 * gap between the 240 s budget and the route's 300 s maxDuration still covers.
 */
export const SIGNATURE_MIN_REMAINING_MS = GOOGLE_REQUEST_TIMEOUT_MS;

/**
 * Owner Round 4 (R-1 option A): true when the account has never had a successful read (no row, or a
 * row whose `state` is null), so the sync reads it before ingestion. A failed check (for example the
 * table missing before migration 0006) gives false, so it can never stop ingestion.
 */
export async function needsFirstSignatureRead(db: Executor, accountId: string): Promise<boolean> {
  try {
    const [row] = await db.select({ state: accountSignatures.state }).from(accountSignatures).where(eq(accountSignatures.accountId, accountId)).limit(1);
    return !row || row.state === null;
  } catch {
    return false;
  }
}

/** Content-free code of a failed read: `http_<status>[:<reason>]`, `shape`, or `error[:<Error.name>]`. */
export function signatureErrorCode(err: unknown): string {
  if (err instanceof GmailApiError) return `http_${err.status}${err.reason ? `:${err.reason}` : ""}`;
  if (err instanceof GmailShapeError) return "shape";
  if (err instanceof Error && NAME_RE.test(err.name)) return `error:${err.name}`;
  return "error";
}

/** Reads and converts the signature. Throws only ReauthRequiredError. */
export async function readSignature(gmail: GmailClient, account: Pick<ConnectedAccount, "email">): Promise<SignatureRead> {
  try {
    const res = await gmail.getSendAs(account.email);
    if (res.kind === "not_found") return { ok: true, state: "not_found", text: null };
    if (res.signature === null || res.signature === "") return { ok: true, state: "none", text: null };
    const converted = signatureToText(res.signature);
    return converted.state === "set" ? { ok: true, state: "set", text: converted.text } : { ok: true, state: converted.state, text: null };
  } catch (err) {
    if (err instanceof ReauthRequiredError) throw err;
    return { ok: false, code: signatureErrorCode(err) };
  }
}

/** Writes one read's result: one transaction, account locked first, audited only on a change. */
export async function storeSignatureRead(
  db: Executor,
  account: Pick<ConnectedAccount, "id" | "userId">,
  read: SignatureRead,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Lock order: the account first. A Disconnect that won leaves no account row: write nothing.
    if (!(await lockAccountForWrite(tx, account.id))) return false;
    let [row] = await tx.select().from(accountSignatures).where(eq(accountSignatures.accountId, account.id)).for("update");
    if (!row) {
      const inserted = await tx
        .insert(accountSignatures)
        .values(
          read.ok
            ? { accountId: account.id, userId: account.userId, state: read.state, signatureText: read.text, lastErrorCode: null, checkedAt: now, fetchedAt: now, changedAt: now }
            : { accountId: account.id, userId: account.userId, state: null, signatureText: null, lastErrorCode: read.code, checkedAt: now, fetchedAt: null, changedAt: now },
        )
        .onConflictDoNothing()
        .returning({ accountId: accountSignatures.accountId });
      if (inserted.length > 0) {
        const detail = read.ok ? signatureUpdatedDetail({ state: read.state, changed: "state" }) : signatureUpdatedDetail({ state: "unread", changed: "error", code: read.code });
        await audit({ userId: account.userId, accountId: account.id, action: "account.signature_updated", detail }, tx);
        return true;
      }
      // A concurrent first write won the insert: update its row instead.
      [row] = await tx.select().from(accountSignatures).where(eq(accountSignatures.accountId, account.id)).for("update");
      if (!row) return false;
    }
    const before: SignatureAuditState = row.state ?? "unread";
    if (read.ok) {
      const stateChanged = row.state !== read.state;
      const textChanged = row.signatureText !== read.text;
      const changed = stateChanged || textChanged || row.lastErrorCode !== null;
      await tx
        .update(accountSignatures)
        .set({
          state: read.state,
          signatureText: read.text,
          lastErrorCode: null,
          checkedAt: now,
          fetchedAt: now,
          ...(changed ? { changedAt: now } : {}),
        })
        .where(eq(accountSignatures.accountId, account.id));
      // Clearing an error isn't audited; a state change wins over a text change.
      if (stateChanged || textChanged) {
        await audit(
          {
            userId: account.userId,
            accountId: account.id,
            action: "account.signature_updated",
            detail: signatureUpdatedDetail({ state: read.state, changed: stateChanged ? "state" : "text" }),
          },
          tx,
        );
      }
      return true;
    }
    const newError = row.lastErrorCode !== read.code;
    await tx
      .update(accountSignatures)
      .set({ lastErrorCode: read.code, checkedAt: now, ...(newError ? { changedAt: now } : {}) })
      .where(eq(accountSignatures.accountId, account.id));
    // A repeated identical error isn't re-audited.
    if (newError) {
      await audit(
        {
          userId: account.userId,
          accountId: account.id,
          action: "account.signature_updated",
          detail: signatureUpdatedDetail({ state: before, changed: "error", code: read.code }),
        },
        tx,
      );
    }
    return true;
  });
}

/**
 * The sync stage: read, then store. Never throws except ReauthRequiredError. A failure (Gmail or
 * the database) is logged with the account id and a content-free code only.
 */
export async function refreshSignature(
  deps: { db: Executor; gmail: GmailClient; now: () => Date; remainingMs?: () => number },
  account: ConnectedAccount,
): Promise<void> {
  // Tester O-1: the read runs after the ingestion stages, so the run may be near its deadline. It is
  // skipped unless one whole request timeout is left: nothing is read, written or audited, and the
  // stored copy is used until the next run refreshes it.
  if (deps.remainingMs && deps.remainingMs() < SIGNATURE_MIN_REMAINING_MS) {
    console.warn("signature read skipped", { accountId: account.id, reason: "budget" });
    return;
  }
  const read = await readSignature(deps.gmail, account);
  if (!read.ok) console.error("signature read failed", { accountId: account.id, code: read.code });
  try {
    await storeSignatureRead(deps.db, account, read, deps.now());
  } catch (err) {
    if (err instanceof ReauthRequiredError) throw err;
    console.error("signature store failed", { accountId: account.id, code: signatureErrorCode(err) });
  }
}
