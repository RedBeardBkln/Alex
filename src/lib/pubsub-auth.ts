import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Verifies the OIDC token Pub/Sub attaches to authenticated push requests
 * (https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions): signature against
 * Google's JWKS, issuer, audience and expiry (checked by jose), then the service account email
 * and email_verified.
 */

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export type PubSubAuthConfig = { audience: string; serviceAccount: string };

let remoteKeys: JWTVerifyGetKey | undefined;

/** Google's signing keys, fetched and cached by jose. */
export function googleJwks(): JWTVerifyGetKey {
  remoteKeys ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return remoteKeys;
}

export type PubSubAuthResult = { ok: true } | { ok: false; reason: string };

export async function verifyPubSubToken(
  authorization: string | null,
  config: PubSubAuthConfig,
  keys: JWTVerifyGetKey = googleJwks(),
): Promise<PubSubAuthResult> {
  const match = authorization?.match(/^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/);
  if (!match) return { ok: false, reason: "missing_or_malformed" };
  try {
    const { payload } = await jwtVerify(match[1]!, keys, {
      issuer: GOOGLE_ISSUERS,
      audience: config.audience,
      algorithms: ["RS256"],
    });
    if (payload.email !== config.serviceAccount) return { ok: false, reason: "wrong_email" };
    if (payload.email_verified !== true) return { ok: false, reason: "email_not_verified" };
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    return { ok: false, reason: typeof code === "string" ? code : "invalid_token" };
  }
}
