import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "@/db";
import { mailMessages } from "@/db/schema";
import { aiCaps, type Caps } from "@/lib/ai-ledger/config";
import { ambiguousFailureCost } from "@/lib/ai-ledger/pricing";
import { auditCapReachedOnce, emptyUsage, finishAiCall, finishDraftCall, SPEND_LIMIT_CODE, startDraftCall, type DraftClosing } from "@/lib/ai-ledger/ledger";
import { extractAddresses } from "@/lib/approvals/addresses";
import { proposeAiReply, replyContext } from "@/lib/approvals/service";
import { auditForAccount } from "@/lib/db-locks";
import { cleanDraftBody } from "./parse";
import { DRAFT_MODEL } from "./prompts";
import type { DraftOutcome, DraftProvider, ThreadTextMessage } from "./types";

/**
 * "Draft reply with AI" (Phase 2c, owner Q3/Q5): only when the owner clicks. The model sees this
 * thread only and returns body text; the reply is created by proposeAiReply as a pending
 * `source: ai` approval item, so recipients, account, subject and threading are decided in code,
 * and nothing is sent until the owner approves it through the unchanged 2b path.
 */

export const DRAFT_TIMEOUT_MS = 90_000;

export type DraftDeps = { db: Executor; provider: DraftProvider | null; now?: () => Date; caps?: Caps; timeoutMs?: number };

export type DraftResult =
  | { ok: true; itemId: string }
  | { ok: false; code: "not_configured" | "not_found" | "capped" | "in_flight" | "refused" | "invalid" | "error" | "proposal" | "account_disconnected" };

/** O2 (phase-2-followups-2): the result, audit and (for a finished or skipped call) ai_calls code when the account was disconnected. */
const DISCONNECTED = "account_disconnected";

/** The thread as the model sees it, oldest first: plain stored text, the owner's sent replies included. */
export async function threadForDraft(ex: Executor, userId: string, threadId: string): Promise<ThreadTextMessage[]> {
  const rows = await ex
    .select({
      isSent: mailMessages.isSent,
      fromHeader: mailMessages.fromHeader,
      dateHeader: mailMessages.dateHeader,
      subject: mailMessages.subject,
      bodyText: mailMessages.bodyText,
      renderedText: mailMessages.renderedText,
      labelIds: mailMessages.labelIds,
    })
    .from(mailMessages)
    .where(and(eq(mailMessages.threadId, threadId), eq(mailMessages.userId, userId)))
    .orderBy(asc(mailMessages.internalDate), asc(mailMessages.id));
  return rows
    .filter((r) => !r.labelIds.includes("TRASH") && !r.labelIds.includes("SPAM"))
    .map((r) => ({
      source: r.isSent ? ("owner_sent" as const) : ("inbound_email" as const),
      from_address: extractAddresses(r.fromHeader).addresses[0] ?? null,
      date: r.dateHeader,
      subject: r.subject,
      text: r.bodyText ?? r.renderedText ?? "",
    }));
}

