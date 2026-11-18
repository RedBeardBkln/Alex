import { describe, expect, it } from "vitest";
import "./setup-env";
import { env } from "@/lib/env";
import {
  authorizationUrl,
  GOOGLE_SCOPES,
  isAllowedEmail,
  missingScopes,
  reconnectBy,
  redirectUri,
  REQUIRED_ACCOUNT_SCOPES,
} from "@/lib/google";

describe("env", () => {
  it("normalizes allowed emails and strips the trailing slash from APP_URL", () => {
    expect(env().ALEX_ALLOWED_EMAILS).toEqual(["owner@example.com", "second@example.com"]);
    expect(env().APP_URL).toBe("https://alex.example.com");
  });
});

describe("allowlist", () => {
  it("matches case-insensitively", () => {
    expect(isAllowedEmail("OWNER@example.com", env().ALEX_ALLOWED_EMAILS)).toBe(true);
    expect(isAllowedEmail("intruder@example.com", env().ALEX_ALLOWED_EMAILS)).toBe(false);
  });
});

describe("scopes", () => {
  it("reports nothing missing when all scopes are granted", () => {
    expect(missingScopes(["openid", ...REQUIRED_ACCOUNT_SCOPES])).toEqual([]);
  });
  it("reports unticked scopes", () => {
    expect(missingScopes([GOOGLE_SCOPES.gmailModify])).toEqual([
      GOOGLE_SCOPES.calendarReadonly,
      GOOGLE_SCOPES.calendarEvents,
      GOOGLE_SCOPES.driveFile,
    ]);
  });
});

describe("reconnectBy", () => {
  it("is 7 days after consent in testing mode", () => {
    const consented = new Date("2026-11-01T12:00:00Z");
    expect(reconnectBy(consented, true)?.toISOString()).toBe("2026-11-08T12:00:00.000Z");
  });
  it("is null once the app is published", () => {
    expect(reconnectBy(new Date(), false)).toBeNull();
  });
});

describe("authorizationUrl", () => {
  it("requests offline access, consent, all scopes and PKCE for connecting accounts", () => {
    const url = authorizationUrl("connect", "state123", "verifier-verifier-verifier-verifier-verifier");
    expect(url.origin).toBe("https://accounts.google.com");
    const p = url.searchParams;
    expect(p.get("redirect_uri")).toBe("https://alex.example.com/api/accounts/google/callback");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent select_account");
    expect(p.get("state")).toBe("state123");
    expect(p.get("code_challenge_method")).toBe("S256");
    const scopes = p.get("scope")!.split(" ");
    for (const s of REQUIRED_ACCOUNT_SCOPES) expect(scopes).toContain(s);
  });

  it("requests identity only for sign-in", () => {
    const url = authorizationUrl("login", "s", "verifier-verifier-verifier-verifier-verifier");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("access_type")).toBeNull();
    expect(redirectUri("login")).toBe("https://alex.example.com/api/auth/google/callback");
  });
});
