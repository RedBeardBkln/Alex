import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Executor } from "@/db";
import { approvalItems, connectedAccounts, mailThreads, type ApprovalItem, type ConnectedAccount } from "@/db/schema";
import { buildMessage, ComposeError, toRaw } from "@/lib/gmail/compose";
import type { SendOutcome } from "@/lib/gmail/send";
import { contentHash, emailSendPayload, outgoingBody } from "./payload";
import { approveItem, claimItem, EMAIL_SEND, recordOutcome, type ApproveResult, type ExecutionOutcome } from "./service";

/**
 * The executor (plan §5.2–5.3): the only path from an approval to a Gmail send.
 *
 * `executeClaimed` acts only on a row that is `executing` with the caller's execution_id, which
 * only `claimItem` (approved -> executing, one winner) hands out. It re-checks the approved hash,
 * then builds the RFC 2822 bytes only from approved_payload, the account and message_id_header,
 * and calls the kind's sender once. An ambiguous outcome is recorded as `unknown` and never retried.
 */

export type Sender = (account: ConnectedAccount, req: { raw: string; threadId: string | null }) => Promise<SendOutcome>;

export type ExecutorDeps = {
  db: Executor;
  /** Sends through Gmail messages.send (src/lib/gmail/send.ts); tests pass a fake. */
  send: Sender;
  now?: () => Date;
};

type KindExecutor = (deps: ExecutorDeps, item: ApprovalItem) => Promise<ExecutionOutcome>;

/** A kind's registry entry: the schema its payload must match, and its executor. */
export type KindDefinition = { schema: z.ZodType; execute: KindExecutor };

/** The kind registry (plan §4): one entry per approval_kind value; a new kind is a new entry. */
export const KINDS: Record<ApprovalItem["kind"], KindDefinition> = {
  [EMAIL_SEND]: { schema: emailSendPayload, execute: executeEmailSend },
};

async function executeEmailSend(deps: ExecutorDeps, item: ApprovalItem): Promise<ExecutionOutcome> {
  const parsed = emailSendPayload.safeParse(item.approvedPayload);
  if (!parsed.success || !item.approvedHash || contentHash(item.kind, item.accountId, item.approvedPayload) !== item.approvedHash) {
    return { kind: "failed", code: "hash_mismatch", status: null };
  }
  if (!item.accountId || !item.messageIdHeader) return { kind: "failed", code: "stale_account", status: null };
  const [account] = await deps.db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.id, item.accountId), eq(connectedAccounts.userId, item.userId)))
    .limit(1);
  if (!account || account.provider !== "google") return { kind: "failed", code: "stale_account", status: null };
  if (account.status !== "active") return { kind: "failed", code: "reauth_required", status: null };
  // The sending account is always the thread's account.
  if (item.threadId) {
    const [thread] = await deps.db.select({ accountId: mailThreads.accountId }).from(mailThreads).where(eq(mailThreads.id, item.threadId)).limit(1);
    if (!thread || thread.accountId !== account.id) return { kind: "failed", code: "stale_account", status: null };
  } else if (parsed.data.threading) {
    return { kind: "failed", code: "stale_account", status: null };
  }

  const p = parsed.data;
  let raw: string;
  try {
    raw = toRaw(
      buildMessage({
        from: account.email,
        to: p.to,
        cc: p.cc,
        subject: p.subject,
        bodyText: outgoingBody(p),
        messageId: item.messageIdHeader,
        inReplyTo: p.threading?.inReplyTo ?? null,
        references: p.threading?.references ?? [],
        date: (deps.now ?? (() => new Date()))(),
      }),
    );
  } catch (err) {
    return { kind: "failed", code: err instanceof ComposeError ? `compose_${err.code}` : "compose", status: null };
  }
  return deps.send(account, { raw, threadId: p.threading?.gmailThreadId ?? null });
}

/**
 * Runs the claimed execution. Returns null, and sends nothing, unless the row is `executing` with
 * this execution_id.
 */
export async function executeClaimed(deps: ExecutorDeps, itemId: string, executionId: string): Promise<ExecutionOutcome | null> {
  const [item] = await deps.db
    .select()
    .from(approvalItems)
    .where(and(eq(approvalItems.id, itemId), eq(approvalItems.executionId, executionId), eq(approvalItems.status, "executing")))
    .limit(1);
  if (!item) return null;
  let outcome: ExecutionOutcome;
  try {
    outcome = await KINDS[item.kind].execute(deps, item);
  } catch {
    // Something failed around the send itself: it may have happened.
    outcome = { kind: "unknown", code: "executor_error", status: null };
  }
  await recordOutcome(deps.db, item, executionId, outcome);
  return outcome;
}

export type ApproveAndSendResult =
  | { kind: "approval"; result: Exclude<ApproveResult, { kind: "approved" } | { kind: "already_approved" }> }
  /** Approved, but another caller holds (or held) the execution. */
  | { kind: "not_claimed" }
  | { kind: "executed"; outcome: ExecutionOutcome };

/**
 * The approve button: approve exactly the displayed revision and hash, claim, execute. A replay,
 * double click or parallel tab either finds the item changed (stale) or loses the claim, so the
 * message is sent at most once.
 */
export async function approveAndSend(
  deps: ExecutorDeps,
  input: Parameters<typeof approveItem>[1],
): Promise<ApproveAndSendResult> {
  const approval = await approveItem(deps.db, input);
  if (approval.kind !== "approved" && approval.kind !== "already_approved") return { kind: "approval", result: approval };
  const claim = await claimItem(deps.db, input.userId, input.itemId);
  if (!claim) return { kind: "not_claimed" };
  const outcome = await executeClaimed(deps, input.itemId, claim.executionId);
  return outcome ? { kind: "executed", outcome } : { kind: "not_claimed" };
}
