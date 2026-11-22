import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@/db";
import { connectedAccounts, type ConnectedAccount } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { sqlState } from "@/lib/pg-errors";
import type { GoogleIdentity } from "@/lib/google";

export type TokenSet = {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string | null;
  scopes: string[];
};

export type Label = "personal" | "business";

/** Safe-to-render view of an account: never includes tokens. */
export type AccountSummary = Omit<ConnectedAccount, "accessTokenEnc" | "refreshTokenEnc">;

function summarize(a: ConnectedAccount): AccountSummary {
  const { accessTokenEnc: _a, refreshTokenEnc: _r, ...rest } = a;
  return rest;
}

/**
 * Inserts or refreshes a connected Google account. If Google did not return a refresh token
 * (it only does on consent), the stored one is kept.
 */
export async function upsertGoogleAccount(
  database: Database,
  input: { userId: string; identity: GoogleIdentity; tokens: TokenSet; label: Label; key: string },
): Promise<AccountSummary> {
  const { userId, identity, tokens, label, key } = input;
  const now = new Date();
  const values = {
    userId,
    provider: "google" as const,
    providerAccountId: identity.sub,
    email: identity.email,
    displayName: identity.name,
    label,
    status: "active" as const,
    scopes: tokens.scopes,
    accessTokenEnc: encrypt(tokens.accessToken, key),
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    consentedAt: now,
    lastError: null,
    updatedAt: now,
  };
  const refresh = tokens.refreshToken ? { refreshTokenEnc: encrypt(tokens.refreshToken, key) } : {};

  const [row] = await database
    .insert(connectedAccounts)
    .values({ ...values, ...refresh })
    .onConflictDoUpdate({
      target: [connectedAccounts.userId, connectedAccounts.provider, connectedAccounts.providerAccountId],
      set: { ...values, ...refresh },
    })
    .returning();
  if (!row) throw new Error("Failed to save connected account");
  return summarize(row);
}

export async function listAccounts(database: Database, userId: string): Promise<AccountSummary[]> {
  const rows = await database
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.userId, userId))
    .orderBy(asc(connectedAccounts.label), asc(connectedAccounts.email));
  return rows.map(summarize);
}

export async function getAccount(
  database: Database,
  userId: string,
  accountId: string,
): Promise<ConnectedAccount | null> {
  const rows = await database
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.id, accountId), eq(connectedAccounts.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function setLabel(database: Database, userId: string, accountId: string, label: Label): Promise<boolean> {
  const rows = await database
    .update(connectedAccounts)
    .set({ label, updatedAt: new Date() })
    .where(and(eq(connectedAccounts.id, accountId), eq(connectedAccounts.userId, userId)))
    .returning({ id: connectedAccounts.id });
  return rows.length > 0;
}

/** Postgres "deadlock detected". */
const DEADLOCK_DETECTED = "40P01";
/** Disconnect tries the DELETE at most this many times when it loses a deadlock (owner Q6). */
export const DELETE_ACCOUNT_ATTEMPTS = 3;

/**
 * Deletes the user's account; its mail, items and sync rows cascade. The single DELETE statement is
 * rolled back whole when Postgres picks it as a deadlock victim (40P01), so it is retried, up to
 * `attempts` times in all with a 50–250 ms jittered pause, then the error is rethrown. Other errors
 * aren't retried. The audited transitions lock the account row first (src/lib/db-locks.ts), so a
 * deadlock is a backstop case here, mainly a running sync. `attempts: 1` turns the retry off (tests).
 */
export async function deleteAccount(
  database: Database,
  userId: string,
  accountId: string,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<void> {
  const attempts = Math.max(1, opts.attempts ?? DELETE_ACCOUNT_ATTEMPTS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      await database
        .delete(connectedAccounts)
        .where(and(eq(connectedAccounts.id, accountId), eq(connectedAccounts.userId, userId)));
      return;
    } catch (err) {
      if (attempt >= attempts || sqlState(err) !== DEADLOCK_DETECTED) throw err;
      console.error("disconnect deadlocked, retrying", { accountId, attempt });
      await sleep(50 + Math.floor(random() * 200));
    }
  }
}

export type Refresher = (refreshToken: string) => Promise<{ accessToken: string; accessTokenExpiresAt: Date }>;

export class ReauthRequiredError extends Error {
  constructor(public readonly accountId: string, reason: string) {
    super(`Account needs to be reconnected: ${reason}`);
  }
}

const EXPIRY_SKEW_MS = 60_000;

/**
 * Returns a usable access token, refreshing it when it expires within a minute.
 * If the refresh token is missing or rejected, the account is marked `reauth_required`.
 */
export async function getAccessToken(
  database: Database,
  account: ConnectedAccount,
  key: string,
  refresher: Refresher,
): Promise<string> {
  if (
    account.accessTokenEnc &&
    account.accessTokenExpiresAt &&
    account.accessTokenExpiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS
  ) {
    return decrypt(account.accessTokenEnc, key);
  }

  const markReauth = async (reason: string) => {
    await database
      .update(connectedAccounts)
      .set({ status: "reauth_required", lastError: reason, updatedAt: new Date() })
      .where(eq(connectedAccounts.id, account.id));
    return new ReauthRequiredError(account.id, reason);
  };

  if (!account.refreshTokenEnc) throw await markReauth("No refresh token stored");

  let refreshed: { accessToken: string; accessTokenExpiresAt: Date };
  try {
    refreshed = await refresher(decrypt(account.refreshTokenEnc, key));
  } catch (err) {
    // Google answers an expired or revoked refresh token with invalid_grant.
    const message = err instanceof Error ? err.message : String(err);
    if (/invalid_grant/i.test(message) || (err as { code?: string })?.code === "invalid_grant") {
      throw await markReauth("Google rejected the refresh token (expired or revoked)");
    }
    throw err;
  }

  await database
    .update(connectedAccounts)
    .set({
      accessTokenEnc: encrypt(refreshed.accessToken, key),
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      status: "active",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(connectedAccounts.id, account.id));
  return refreshed.accessToken;
}
