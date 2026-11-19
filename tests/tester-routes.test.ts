import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedCron } from "@/lib/cron-auth";

/**
 * Tester-added: exercises the real route handlers for /api/cron/* and /api/gmail/push (AC 3, 5, 6).
 * DATABASE_URL points at a closed local port, so any DB work would throw instead of returning a status.
 * No request here carries a well-formed JWT, so Google's JWKS is never fetched.
 */

const SECRET = "Abcdefghij0123456789";
const BASE_ENV = {
  DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
  APP_URL: "https://alex.example.com",
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "secret",
  ALEX_ALLOWED_EMAILS: "owner@example.com",
  ALEX_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  GOOGLE_OAUTH_TESTING_MODE: "true",
};
const MAIL_KEYS = ["GMAIL_PUBSUB_TOPIC", "PUBSUB_PUSH_AUDIENCE", "PUBSUB_PUSH_SERVICE_ACCOUNT", "CRON_SECRET"] as const;
let saved: Record<string, string | undefined>;

function setEnv(mail: Partial<Record<(typeof MAIL_KEYS)[number], string>>) {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  for (const k of MAIL_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(mail)) process.env[k] = v;
}

beforeEach(() => {
  saved = { ...process.env };
  vi.resetModules(); // env() and db() cache per module instance
  (globalThis as { alexDb?: unknown }).alexDb = undefined;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  (globalThis as { alexDb?: unknown }).alexDb = undefined;
});

async function cronGet(path: "gmail-sync" | "gmail-watch", authorization?: string) {
  const mod =
    path === "gmail-sync" ? await import("@/app/api/cron/gmail-sync/route") : await import("@/app/api/cron/gmail-watch/route");
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
  return mod.GET(new NextRequest(`https://alex.example.com/api/cron/${path}`, { headers }));
}

describe("cron routes (real handlers)", () => {
  for (const path of ["gmail-sync", "gmail-watch"] as const) {
    it(`${path}: 401 with no header, wrong secret, prefix/suffix matches or other schemes`, async () => {
      setEnv({ CRON_SECRET: SECRET });
      for (const h of [
        undefined,
        "",
        "Bearer",
        "Bearer ",
        `Bearer ${SECRET.slice(0, -1)}`,
        `Bearer ${SECRET}0`,
        // (`Bearer ${SECRET} ` is not listed: the Fetch Headers class trims outer whitespace per spec.)
        `Bearer  ${SECRET}`,
        `bearer ${SECRET}`,
        SECRET,
        `Basic ${SECRET}`,
        `Bearer ${SECRET.toLowerCase()}`,
      ]) {
        const res = await cronGet(path, h);
        expect(res.status, `header ${JSON.stringify(h)}`).toBe(401);
      }
    });

    it(`${path}: 401 when CRON_SECRET is unset, empty, whitespace, short or non-alphanumeric`, async () => {
      for (const secret of [undefined, "", "   ", "short1", "has spaces in it 1234", "has-dashes-0123456789"]) {
        setEnv(secret === undefined ? {} : { CRON_SECRET: secret });
        vi.resetModules();
        for (const h of [undefined, "Bearer ", "Bearer undefined", `Bearer ${secret ?? ""}`, `Bearer ${(secret ?? "").trim()}`]) {
          expect((await cronGet(path, h)).status).toBe(401);
        }
      }
    });

    it(`${path}: the correct secret gets past auth (positive control: the run then needs the DB)`, async () => {
      setEnv({ CRON_SECRET: SECRET });
      await expect(cronGet(path, `Bearer ${SECRET}`)).rejects.toThrow();
    });
  }

  it("isAuthorizedCron: a surrounding-whitespace secret in env fails closed after env trimming? (unit)", () => {
    // env() trims optional values; isAuthorizedCron itself rejects a secret with whitespace.
    expect(isAuthorizedCron(`Bearer ${SECRET} `, `${SECRET} `)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });
});

async function push(authorization: string | undefined, body: string) {
  const mod = await import("@/app/api/gmail/push/route");
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization !== undefined) headers.authorization = authorization;
  return mod.POST(new NextRequest("https://alex.example.com/api/gmail/push", { method: "POST", headers, body }));
}

const validBody = JSON.stringify({
  message: { data: Buffer.from(JSON.stringify({ emailAddress: "owner@example.com", historyId: "123" })).toString("base64url") },
  subscription: "projects/p/subscriptions/s",
});

describe("push route (real handler)", () => {
  it("503 when either auth env var is unset, before looking at the token", async () => {
    setEnv({ PUBSUB_PUSH_AUDIENCE: "https://alex.example.com/api/gmail/push" });
    expect((await push("Bearer a.b.c", validBody)).status).toBe(503);
    vi.resetModules();
    setEnv({ PUBSUB_PUSH_SERVICE_ACCOUNT: "push@p.iam.gserviceaccount.com" });
    expect((await push("Bearer a.b.c", validBody)).status).toBe(503);
    vi.resetModules();
    setEnv({ PUBSUB_PUSH_AUDIENCE: "  ", PUBSUB_PUSH_SERVICE_ACCOUNT: "" });
    expect((await push(undefined, validBody)).status).toBe(503);
  });

  it("401 for missing or malformed tokens, with no DB work", async () => {
    setEnv({ PUBSUB_PUSH_AUDIENCE: "https://alex.example.com/api/gmail/push", PUBSUB_PUSH_SERVICE_ACCOUNT: "push@p.iam.gserviceaccount.com" });
    for (const h of [undefined, "", "Bearer", "Bearer x", "Bearer a.b", "Basic a.b.c", "Bearer a.b.c d", "Bearer a+b.c.d", "bearer a.b.c"]) {
      const res = await push(h, validBody);
      expect(res.status, `header ${JSON.stringify(h)}`).toBe(401);
    }
  });
});