export async function draftReply(
  deps: DraftDeps,
  input: { userId: string; threadId: string; mode: "reply" | "all"; instruction: string | null },
): Promise<DraftResult> {
  const now = (deps.now ?? (() => new Date()))();
  if (!deps.provider) return { ok: false, code: "not_configured" };
  const ctx = await replyContext(deps.db, input.userId, input.threadId);
  if (!ctx) return { ok: false, code: "not_found" };
  const accountId = ctx.account.id;

  // Single-flight and caps in one locked transaction (review round 1, D4): a second request for this
  // thread while one is in flight makes no model call, and in-flight calls count toward the caps.
  const start = await startDraftCall(deps.db, {
    userId: input.userId,
    accountId,
    threadId: input.threadId,
    provider: deps.provider.id,
    model: DRAFT_MODEL,
    now,
    caps: deps.caps ?? aiCaps(),
  });
  // Round 2, O1: the account was disconnected meanwhile; no provider call and no row. Since O1 this
  // is the only cause, so the owner is told so (phase-2-followups-2, O2/Q7).
  if (start.kind === "not_found") return { ok: false, code: "account_disconnected" };
  if (start.kind === "in_flight") return { ok: false, code: "in_flight" };
  if (start.kind === "capped") {
    await auditCapReachedOnce(deps.db, input.userId, "draft", start.cap, now);
    return { ok: false, code: "capped" };
  }
  const base = { callId: start.callId, userId: input.userId, accountId };
  const failed = (code: string): DraftClosing => ({ action: "ai.draft_failed", detail: { code } });

  // O2 (phase-2-followups-2): every write below that carries the account id locks the account first
  // (auditForAccount, finishDraftCall), so a Disconnect during the call can't make it fail its FK.
  if (!(await auditForAccount(deps.db, { userId: input.userId, accountId, action: "ai.draft_requested", detail: { threadId: input.threadId } }))) {
    // Gone before the model call: none is made, so the row is finished at $0.
    await finishDraftCall(deps.db, {
      ...base,
      status: "error",
      errorCode: DISCONNECTED,
      usage: emptyUsage(deps.provider.id, DRAFT_MODEL),
      closing: () => failed(DISCONNECTED),
    });
    return { ok: false, code: "account_disconnected" };
  }

  let out: DraftOutcome;
  try {
    const messages = await threadForDraft(deps.db, input.userId, input.threadId);
    out = await deps.provider.draft({ messages, ownerInstruction: input.instruction }, AbortSignal.timeout(deps.timeoutMs ?? DRAFT_TIMEOUT_MS));
  } catch {
    out = { status: "error", body: null, notes: null, errorCode: "unexpected", usage: emptyUsage(deps.provider.id, DRAFT_MODEL) };
  }
  // The gate validates the body itself, whatever the provider did (review round 1, D3).
  const body = out.status === "ok" && out.body !== null ? cleanDraftBody(out.body) : "";
  if (out.status === "ok" && body === "") out = { ...out, status: "invalid", body: null, errorCode: "empty_body" };

  if (out.status !== "ok") {
    // Round 4, B1: a timeout, abort, network or 5xx error may still have been billed, but no usage came
    // back. Record the reserved worst case so the dollar caps count it. The provider's own code is kept
    // on the row even when the account is gone (owner Q6): the reserve and the report depend on it.
    const reserved = ambiguousFailureCost("draft", out.status, out.errorCode);
    const usage = reserved !== null ? { ...out.usage, costUsdMicros: reserved } : out.usage;
    const providerCode = out.errorCode ?? out.status;
    const closed = await finishDraftCall(deps.db, {
      ...base,
      status: out.status,
      errorCode: out.errorCode,
      usage,
      providerError: out.status === "error" ? (out.errorCode ?? "error") : null,
      closing: ({ accountLive }) => failed(accountLive ? providerCode : DISCONNECTED),
    });
    if (out.errorCode === SPEND_LIMIT_CODE) await auditCapReachedOnce(deps.db, input.userId, "draft", "spend_limit", now);
    return { ok: false, code: closed.accountLive ? out.status : "account_disconnected" };
  }

  let proposed: Awaited<ReturnType<typeof proposeAiReply>>;
  try {
    proposed = await proposeAiReply(deps.db, { userId: input.userId, threadId: input.threadId, parentMessageId: ctx.parent.id, mode: input.mode, body });
  } catch (err) {
    await finishAiCall(deps.db, start.callId, { status: "ok", errorCode: "proposal_error", usage: out.usage });
    throw err;
  }
  const model = out.usage.model || DRAFT_MODEL;
  const saved = proposed;
  // Account gone (the proposal found no account, or the item cascaded with it after it was saved):
  // the row keeps status ok and the real usage, with code account_disconnected and no item (Q6).
  const closed = await finishDraftCall(deps.db, {
    ...base,
    status: "ok",
    errorCode: saved.ok ? null : `proposal_${saved.error}`,
    errorCodeIfGone: DISCONNECTED,
    usage: out.usage,
    approvalItemId: saved.ok ? saved.itemId : null,
    closing: ({ accountLive, costUsdMicros }) =>
      !accountLive
        ? failed(DISCONNECTED)
        : saved.ok
          ? { action: "ai.draft_proposed", detail: { itemId: saved.itemId, model, costUsdMicros } }
          : failed(`proposal_${saved.error}`),
  });
  if (!closed.accountLive) return { ok: false, code: "account_disconnected" };
  if (!saved.ok) return { ok: false, code: "proposal" };
  return { ok: true, itemId: saved.itemId };
}
