import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createLocalJWKSet, exportJWK, exportSPKI, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { verifyPubSubToken } from "@/lib/pubsub-auth";

// Tester-added edge cases for the Pub/Sub OIDC check (plan 6.8, AC 3). Keys are generated locally.
const config = { audience: "https://alex.example.com/api/gmail/push", serviceAccount: "push@test-project.iam.gserviceaccount.com" };

let privateKey: CryptoKey;
let publicPem: string;
let publicJwk: Record<string, unknown>;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicPem = await exportSPKI(pair.publicKey);
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  keys = createLocalJWKSet({ keys: [publicJwk as never] });
});

const b64 = (o: object | string) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const nowS = () => Math.floor(Date.now() / 1000);
const verify = (h: string | null) => verifyPubSubToken(h, config, keys);

function baseClaims(over: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: config.audience,
    email: config.serviceAccount,
    email_verified: true,
    iat: nowS(),
    exp: nowS() + 300,
    ...over,
  };
}

async function rs256(claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const payload = Object.fromEntries(Object.entries(claims).filter(([, v]) => v !== undefined));
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "k1", typ: "JWT", ...header }).sign(privateKey);
}

/** Hand-built HS256 token whose HMAC key is the RSA public key material (classic alg-confusion). */
function hs256With(secret: string | Buffer, claims: Record<string, unknown>) {
  const head = b64({ alg: "HS256", kid: "k1", typ: "JWT" });
  const body = b64(claims);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

describe("verifyPubSubToken: tester edge cases", () => {
  it("control: a well-formed token passes", async () => {
    expect(await verify(`Bearer ${await rs256(baseClaims())}`)).toEqual({ ok: true });
  });

  it("alg confusion: HS256 signed with the RSA public key (PEM, JWK n, JSON JWK) is rejected", async () => {
    for (const secret of [publicPem, String(publicJwk.n), JSON.stringify(publicJwk)]) {
      expect((await verify(`Bearer ${hs256With(secret, baseClaims())}`)).ok).toBe(false);
    }
  });

  it("alg none in every casing, with or without a trailing signature segment, is rejected", async () => {
    for (const alg of ["none", "None", "NONE", "nOnE"]) {
      const t = `${b64({ alg, typ: "JWT" })}.${b64(baseClaims())}`;
      expect((await verify(`Bearer ${t}.`)).ok).toBe(false);
      expect((await verify(`Bearer ${t}.AAAA`)).ok).toBe(false);
    }
  });

  it("a header that swaps in an embedded jwk or a jku is not trusted", async () => {
    const attacker = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(attacker.publicKey);
    const t = await new SignJWT(baseClaims()).setProtectedHeader({ alg: "RS256", kid: "k1", jwk } as never).sign(attacker.privateKey);
    expect((await verify(`Bearer ${t}`)).ok).toBe(false);
    const t2 = await new SignJWT(baseClaims())
      .setProtectedHeader({ alg: "RS256", kid: "k1", jku: "https://evil.example.com/jwks" } as never)
      .sign(attacker.privateKey);
    expect((await verify(`Bearer ${t2}`)).ok).toBe(false);
  });

  it("unknown kid is rejected", async () => {
    expect((await verify(`Bearer ${await rs256(baseClaims(), { kid: "other" })}`)).ok).toBe(false);
  });

  it("email_verified missing, string 'true', 1 or null is rejected", async () => {
    for (const v of [undefined, "true", 1, null, "True"]) {
      const res = await verify(`Bearer ${await rs256(baseClaims({ email_verified: v }))}`);
      expect(res).toEqual({ ok: false, reason: "email_not_verified" });
    }
  });

  it("email must match exactly (case, whitespace, lookalike suffix)", async () => {
    for (const email of [
      config.serviceAccount.toUpperCase(),
      ` ${config.serviceAccount}`,
      `${config.serviceAccount}.evil.example.com`,
      [config.serviceAccount],
    ]) {
      expect((await verify(`Bearer ${await rs256(baseClaims({ email }))}`)).ok).toBe(false);
    }
  });

  it("wrong audience variants are rejected (trailing slash, other path, missing)", async () => {
    for (const aud of [`${config.audience}/`, "https://alex.example.com/api/gmail", "https://alex.example.com", undefined]) {
      expect((await verify(`Bearer ${await rs256(baseClaims({ aud }))}`)).ok).toBe(false);
    }
  });

  it("an audience array that contains the configured audience is accepted (JWT aud semantics)", async () => {
    expect((await verify(`Bearer ${await rs256(baseClaims({ aud: ["https://other.example.com", config.audience] }))}`)).ok).toBe(true);
  });

  it("both issuer spellings pass; lookalikes and http fail", async () => {
    expect((await verify(`Bearer ${await rs256(baseClaims({ iss: "accounts.google.com" }))}`)).ok).toBe(true);
    expect((await verify(`Bearer ${await rs256(baseClaims({ iss: "https://accounts.google.com" }))}`)).ok).toBe(true);
    for (const iss of ["http://accounts.google.com", "https://accounts.google.com/", "accounts.google.com.evil.example.com", "https://ACCOUNTS.google.com", undefined]) {
      expect((await verify(`Bearer ${await rs256(baseClaims({ iss }))}`)).ok).toBe(false);
    }
  });

  it("expired (even by a few seconds) is rejected", async () => {
    expect((await verify(`Bearer ${await rs256(baseClaims({ exp: nowS() - 5 }))}`)).ok).toBe(false);
  });

  it("nbf in the future is rejected", async () => {
    expect((await verify(`Bearer ${await rs256(baseClaims({ nbf: nowS() + 600 }))}`)).ok).toBe(false);
  });

  it("observed behaviour: iat in the future is accepted (jose checks iat only with maxTokenAge)", async () => {
    // Informational: only Google can sign these tokens, and exp still bounds their lifetime.
    const res = await verify(`Bearer ${await rs256(baseClaims({ iat: nowS() + 3600, exp: nowS() + 7200 }))}`);
    expect(res.ok).toBe(true);
  });

  it("observed behaviour: a Google-signed token with no exp is accepted (jose only checks exp if present)", async () => {
    // Only Google can sign these, and Google ID tokens always carry exp, so this is informational.
    const res = await verify(`Bearer ${await rs256(baseClaims({ exp: undefined }))}`);
    expect(res.ok).toBe(true);
  });

  it("bearer prefix and token shape are strict", async () => {
    const t = await rs256(baseClaims());
    for (const h of [`bearer ${t}`, `Bearer  ${t} `, `Bearer ${t}\n`, `Bearer ${t},Bearer ${t}`, `Bearer ${t}.extra`, `${t}`]) {
      expect((await verify(h)).ok).toBe(false);
    }
  });
});
