import type { NextRequest } from "next/server";
import { db } from "@/db";
import { upsertGoogleAccount } from "@/lib/accounts";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { googleClient, grantedScopes, identityFromTokens, missingScopes } from "@/lib/google";
import { redirectTo } from "@/lib/http";
import { finishOAuth } from "@/lib/oauth-state";
import { currentUser } from "@/lib/session";

export async function GET(request: NextRequest) {
  const user = await currentUser();
  if (!user) return redirectTo("/login");

  const params = request.nextUrl.searchParams;
  const pending = await finishOAuth("connect", params.get("state"));
  if (params.get("error")) return redirectTo("/", { error: "cancelled" });
  const code = params.get("code");
  if (!pending || !code) return redirectTo("/", { error: "state" });

  let tokens;
  try {
    tokens = await googleClient("connect").validateAuthorizationCode(code, pending.codeVerifier);
  } catch (err) {
    console.error("Account token exchange failed", err);
    return redirectTo("/", { error: "google" });
  }

  const identity = identityFromTokens(tokens);
  const scopes = grantedScopes(tokens);
  const missing = missingScopes(scopes);
  if (missing.length > 0) {
    // The user unticked a permission on Google's consent screen; Alex can't work without it.
    await googleClient("connect").revokeToken(tokens.accessToken()).catch(() => undefined);
    return redirectTo("/", { error: "missing_scopes", email: identity.email });
  }

  const account = await upsertGoogleAccount(db(), {
    userId: user.id,
    identity,
    label: pending.label ?? "personal",
    key: env().ALEX_ENCRYPTION_KEY,
    tokens: {
      accessToken: tokens.accessToken(),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt(),
      refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
      scopes,
    },
  });
  await audit({ userId: user.id, accountId: account.id, action: "account.connected", detail: { email: account.email, label: account.label } });
  return redirectTo("/", { connected: account.email });
}
