/**
 * `detail` payloads for the account and login audit entries (phase-2a-followups, owner Q3). None of
 * them holds an email address: the owner is identified by `user_id`, a connected account by
 * `account_id` (or by its uuid in `detail` once the row is deleted). Import-free, so the page-side
 * server actions can use it.
 */

/** `account.connected`: the account itself is the entry's `account_id`. */
export function accountConnectedDetail(account: { label: string }): Record<string, unknown> {
  return { label: account.label };
}

/** `account.disconnected`: the row is already deleted, so its uuid goes in `detail` (not personal data). */
export function accountDisconnectedDetail(account: { id: string; provider: string; label: string }): Record<string, unknown> {
  return { accountId: account.id, provider: account.provider, label: account.label };
}

/** `login`: nothing beyond `user_id`. */
export function loginDetail(): Record<string, unknown> | undefined {
  return undefined;
}

/** `login.denied`: only the domain of the address that was refused (lowercased), or null if it has none. */
export function loginDeniedDetail(email: string): Record<string, unknown> {
  const at = email.lastIndexOf("@");
  const domain = at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
  return { domain: domain.length > 0 && !domain.includes("@") ? domain : null };
}

/** The `state` reported by `account.signature_updated`: the stored state, or "unread" (never read successfully). */
export type SignatureAuditState = "set" | "none" | "not_found" | "too_large" | "unread";

/**
 * `account.signature_updated` (phase email-signatures, owner Q6): only the state, what changed and a
 * content-free error code. Never any signature text, HTML, hash or length of it, link or address.
 */
export function signatureUpdatedDetail(entry: { state: SignatureAuditState; changed: "text" | "state" | "error"; code?: string }): Record<string, unknown> {
  return entry.code === undefined ? { state: entry.state, changed: entry.changed } : { state: entry.state, changed: entry.changed, code: entry.code };
}
