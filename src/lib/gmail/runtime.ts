import { db } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { env } from "@/lib/env";
import { googleTokenProvider } from "@/lib/google-api";
import { createGmailClient, type GmailClient } from "./client";
import type { SyncDeps } from "./sync";

/** Gmail client for a connected account, using its stored (encrypted) tokens. */
export function gmailClientFor(account: ConnectedAccount): GmailClient {
  return createGmailClient(googleTokenProvider(account));
}

/** Production wiring for the sync engine: shared database, real Gmail, topic from the environment. */
export function defaultSyncDeps(): SyncDeps {
  return { db: db(), gmailFor: gmailClientFor, topic: env().GMAIL_PUBSUB_TOPIC };
}
