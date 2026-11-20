import type { Executor } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { GmailClient } from "./client";
import { describeError } from "./errors";

/*
 * Kept out of sync.ts so the disconnect server action (imported by the (app) layout, and so by
 * every app page) doesn't pull in the sync engine and, through it, the ingest-time renderer.
 */

/** Upper bound on the best-effort users.stop during disconnect, including any token refresh. */
export const STOP_OVERALL_TIMEOUT_MS = 8_000;

/**
 * Best-effort users.stop before an account is disconnected. Never throws: a failure must not
 * block the disconnect.
 */
export async function stopWatchBeforeDisconnect(
  db: Executor,
  account: ConnectedAccount,
  gmail: GmailClient,
  timeoutMs = STOP_OVERALL_TIMEOUT_MS,
): Promise<boolean> {
  if (account.provider !== "google" || account.status !== "active") return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bounded overall (token refresh plus the call), so the disconnect click can't hang.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("stop timed out"), { name: "TimeoutError" })), timeoutMs);
    });
    await Promise.race([gmail.stop(), timeout]);
    await audit({ userId: account.userId, accountId: account.id, action: "mail.watch_stopped" }, db);
    return true;
  } catch (err) {
    const { status, reason } = describeError(err);
    await audit(
      { userId: account.userId, accountId: account.id, action: "mail.watch_failed", detail: { op: "stop", status, reason } },
      db,
    ).catch(() => undefined);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
