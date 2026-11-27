import { db } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { getAccessToken } from "@/lib/accounts";
import { env } from "@/lib/env";
import { googleClient } from "@/lib/google";

/** Access token for a connected Google account, refreshed if needed. */
export async function googleAccessToken(account: ConnectedAccount): Promise<string> {
  return getAccessToken(db(), account, env().ALEX_ENCRYPTION_KEY, async (refreshToken) => {
    const tokens = await googleClient("connect").refreshAccessToken(refreshToken);
    return { accessToken: tokens.accessToken(), accessTokenExpiresAt: tokens.accessTokenExpiresAt() };
  });
}

export type TokenProvider = (opts?: { forceRefresh?: boolean }) => Promise<string>;

/**
 * Access-token source for a long run of API calls on one account. The token is cached in memory;
 * `forceRefresh` (used after a 401) refreshes it at Google even if it looks unexpired. A rejected
 * refresh token marks the account `reauth_required` and throws ReauthRequiredError.
 */
export function googleTokenProvider(account: ConnectedAccount): TokenProvider {
  let cached: string | null = null;
  return async (opts = {}) => {
    if (cached && !opts.forceRefresh) return cached;
    cached = await googleAccessToken(opts.forceRefresh ? { ...account, accessTokenExpiresAt: null } : account);
    return cached;
  };
}

/** Default timeout of one Google API request, in ms. */
export const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;

export type GoogleResponse = { status: number; ok: boolean; body: unknown };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Status-aware Google API call. Never throws on an HTTP error: callers decide what each status
 * means. The parsed JSON body (or null) is returned as-is; validate it before use.
 */
export async function googleRequest(
  url: string,
  accessToken: string,
  init: { method?: "GET" | "POST"; json?: unknown; timeoutMs?: number } = {},
  fetchImpl: FetchLike = fetch,
): Promise<GoogleResponse> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchImpl(url, {
    method: init.method ?? "GET",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    cache: "no-store",
    signal: AbortSignal.timeout(init.timeoutMs ?? GOOGLE_REQUEST_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, ok: res.ok, body };
}

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${new URL(url).host} returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

export type ConnectionCheck = { gmailMessagesTotal: number; calendars: number };

/** Read-only check that the stored tokens work for Gmail and Calendar. */
export async function checkGoogleConnection(account: ConnectedAccount): Promise<ConnectionCheck> {
  const token = await googleAccessToken(account);
  const [profile, calendars] = await Promise.all([
    getJson<{ messagesTotal: number }>("https://gmail.googleapis.com/gmail/v1/users/me/profile", token),
    getJson<{ items?: unknown[] }>("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250", token),
  ]);
  return { gmailMessagesTotal: profile.messagesTotal, calendars: calendars.items?.length ?? 0 };
}
