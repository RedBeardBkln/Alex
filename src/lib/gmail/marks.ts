/**
 * Marker values shared by the sync engine and the UI. Kept in their own module so pages can read
 * them without importing the sync engine (and, through it, the ingest-time renderer).
 */

/** Marker in mail_sync_state.last_error so the reauth skip is audited once per transition. */
export const REAUTH_MARK = "reauth_required";
