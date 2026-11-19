import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { upsertGoogleAccount } from "@/lib/accounts";
import { TEST_KEY } from "./setup-env";

/**
 * TEST_DATABASE_URL only. The schema is dropped and recreated: never point it at production.
 * Test files run one at a time (vitest.config.ts), so files can't wipe each other's data.
 */
export const testDbUrl = process.env.TEST_DATABASE_URL;

export async function openTestDb(): Promise<{ client: ReturnType<typeof postgres>; database: Database }> {
  const client = postgres(testDbUrl!, { max: 1, onnotice: () => {} });
  const database = drizzle(client, { schema });
  await database.execute(sql`drop schema if exists public cascade; create schema public;`);
  await database.execute(sql`drop schema if exists drizzle cascade`);
  await migrate(database, { migrationsFolder: "drizzle" });
  return { client, database };
}

export async function makeUser(database: Database, email = "owner@example.com") {
  const [u] = await database.insert(schema.users).values({ email }).returning();
  return u!;
}

let sub = 1000;

export async function makeGoogleAccount(
  database: Database,
  userId: string,
  opts: { email?: string; label?: "personal" | "business" } = {},
) {
  sub += 1;
  const summary = await upsertGoogleAccount(database, {
    userId,
    identity: { sub: String(sub), email: opts.email ?? `acct${sub}@example.com`, name: null },
    tokens: { accessToken: "access", accessTokenExpiresAt: new Date(Date.now() + 3600_000), refreshToken: "refresh", scopes: [] },
    label: opts.label ?? "personal",
    key: TEST_KEY,
  });
  const [row] = await database.select().from(schema.connectedAccounts).where(sql`${schema.connectedAccounts.id} = ${summary.id}`);
  return row!;
}
