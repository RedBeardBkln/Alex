import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { alexDb?: Database };

/** Shared Drizzle client. `prepare: false` keeps it compatible with pooled (PgBouncer) connection strings such as Neon's. */
export function db(): Database {
  if (!globalForDb.alexDb) {
    const client = postgres(env().DATABASE_URL, { prepare: false, max: 5 });
    globalForDb.alexDb = drizzle(client, { schema });
  }
  return globalForDb.alexDb;
}

export { schema };
