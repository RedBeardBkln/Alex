import { decodeIdToken, Google, type OAuth2Tokens } from "arctic";
import { env } from "@/lib/env";

/**
 * Scopes, checked against the per-method scope lists in Google's official client library
 * (@googleapis/gmail, @googleapis/calendar):
 * - gmail.modify: read, label, draft and send (accepted by messages.list, messages.send, drafts.send).
 * - calendar.readonly: calendar list and free/busy across calendars.
 * - calendar.events: create and update events (invites).
 * - drive.file: only files Alex creates or you open with it (e.g. meeting briefs for reMarkable).
 */
export const GOOGLE_SCOPES = {
  gmailModify: "https://www.googleapis.com/auth/gmail.modify",
  calendarReadonly: "https://www.googleapis.com/auth/calendar.readonly",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
  driveFile: "https://www.googleapis.com/auth/drive.file",
} as const;

export const LOGIN_SCOPES = ["openid", "email", "profile"];
export const REQUIRED_ACCOUNT_SCOPES: string[] = Object.values(GOOGLE_SCOPES);
export const ACCOUNT_SCOPES = [...LOGIN_SCOPES, ...REQUIRED_ACCOUNT_SCOPES];

/** Google refresh tokens for External apps in "Testing" status expire 7 days after consent. */
export const TESTING_MODE_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type OAuthFlow = "login" | "connect";

export function redirectUri(flow: OAuthFlow): string {
  const base = env().APP_URL;
  return flow === "login" ? `${base}/api/auth/google/callback` : `${base}/api/accounts/google/callback`;
}

export function googleClient(flow: OAuthFlow): Google {
  const e = env();
  return new Google(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET, redirectUri(flow));
}

export function authorizationUrl(flow: OAuthFlow, state: string, codeVerifier: string): URL {
  const url = googleClient(flow).createAuthorizationURL(
    state,
    codeVerifier,
    flow === "login" ? LOGIN_SCOPES : ACCOUNT_SCOPES,
  );
  if (flow === "connect") {
    // Offline access + forced consent so Google returns a refresh token every time an account is (re)connected.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent select_account");
    url.searchParams.set("include_granted_scopes", "true");
  } else {
    url.searchParams.set("prompt", "select_account");
  }
  return url;
}

export type GoogleIdentity = { sub: string; email: string; name: string | null };

/**
 * Reads the ID token returned by Google's token endpoint. The token arrives over a direct TLS
 * connection from Google, so (per OpenID Connect Core 3.1.3.7) signature validation can be skipped.
 */
export function identityFromTokens(tokens: OAuth2Tokens): GoogleIdentity {
  const claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;
  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  if (!sub || !email) throw new Error("Google did not return an account id and email");
  if (claims.email_verified !== true) throw new Error("Google reports this email address as unverified");
  return { sub, email, name: typeof claims.name === "string" ? claims.name : null };
}

/** Scopes the user unticked on Google's consent screen. */
export function missingScopes(granted: string[]): string[] {
  const set = new Set(granted);
  return REQUIRED_ACCOUNT_SCOPES.filter((s) => !set.has(s));
}

export function grantedScopes(tokens: OAuth2Tokens): string[] {
  return tokens.hasScopes() ? tokens.scopes() : [];
}

/** When an account must be reconnected, or null if refresh tokens don't expire (app published). */
export function reconnectBy(consentedAt: Date, testingMode: boolean): Date | null {
  return testingMode ? new Date(consentedAt.getTime() + TESTING_MODE_TOKEN_LIFETIME_MS) : null;
}

export function isAllowedEmail(email: string, allowed: string[]): boolean {
  return allowed.includes(email.trim().toLowerCase());
}
