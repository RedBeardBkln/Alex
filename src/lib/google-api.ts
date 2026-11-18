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
