import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const accountLabel = pgEnum("account_label", ["personal", "business"]);
export const accountProvider = pgEnum("account_provider", ["google", "slack", "remarkable"]);
export const accountStatus = pgEnum("account_status", ["active", "reauth_required", "revoked"]);

/** The person who owns this Alex instance. Single-user today; kept as a table so data is scoped from day one. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Browser sessions. Only a SHA-256 hash of the cookie value is stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256(cookie token), hex
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * An external account Alex acts on: each Google account (personal or business), and later Slack and reMarkable.
 * Tokens are AES-256-GCM encrypted (see src/lib/crypto.ts).
 */
export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: accountProvider("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(), // Google "sub"
    email: text("email").notNull(),
    displayName: text("display_name"),
    label: accountLabel("label").notNull().default("personal"),
    status: accountStatus("status").notNull().default("active"),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    accessTokenEnc: text("access_token_enc"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenEnc: text("refresh_token_enc"),
    /** When the user last granted consent; drives the 7-day reconnect warning in Google "Testing" mode. */
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("connected_accounts_provider_uidx").on(t.userId, t.provider, t.providerAccountId),
  ],
);

/** Append-only record of everything Alex does or is asked to do. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_user_created_idx").on(t.userId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type ConnectedAccount = typeof connectedAccounts.$inferSelect;
