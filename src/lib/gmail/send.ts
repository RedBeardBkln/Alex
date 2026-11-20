import { z } from "zod";
import { ReauthRequiredError } from "@/lib/accounts";
import { googleRequest, type FetchLike, type TokenProvider } from "@/lib/google-api";
import { GMAIL_BASE } from "./client";

/**
 * The only Gmail send in Alex (Phase 2b, AC2): users.messages.send with a raw RFC 2822 message.
 * Called only by the approval executor (src/lib/approvals/execute.ts), after it has won the
 * approved -> executing claim for an item the owner approved.
 *
 * Reference (developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send):
 * `POST https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/send`; the request body is a
 * Message (here `raw`, "the entire email message in an RFC 2822 formatted and base64url encoded
 * string", plus `threadId`); the response is a Message. gmail.modify is one of the accepted scopes.
 */

export type SendOutcome =
  | { kind: "succeeded"; gmailMessageId: string; gmailThreadId: string }
  /** Definitely not sent. `status` is the HTTP status when Gmail answered. */
  | { kind: "failed"; code: string; status: number | null }
  /** May or may not have been sent: never retried automatically. */
  | { kind: "unknown"; code: string; status: number | null };

const sentSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), threadId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) });

/** Send timeout. Inside the approve Server Action (maxDuration 60 s). */
export const SEND_TIMEOUT_MS = 30_000;

/**
 * Classifies a Gmail answer (plan §5.3). 2xx: succeeded. Only 400, 401, 403, 404 and 429 count as
 * definitely not sent (failed; an assumption the plan records as R3). Every other status, including
 * 408, 409 and 499 (a cancelled request, which may already have been processed) and every 5xx, is
 * unknown: reconciled, never retried automatically, and only the owner can mark it not sent.
 */
export const DEFINITELY_NOT_SENT = new Set([400, 401, 403, 404, 429]);

export function classifySendStatus(status: number): "succeeded" | "failed" | "unknown" {
  if (status >= 200 && status < 300) return "succeeded";
  if (DEFINITELY_NOT_SENT.has(status)) return "failed";
  return "unknown";
}

/**
 * Sends `raw` in `threadId` (null: a new thread). Never throws: every outcome is classified.
 * - The token is fetched before any request; ReauthRequiredError (or any other token failure)
 *   means nothing was sent.
 * - Exactly one request is made. 400, 401, 403, 404 and 429 are `failed` (definitely not sent);
 *   any other non-2xx status is `unknown`.
 * - A network error or timeout after the request was started is ambiguous: `unknown`.
 */
export async function sendRawMessage(
  getToken: TokenProvider,
  req: { raw: string; threadId: string | null },
  fetchImpl: FetchLike = fetch,
): Promise<SendOutcome> {
  const body = req.threadId === null ? { raw: req.raw } : { raw: req.raw, threadId: req.threadId };
  const url = `${GMAIL_BASE}/messages/send`;

  let token: string;
  try {
    token = await getToken();
  } catch (err) {
    return { kind: "failed", code: err instanceof ReauthRequiredError ? "reauth_required" : "token_unavailable", status: null };
  }

  // Exactly one request. A 401 is not retried (review round 1): it counts as definitely not sent,
  // and sending again needs a new approval click (Q8), so no path can ever send twice.
  let res;
  try {
    res = await googleRequest(url, token, { method: "POST", json: body, timeoutMs: SEND_TIMEOUT_MS }, fetchImpl);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { kind: "unknown", code: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", status: null };
  }
  const cls = classifySendStatus(res.status);
  if (cls === "succeeded") {
    const parsed = sentSchema.safeParse(res.body);
    // Accepted but the answer is unreadable: it was most likely sent; reconcile finds it.
    if (!parsed.success) return { kind: "unknown", code: "gmail_shape", status: res.status };
    return { kind: "succeeded", gmailMessageId: parsed.data.id, gmailThreadId: parsed.data.threadId };
  }
  const code = res.status >= 500 ? "gmail_5xx" : `gmail_${res.status}`;
  return cls === "failed" ? { kind: "failed", code, status: res.status } : { kind: "unknown", code, status: res.status };
}
