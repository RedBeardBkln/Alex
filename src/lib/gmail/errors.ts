import { GmailApiError, GmailShapeError } from "./client";

/** Content-free description of an error for last_error and the audit log. */
export function describeError(err: unknown): { status: number | null; reason: string } {
  if (err instanceof GmailApiError) return { status: err.status, reason: err.reason ?? err.op };
  if (err instanceof GmailShapeError) return { status: null, reason: `unexpected_shape:${err.op}` };
  if (err instanceof Error && err.name === "TimeoutError") return { status: null, reason: "timeout" };
  return { status: null, reason: err instanceof Error ? err.name : "unknown" };
}
