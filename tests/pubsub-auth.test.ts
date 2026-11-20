import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { verifyPubSubToken } from "@/lib/pubsub-auth";

// All keys are generated locally; nothing here talks to Google.
const config = { audience: "https://alex.example.com/api/gmail/push", serviceAccount: "push@test-project.iam.gserviceaccount.com" };

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherPrivateKey = other.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
});

type Claims = Record<string, unknown>;

async function token(
  over: { claims?: Claims; iss?: string; aud?: string; exp?: number | string; key?: CryptoKey; kid?: string } = {},
): Promise<string> {
  const jwt = new SignJWT({ email: config.serviceAccount, email_verified: true, ...over.claims })
    .setProtectedHeader({ alg: "RS256", kid: over.kid ?? "k1", typ: "JWT" })
    .setIssuer(over.iss ?? "https://accounts.google.com")
    .setAudience(over.aud ?? config.audience)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? "5m");
  return jwt.sign(over.key ?? privateKey);
}

const verify = (header: string | null) => verifyPubSubToken(header, config, keys);

describe("verifyPubSubToken", () => {
  it("accepts a valid token with either Google issuer spelling", async () => {
    expect(await verify(`Bearer ${await token()}`)).toEqual({ ok: true });
    expect(await verify(`Bearer ${await token({ iss: "accounts.google.com" })}`)).toEqual({ ok: true });
  });

  it("rejects a missing or malformed header", async () => {
    expect((await verify(null)).ok).toBe(false);
    expect((await verify("")).ok).toBe(false);
    expect((await verify("Bearer")).ok).toBe(false);
    expect((await verify("Bearer not-a-jwt")).ok).toBe(false);
    expect((await verify(`Basic ${await token()}`)).ok).toBe(false);
  });

  it("rejects a token signed by another key", async () => {
    expect((await verify(`Bearer ${await token({ key: otherPrivateKey })}`)).ok).toBe(false);
  });

  it("rejects a tampered payload", async () => {
    const [h, , s] = (await token()).split(".");
    const forged = Buffer.from(JSON.stringify({ email: config.serviceAccount, email_verified: true, aud: config.audience, iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
    expect((await verify(`Bearer ${h}.${forged}.${s}`)).ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const exp = Math.floor(Date.now() / 1000) - 120;
    expect((await verify(`Bearer ${await token({ exp })}`)).ok).toBe(false);
  });

  it("rejects the wrong issuer or audience", async () => {
    expect((await verify(`Bearer ${await token({ iss: "https://evil.example.com" })}`)).ok).toBe(false);
    expect((await verify(`Bearer ${await token({ aud: "https://alex.example.com/other" })}`)).ok).toBe(false);
  });

  it("rejects the wrong service account email, or email_verified false or missing", async () => {
    expect(await verify(`Bearer ${await token({ claims: { email: "someone@test-project.iam.gserviceaccount.com" } })}`)).toEqual({ ok: false, reason: "wrong_email" });
    expect(await verify(`Bearer ${await token({ claims: { email_verified: false } })}`)).toEqual({ ok: false, reason: "email_not_verified" });
    expect(await verify(`Bearer ${await token({ claims: { email_verified: "true" } })}`)).toEqual({ ok: false, reason: "email_not_verified" });
    expect(await verify(`Bearer ${await token({ claims: { email: undefined } })}`)).toEqual({ ok: false, reason: "wrong_email" });
  });

  it("rejects alg:none", async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      email: config.serviceAccount,
      email_verified: true,
      aud: config.audience,
      iss: "https://accounts.google.com",
      exp: Math.floor(Date.now() / 1000) + 300,
    })}.`;
    expect((await verify(`Bearer ${unsigned}`)).ok).toBe(false);
  });

  it("rejects an HS256 token even if signed with the public key material", async () => {
    const secret = new TextEncoder().encode("a-shared-secret-that-is-long-enough-for-hs256");
    const hs = await new SignJWT({ email: config.serviceAccount, email_verified: true })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(config.audience)
      .setExpirationTime("5m")
      .sign(secret);
    expect((await verify(`Bearer ${hs}`)).ok).toBe(false);
  });
});
