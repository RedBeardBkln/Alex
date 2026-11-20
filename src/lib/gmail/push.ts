import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "@/db";
import { connectedAccounts } from "@/db/schema";
import type { PubSubAuthConfig, PubSubAuthResult } from "@/lib/pubsub-auth";
import { getSyncState, updateSyncState } from "./store";

/**
 * Gmail push notifications via Pub/Sub. A notification is only a trigger to fetch from Gmail:
 * its historyId is recorded for information and never becomes the sync cursor.
 */

const envelopeSchema = z.object({ message: z.object({ data: z.string().min(1) }) });
const notificationSchema = z.object({
  emailAddress: z.string().min(1).max(320),
  historyId: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]).transform(String),
});

export type GmailNotification = z.infer<typeof notificationSchema>;

/** Minimum gap between push-triggered syncs for one account. */
export const PUSH_DEBOUNCE_MS = 5_000;

/**
 * Parses a Pub/Sub push body (wrapped delivery) carrying Gmail's base64url JSON
 * `{emailAddress, historyId}`. Returns null if anything is malformed.
 */
export function parsePushBody(raw: string): GmailNotification | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return null;
  let inner: unknown;
  try {
    // Node's base64 decoder accepts both the standard and the URL-safe alphabet.
    inner = JSON.parse(Buffer.from(envelope.data.message.data, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const n = notificationSchema.safeParse(inner);
  return n.success ? n.data : null;
}

export type PushDeps = {
  db: Executor;
  verify: (authorization: string | null, config: PubSubAuthConfig) => Promise<PubSubAuthResult>;
  /** Runs the sync after the response is sent (next/server `after()` in the route). */
  schedule: (accountId: string) => void;
  now?: () => Date;
};

/**
 * Handles one push request and returns the HTTP status. 503 if push auth isn't configured, 401 if
 * the token fails verification (no DB or Gmail work), otherwise 204 so Pub/Sub doesn't redeliver.
 */
export async function handlePush(
  request: { authorization: string | null; body: string },
  config: { audience?: string; serviceAccount?: string },
  deps: PushDeps,
): Promise<number> {
  if (!config.audience || !config.serviceAccount) return 503;
  const auth = await deps.verify(request.authorization, { audience: config.audience, serviceAccount: config.serviceAccount });
  if (!auth.ok) return 401;

  const notification = parsePushBody(request.body);
  if (!notification) return 204;

  const accounts = await deps.db
    .select()
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.provider, "google"),
        eq(connectedAccounts.email, notification.emailAddress.trim().toLowerCase()),
        eq(connectedAccounts.status, "active"),
      ),
    );
  const now = deps.now ?? (() => new Date());
  for (const account of accounts) {
    const state = await getSyncState(deps.db, account.id);
    if (!state?.historyId) continue; // not set up yet: no Gmail calls
    // Debounce: if a sync was scheduled for this account within PUSH_DEBOUNCE_MS, just record the
    // notification. last_push_at only moves when a sync is scheduled, so a steady stream of
    // pushes can't postpone syncing indefinitely; anything a skipped push announced is picked
    // up by the next push-triggered sync or the 5-minute cron.
    const t = now();
    if (state.lastPushAt && t.getTime() - state.lastPushAt.getTime() < PUSH_DEBOUNCE_MS) {
      await updateSyncState(deps.db, account.id, { lastPushHistoryId: notification.historyId });
      continue;
    }
    await updateSyncState(deps.db, account.id, { lastPushAt: t, lastPushHistoryId: notification.historyId });
    deps.schedule(account.id);
  }
  return 204;
}
