import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./setup-env";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { audit } from "@/lib/audit";
import { accountConnectedDetail, accountDisconnectedDetail, loginDeniedDetail, loginDetail } from "@/lib/audit-details";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// phase-2a-followups AC9 (owner Q3): account and login audit entries hold no email address.

describe("audit detail shapes", () => {
  const account = { id: "4b1d6d7e-0f9e-4d5c-9a51-0d2b7f9b7c11", provider: "google", label: "business", email: "someone@example.com" };

  it("account.connected: { label }", () => {
    expect(accountConnectedDetail(account)).toEqual({ label: "business" });
  });

  it("account.disconnected: { accountId, provider, label }", () => {
    expect(accountDisconnectedDetail(account)).toEqual({ accountId: account.id, provider: "google", label: "business" });
  });

  it("login: no detail", () => {
    expect(loginDetail()).toBeUndefined();
  });

  it("login.denied: the domain only, lowercased; null without one", () => {
    expect(loginDeniedDetail("Someone@Example.COM")).toEqual({ domain: "example.com" });
    expect(loginDeniedDetail("a@b@example.org")).toEqual({ domain: "example.org" });
    expect(loginDeniedDetail("no-at-sign")).toEqual({ domain: null });
    expect(loginDeniedDetail("trailing@")).toEqual({ domain: null });
  });

  it("no detail contains an @", () => {
    for (const d of [accountConnectedDetail(account), accountDisconnectedDetail(account), loginDetail() ?? {}, loginDeniedDetail("x.y@example.net")]) {
      expect(JSON.stringify(d)).not.toContain("@");
    }
  });
});

describe("source: no audit( call passes an email field", () => {
  const root = path.resolve(import.meta.dirname, "../src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e)) files.push(p);
    }
  };
  walk(root);

  it("every audit({...}) call's object has no email key", () => {
    let calls = 0;
    for (const file of files) {
      const code = readFileSync(file, "utf8");
      for (const m of code.matchAll(/\baudit\(\s*\{[\s\S]*?\}\s*(?:,[^)]*)?\)/g)) {
        calls += 1;
        expect(m[0], `${path.relative(root, file)}: ${m[0]}`).not.toMatch(/\bemail\s*:|[{,]\s*email\s*[,}]/);
      }
    }
    expect(calls).toBeGreaterThan(10);
  });

  it("the four entries use the audit-details helpers", () => {
    const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
    expect(read("app/api/auth/google/callback/route.ts")).toMatch(/action: "login\.denied", detail: loginDeniedDetail\(/);
    expect(read("app/api/auth/google/callback/route.ts")).toMatch(/action: "login", detail: loginDetail\(\)/);
    expect(read("app/api/accounts/google/callback/route.ts")).toMatch(/action: "account\.connected", detail: accountConnectedDetail\(account\)/);
    expect(read("app/(app)/actions.ts")).toMatch(/action: "account\.disconnected", detail: accountDisconnectedDetail\(account\)/);
  });
});

describe.skipIf(!testDbUrl)("audit inserts (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });

  it("the stored account and login entries never contain an email address", async () => {
    const user = await makeUser(database, "owner@example.com");
    const account = await makeGoogleAccount(database, user.id, { email: "work@example.com", label: "business" });
    await audit({ userId: null, action: "login.denied", detail: loginDeniedDetail("stranger@example.org") }, database);
    await audit({ userId: user.id, action: "login", detail: loginDetail() }, database);
    await audit({ userId: user.id, accountId: account.id, action: "account.connected", detail: accountConnectedDetail(account) }, database);
    await audit({ userId: user.id, action: "account.disconnected", detail: accountDisconnectedDetail(account) }, database);
    const rows = await database.select().from(schema.auditLog);
    expect(rows.map((r) => r.action).sort()).toEqual(["account.connected", "account.disconnected", "login", "login.denied"]);
    for (const r of rows) expect(JSON.stringify(r.detail ?? null), r.action).not.toContain("@");
    expect(rows.find((r) => r.action === "login.denied")!.detail).toEqual({ domain: "example.org" });
    expect(rows.find((r) => r.action === "login")!.detail).toBeNull();
    expect(rows.find((r) => r.action === "account.disconnected")!.detail).toEqual({ accountId: account.id, provider: "google", label: "business" });
  });
});
