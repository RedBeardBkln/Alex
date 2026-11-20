import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "@/db";
import { mailMessages } from "@/db/schema";
import { aiCaps, type Caps } from "@/lib/ai-ledger/config";
import { ambiguousFailureCost } from "@/lib/ai-ledger/pricing";
import { auditCapReachedOnce, auditProviderErrorDeduped, emptyUsage, finishAiCall, SPEND_LIMIT_CODE, startDraftCall } from "@/lib/ai-ledger/ledger";
import { extractAddresses } from "@/lib/approvals/addresses";
import { proposeAiReply, replyContext } from "@/lib/approvals/service";
import { audit } from "@/lib/audit";
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
  | { ok: false; code: "not_configured" | "not_found" | "capped" | "in_flight" | "refused" | "invalid" | "error" | "proposal" };

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
  // Round 2, O1: the account was disconnected meanwhile; no provider call, same answer as a missing thread.
  if (start.kind === "not_found") return { ok: false, code: "not_found" };
  if (start.kind === "in_flight") return { ok: false, code: "in_flight" };
  if (start.kind === "capped") {
    await auditCapReachedOnce(deps.db, input.userId, "draft", start.cap, now);
    return { ok: false, code: "capped" };
  }
  await audit({ userId: input.userId, accountId, action: "ai.draft_requested", detail: { threadId: input.threadId } }, deps.db);

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
  if (out.status === "error") await auditProviderErrorDeduped(deps.db, input.userId, accountId, "draft", out.errorCode ?? "error");

  if (out.status !== "ok") {
    // Round 4, B1: a timeout, abort, network or 5xx error may still have been billed, but no usage came
    // back. Record the reserved worst case so the dollar caps count it.
    const reserved = ambiguousFailureCost("draft", out.status, out.errorCode);
    const usage = reserved !== null ? { ...out.usage, costUsdMicros: reserved } : out.usage;
    await finishAiCall(deps.db, start.callId, { status: out.status, errorCode: out.errorCode, usage });
    if (out.errorCode === SPEND_LIMIT_CODE) await auditCapReachedOnce(deps.db, input.userId, "draft", "spend_limit", now);
    await audit({ userId: input.userId, accountId, action: "ai.draft_failed", detail: { code: out.errorCode ?? out.status } }, deps.db);
    return { ok: false, code: out.status };
  }

  let proposed: Awaited<ReturnType<typeof proposeAiReply>>;
  try {
    proposed = await proposeAiReply(deps.db, { userId: input.userId, threadId: input.threadId, parentMessageId: ctx.parent.id, mode: input.mode, body });
  } catch (err) {
    await finishAiCall(deps.db, start.callId, { status: "ok", errorCode: "proposal_error", usage: out.usage });
    throw err;
  }
  const call = await finishAiCall(deps.db, start.callId, {
    status: "ok",
    errorCode: proposed.ok ? null : `proposal_${proposed.error}`,
    usage: out.usage,
    approvalItemId: proposed.ok ? proposed.itemId : null,
  });
  if (!proposed.ok) {
    await audit({ userId: input.userId, accountId, action: "ai.draft_failed", detail: { code: `proposal_${proposed.error}` } }, deps.db);
    return { ok: false, code: "proposal" };
  }
  await audit(
    { userId: input.userId, accountId, action: "ai.draft_proposed", detail: { itemId: proposed.itemId, model: out.usage.model || DRAFT_MODEL, costUsdMicros: call.costUsdMicros } },
    deps.db,
  );
  return { ok: true, itemId: proposed.itemId };
}
