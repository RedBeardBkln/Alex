import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { TEST_KEY } from "./setup-env";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { decrypt } from "@/lib/crypto";
import {
  deleteAccount,
  getAccessToken,
  getAccount,
  listAccounts,
  ReauthRequiredError,
  setLabel,
  upsertGoogleAccount,
} from "@/lib/accounts";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("accounts (Postgres)", () => {
  let client: ReturnType<typeof postgres>;
  let database: Database;
  let userId: string;

  beforeAll(async () => {
    client = postgres(url!, { max: 1, onnotice: () => {} });
    database = drizzle(client, { schema });
    await database.execute(sql`drop schema if exists public cascade; create schema public;`);
    await database.execute(sql`drop schema if exists drizzle cascade`);
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await database.delete(schema.users);
    const [u] = await database.insert(schema.users).values({ email: "owner@example.com" }).returning();
    userId = u!.id;
  });

  const identity = { sub: "1234", email: "work@example.com", name: "Work" };
  const tokens = (over: Partial<{ accessToken: string; refreshToken: string | null; expiresInMs: number }> = {}) => ({
    accessToken: over.accessToken ?? "access-1",
    refreshToken: over.refreshToken === undefined ? "refresh-1" : over.refreshToken,
    accessTokenExpiresAt: new Date(Date.now() + (over.expiresInMs ?? 3600_000)),
    scopes: ["openid"],
  });

  it("stores tokens encrypted and never exposes them in summaries", async () => {
    const summary = await upsertGoogleAccount(database, { userId, identity, tokens: tokens(), label: "business", key: TEST_KEY });
    expect(summary).not.toHaveProperty("accessTokenEnc");
    expect(summary).not.toHaveProperty("refreshTokenEnc");
    const row = await getAccount(database, userId, summary.id);
    expect(row!.refreshTokenEnc).not.toContain("refresh-1");
    expect(decrypt(row!.refreshTokenEnc!, TEST_KEY)).toBe("refresh-1");
    expect((await listAccounts(database, userId)).map((a) => a.email)).toEqual(["work@example.com"]);
  });

  it("reconnecting updates the same row and keeps the old refresh token if Google omits one", async () => {
    const first = await upsertGoogleAccount(database, { userId, identity, tokens: tokens(), label: "personal", key: TEST_KEY });
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, first.id));
    const second = await upsertGoogleAccount(database, {
      userId,
      identity,
      tokens: tokens({ accessToken: "access-2", refreshToken: null }),
      label: "business",
      key: TEST_KEY,
    });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("active");
    expect(second.label).toBe("business");
    const row = await getAccount(database, userId, first.id);
    expect(decrypt(row!.refreshTokenEnc!, TEST_KEY)).toBe("refresh-1");
    expect(decrypt(row!.accessTokenEnc!, TEST_KEY)).toBe("access-2");
  });

  it("supports several accounts and scopes every query to the owner", async () => {
    await upsertGoogleAccount(database, { userId, identity, tokens: tokens(), label: "business", key: TEST_KEY });
    const other = await upsertGoogleAccount(database, {
      userId,
      identity: { sub: "999", email: "me@example.com", name: null },
      tokens: tokens(),
      label: "personal",
      key: TEST_KEY,
    });
    expect(await listAccounts(database, userId)).toHaveLength(2);

    const [stranger] = await database.insert(schema.users).values({ email: "x@example.com" }).returning();
    expect(await getAccount(database, stranger!.id, other.id)).toBeNull();
    expect(await setLabel(database, stranger!.id, other.id, "business")).toBe(false);
    await deleteAccount(database, stranger!.id, other.id);
    expect(await getAccount(database, userId, other.id)).not.toBeNull();

    expect(await setLabel(database, userId, other.id, "business")).toBe(true);
    await deleteAccount(database, userId, other.id);
    expect(await getAccount(database, userId, other.id)).toBeNull();
  });

  it("returns a valid access token without refreshing", async () => {
    const s = await upsertGoogleAccount(database, { userId, identity, tokens: tokens(), label: "personal", key: TEST_KEY });
    const row = (await getAccount(database, userId, s.id))!;
    const token = await getAccessToken(database, row, TEST_KEY, async () => {
      throw new Error("should not refresh");
    });
    expect(token).toBe("access-1");
  });

  it("refreshes an expiring token and stores the new one", async () => {
    const s = await upsertGoogleAccount(database, { userId, identity, tokens: tokens({ expiresInMs: 10_000 }), label: "personal", key: TEST_KEY });
    const row = (await getAccount(database, userId, s.id))!;
    let seen = "";
    const token = await getAccessToken(database, row, TEST_KEY, async (rt) => {
      seen = rt;
      return { accessToken: "access-new", accessTokenExpiresAt: new Date(Date.now() + 3600_000) };
    });
    expect(seen).toBe("refresh-1");
    expect(token).toBe("access-new");
    const after = (await getAccount(database, userId, s.id))!;
    expect(decrypt(after.accessTokenEnc!, TEST_KEY)).toBe("access-new");
  });

  it("marks the account reauth_required when Google rejects the refresh token", async () => {
    const s = await upsertGoogleAccount(database, { userId, identity, tokens: tokens({ expiresInMs: 0 }), label: "personal", key: TEST_KEY });
    const row = (await getAccount(database, userId, s.id))!;
    const err = Object.assign(new Error("OAuth request error: invalid_grant"), { code: "invalid_grant" });
    await expect(getAccessToken(database, row, TEST_KEY, async () => Promise.reject(err))).rejects.toBeInstanceOf(ReauthRequiredError);
    const after = (await getAccount(database, userId, s.id))!;
    expect(after.status).toBe("reauth_required");
    expect(after.lastError).toMatch(/expired or revoked/);
  });

  it("passes through other refresh failures without flagging the account", async () => {
    const s = await upsertGoogleAccount(database, { userId, identity, tokens: tokens({ expiresInMs: 0 }), label: "personal", key: TEST_KEY });
    const row = (await getAccount(database, userId, s.id))!;
    await expect(getAccessToken(database, row, TEST_KEY, async () => Promise.reject(new Error("network down")))).rejects.toThrow("network down");
    expect((await getAccount(database, userId, s.id))!.status).toBe("active");
  });
});
