/**
 * Content-free error codes for logs and audit details (phase-2-followups-2, N6: one shared helper).
 * Neither function ever returns an error message, which can carry addresses or other data.
 */

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
