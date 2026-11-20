import { db } from "@/db";
import { env } from "@/lib/env";
import { gmailClientFor } from "@/lib/gmail/runtime";
import { sendRawMessage } from "@/lib/gmail/send";
import { googleTokenProvider } from "@/lib/google-api";
import type { ExecutorDeps } from "./execute";
import type { ReconcileDeps } from "./reconcile";

/** Production wiring for the approval executor: the shared database and real Gmail messages.send. */
export function approvalExecutorDeps(): ExecutorDeps {
  return { db: db(), send: (account, req) => sendRawMessage(googleTokenProvider(account), req) };
}

/** Production wiring for the reconciler (read-only Gmail lookups). */
export function approvalReconcileDeps(): ReconcileDeps {
  return { db: db(), gmailFor: gmailClientFor };
}

/** The right-hand side of Alex's Message-IDs: APP_URL's hostname (alex.ericandeva.com in production). */
export function messageIdHost(): string {
  return new URL(env().APP_URL).hostname;
}
