import { after, type NextRequest } from "next/server";
import { db } from "@/db";
import { upsertGoogleAccount } from "@/lib/accounts";
import { audit } from "@/lib/audit";
import { accountConnectedDetail } from "@/lib/audit-details";
import { env } from "@/lib/env";
import { defaultSyncDeps } from "@/lib/gmail/runtime";
import { syncAfterConnect } from "@/lib/gmail/sync";
import { googleClient, grantedScopes, identityFromTokens, missingScopes } from "@/lib/google";
import { redirectTo } from "@/lib/http";
import { finishOAuth } from "@/lib/oauth-state";
import { currentUser } from "@/lib/session";

// The after() ingestion setup below runs within this route's max duration (follow-up N4).
export const maxDuration = 300;

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
  await audit({ userId: user.id, accountId: account.id, action: "account.connected", detail: accountConnectedDetail(account) });
  // Mail ingestion setup (cursor, watch, 30-day backfill) runs after the redirect is sent.
  // If it is cut short, the 5-minute cron carries on from the stored state.
  after(async () => {
    await syncAfterConnect(defaultSyncDeps(), account.id).catch((err) =>
      console.error("mail setup after connect failed", { accountId: account.id, name: err instanceof Error ? err.name : "unknown" }),
    );
  });
  return redirectTo("/", { connected: account.email });
}
