import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { aiCalls, auditLog, type AiCall } from "@/db/schema";
import { audit } from "@/lib/audit";
import { lockAccountForWrite } from "@/lib/db-locks";
import { aiCaps, utcDayStart, type Caps } from "./config";
import { costUsdMicros, DRAFT_RESERVED_COST_MICROS, ESTIMATED_COST_CODES, PRICING_VERSION } from "./pricing";

/**
 * The `ai_calls` log, the daily caps and the cost report (Phase 2c). Page-safe: no SDK, no prompt
 * or model output. Every model call writes exactly one row, whatever its outcome.
 */

export type AiPurpose = AiCall["purpose"];

/** Provider-neutral usage of one call (plain data, no SDK types). */
export type AiUsage = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number | null;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Set by local providers that price themselves; null means "use the pricing table". */
  costUsdMicros?: number | null;
  latencyMs: number;
  requestId: string | null;
};

export function emptyUsage(provider: string, model: string, latencyMs = 0): AiUsage {
  return { provider, model, inputTokens: 0, outputTokens: 0, thinkingTokens: null, cacheWriteTokens: 0, cacheReadTokens: 0, latencyMs, requestId: null };
}

/** Writes the call's row and returns its id and estimated cost. */
export async function logAiCall(
  ex: Executor,
  row: {
    userId: string;
    accountId: string | null;
    purpose: AiPurpose;
    status: AiCall["status"];
    errorCode: string | null;
    messageId?: string | null;
    approvalItemId?: string | null;
    usage: AiUsage;
  },
): Promise<{ id: string; costUsdMicros: number | null }> {
  const u = row.usage;
  const cost = u.costUsdMicros !== undefined && u.costUsdMicros !== null ? u.costUsdMicros : costUsdMicros(u.model, u);
  const [inserted] = await ex
    .insert(aiCalls)
    .values({
      userId: row.userId,
      accountId: row.accountId,
      purpose: row.purpose,
      provider: u.provider,
      model: u.model,
      messageId: row.messageId ?? null,
      approvalItemId: row.approvalItemId ?? null,
      status: row.status,
      errorCode: row.errorCode,
      requestId: u.requestId,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      thinkingTokens: u.thinkingTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      cacheReadTokens: u.cacheReadTokens,
      costUsdMicros: cost,
      pricingVersion: cost === null ? null : PRICING_VERSION,
      latencyMs: Math.max(0, Math.round(u.latencyMs)),
    })
    .returning({ id: aiCalls.id });
  return { id: inserted!.id, costUsdMicros: cost };
}

/** Error code that means "the Anthropic account's own spend limit was reached": pause for the day. */
export const SPEND_LIMIT_CODE = "spend_limit";

export type CapState = { capped: false } | { capped: true; cap: "calls" | "usd" | "total_usd" | "spend_limit" };

/** Today's (UTC) usage for the user: calls and cost per purpose, overall cost, and whether a spend limit was hit. */
export async function todaysUsage(ex: Executor, userId: string, now: Date) {
  const rows = await ex
    .select({
      purpose: aiCalls.purpose,
      calls: sql<number>`count(*)::int`,
      // An in-flight draft counts at its reserved worst case until it finishes (round 3, E3).
      micros: sql<number>`coalesce(sum(case when ${aiCalls.status} = 'pending' then ${DRAFT_RESERVED_COST_MICROS} else ${aiCalls.costUsdMicros} end), 0)::bigint`,
      spendLimit: sql<number>`count(*) filter (where ${aiCalls.errorCode} = ${SPEND_LIMIT_CODE})::int`,
    })
    .from(aiCalls)
    .where(and(eq(aiCalls.userId, userId), gte(aiCalls.createdAt, utcDayStart(now))))
    .groupBy(aiCalls.purpose);
  const by = (p: AiPurpose) => rows.find((r) => r.purpose === p);
  const n = (v: unknown) => Number(v ?? 0);
  return {
    triage: { calls: n(by("triage")?.calls), micros: n(by("triage")?.micros) },
    draft: { calls: n(by("draft")?.calls), micros: n(by("draft")?.micros) },
    totalMicros: rows.reduce((s, r) => s + n(r.micros), 0),
    spendLimitHit: rows.some((r) => n(r.spendLimit) > 0),
  };
}

/**
 * Whether one more call for `purpose` is allowed today. Calls: the cap is the number allowed (at
 * the cap, the next call is refused). Dollars: no new call once today's estimate has reached the
 * cap; an in-flight draft counts at its reserved worst case (round 3, E3), so parallel drafts can't
 * together overshoot by more than one call, as sequential calls can. A spend-limit answer from Anthropic pauses both purposes for the rest of the UTC day.
 */
export async function capState(ex: Executor, userId: string, purpose: AiPurpose, now: Date, caps: Caps = aiCaps()): Promise<CapState> {
  const u = await todaysUsage(ex, userId, now);
  if (u.spendLimitHit) return { capped: true, cap: "spend_limit" };
  const mine = u[purpose];
  const callCap = purpose === "triage" ? caps.triageCalls : caps.draftCalls;
  const usdCap = purpose === "triage" ? caps.triageMicros : caps.draftMicros;
  if (mine.calls >= callCap) return { capped: true, cap: "calls" };
  if (mine.micros >= usdCap) return { capped: true, cap: "usd" };
  if (u.totalMicros >= caps.totalMicros) return { capped: true, cap: "total_usd" };
  return { capped: false };
}

/** Audits `ai.cap_reached {purpose, cap}` at most once per UTC day per purpose. */
export async function auditCapReachedOnce(ex: Executor, userId: string, purpose: AiPurpose, cap: string, now: Date): Promise<boolean> {
  const [seen] = await ex
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, userId),
        eq(auditLog.action, "ai.cap_reached"),
        gte(auditLog.createdAt, utcDayStart(now)),
        sql`${auditLog.detail}->>'purpose' = ${purpose}`,
      ),
    )
    .limit(1);
  if (seen) return false;
  await audit({ userId, action: "ai.cap_reached", detail: { purpose, cap } }, ex);
  return true;
}

/**
 * Audits `ai.provider_error {purpose, status}` only on the first failure after a success or when
 * the error changes (like mail.sync_error). Call it before logging the failing call.
 */
export async function auditProviderErrorDeduped(ex: Executor, userId: string, accountId: string | null, purpose: AiPurpose, status: string): Promise<void> {
  const [last] = await ex
    .select({ status: aiCalls.status, errorCode: aiCalls.errorCode })
    .from(aiCalls)
    .where(and(eq(aiCalls.userId, userId), eq(aiCalls.purpose, purpose)))
    .orderBy(desc(aiCalls.createdAt))
    .limit(1);
  if (last && last.status === "error" && last.errorCode === status) return;
  await audit({ userId, accountId, action: "ai.provider_error", detail: { purpose, status } }, ex);
}

export type UsageReportRow = {
  day: string;
  purpose: AiPurpose;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsdMicros: number;
  /** Calls whose cost is the reserved worst case because no usage came back (round 4, B1). */
  estimated: number;
  estimatedUsdMicros: number;
};

/** The 2-week cost report: per UTC day and purpose, newest day first. */
export async function usageReport(ex: Executor, userId: string, now: Date, days = 14): Promise<UsageReportRow[]> {
  const since = new Date(utcDayStart(now).getTime() - (days - 1) * 86_400_000);
  const estimatedRow = and(eq(aiCalls.status, "error"), inArray(aiCalls.errorCode, [...ESTIMATED_COST_CODES]));
  const day = sql<string>`to_char(${aiCalls.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await ex
    .select({
      day,
      purpose: aiCalls.purpose,
      calls: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${aiCalls.status} not in ('ok', 'pending'))::int`,
      inputTokens: sql<number>`coalesce(sum(${aiCalls.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${aiCalls.outputTokens}), 0)::bigint`,
      thinkingTokens: sql<number>`coalesce(sum(${aiCalls.thinkingTokens}), 0)::bigint`,
      cacheWriteTokens: sql<number>`coalesce(sum(${aiCalls.cacheWriteTokens}), 0)::bigint`,
      cacheReadTokens: sql<number>`coalesce(sum(${aiCalls.cacheReadTokens}), 0)::bigint`,
      costUsdMicros: sql<number>`coalesce(sum(${aiCalls.costUsdMicros}), 0)::bigint`,
      estimated: sql<number>`count(*) filter (where ${estimatedRow})::int`,
      estimatedUsdMicros: sql<number>`coalesce(sum(${aiCalls.costUsdMicros}) filter (where ${estimatedRow}), 0)::bigint`,
    })
    .from(aiCalls)
    .where(and(eq(aiCalls.userId, userId), gte(aiCalls.createdAt, since)))
    .groupBy(day, aiCalls.purpose)
    .orderBy(desc(day), aiCalls.purpose);
  return rows.map((r) => ({
    day: r.day,
    purpose: r.purpose,
    calls: Number(r.calls),
    failed: Number(r.failed),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    thinkingTokens: Number(r.thinkingTokens),
    cacheWriteTokens: Number(r.cacheWriteTokens),
    cacheReadTokens: Number(r.cacheReadTokens),
    costUsdMicros: Number(r.costUsdMicros),
    estimated: Number(r.estimated),
    estimatedUsdMicros: Number(r.estimatedUsdMicros),
  }));
}

/** Links a draft's call row to the approval item it produced. */
export async function linkAiCallToItem(ex: Executor, callId: string, approvalItemId: string): Promise<void> {
  await ex.update(aiCalls).set({ approvalItemId }).where(eq(aiCalls.id, callId));
}

// ---- Draft single-flight (review round 1, D4) ------------------------------------------------

/** A pending draft row older than this is treated as a crashed attempt (90 s timeout, 120 s function limit). */
export const DRAFT_IN_FLIGHT_STALE_MS = 3 * 60_000;

/** `not_found`: the account was deleted (Disconnect) before this call could start (round 2, O1). */
export type DraftStart = { kind: "started"; callId: string } | { kind: "in_flight" } | { kind: "capped"; cap: string } | { kind: "not_found" };

/**
 * Atomically starts a draft call for the user and thread. In one transaction, serialized per user
 * with a Postgres advisory lock (so it holds across Vercel instances):
 * 1. a pending row older than DRAFT_IN_FLIGHT_STALE_MS is closed as `error`/`abandoned`, so a
 *    crashed attempt can't block the thread for good
 * 2. another pending draft for this thread means `in_flight`
 * 3. the daily caps are checked, counting pending rows as calls
 * 4. a `pending` row is inserted; the partial unique index (one pending draft per user and thread)
 *    backs this up
 * The caller must finish the row with finishAiCall.
 */
export async function startDraftCall(
  ex: Executor,
  input: { userId: string; accountId: string; threadId: string; provider: string; model: string; now: Date; caps?: Caps },
): Promise<DraftStart> {
  return ex.transaction(async (tx) => {
    // Lock order (phase-2-followups-1, owner Q7): the account row first, before the advisory lock,
    // so a concurrent Disconnect can't deadlock with the sweep UPDATE and the ai_calls insert. If
    // the account is already gone, nothing is written (the ai_calls insert would fail its FK).
    if (!(await lockAccountForWrite(tx, input.accountId))) return { kind: "not_found" as const };
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`alex-ai-draft:${input.userId}`}))`);
    await tx
      .update(aiCalls)
      // Round 4, B1: it may have been billed; keep counting it at the reserve.
      .set({ status: "error", errorCode: "abandoned", costUsdMicros: DRAFT_RESERVED_COST_MICROS })
      .where(
        and(
          eq(aiCalls.userId, input.userId),
          eq(aiCalls.purpose, "draft"),
          eq(aiCalls.status, "pending"),
          sql`${aiCalls.createdAt} < ${new Date(input.now.getTime() - DRAFT_IN_FLIGHT_STALE_MS).toISOString()}::timestamptz`,
        ),
      );
    const [busy] = await tx
      .select({ id: aiCalls.id })
      .from(aiCalls)
      .where(and(eq(aiCalls.userId, input.userId), eq(aiCalls.threadId, input.threadId), eq(aiCalls.purpose, "draft"), eq(aiCalls.status, "pending")))
      .limit(1);
    if (busy) return { kind: "in_flight" as const };
    const cap = await capState(tx, input.userId, "draft", input.now, input.caps ?? aiCaps());
    if (cap.capped) return { kind: "capped" as const, cap: cap.cap };
    const [row] = await tx
      .insert(aiCalls)
      .values({
        userId: input.userId,
        accountId: input.accountId,
        threadId: input.threadId,
        purpose: "draft",
        provider: input.provider,
        model: input.model,
        status: "pending",
        createdAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: aiCalls.id });
    return row ? { kind: "started" as const, callId: row.id } : { kind: "in_flight" as const };
  });
}

/** Completes a started call with its outcome, tokens and estimated cost. Only a still-pending row is updated. */
export async function finishAiCall(
  ex: Executor,
  callId: string,
  outcome: { status: Exclude<AiCall["status"], "pending">; errorCode: string | null; usage: AiUsage; approvalItemId?: string | null },
): Promise<{ costUsdMicros: number | null }> {
  const u = outcome.usage;
  const cost = u.costUsdMicros !== undefined && u.costUsdMicros !== null ? u.costUsdMicros : costUsdMicros(u.model, u);
  await ex
    .update(aiCalls)
    .set({
      status: outcome.status,
      errorCode: outcome.errorCode,
      provider: u.provider,
      model: u.model,
      requestId: u.requestId,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      thinkingTokens: u.thinkingTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      cacheReadTokens: u.cacheReadTokens,
      costUsdMicros: cost,
      pricingVersion: cost === null ? null : PRICING_VERSION,
      latencyMs: Math.max(0, Math.round(u.latencyMs)),
      approvalItemId: outcome.approvalItemId ?? null,
    })
    .where(and(eq(aiCalls.id, callId), eq(aiCalls.status, "pending")));
  return { costUsdMicros: cost };
}

// ---- Closing a draft call when the account may be gone (phase-2-followups-2, O2) ---------------

/** The closing audit of a draft: `ai.draft_failed {code}` or `ai.draft_proposed {itemId, model, costUsdMicros}`. */
export type DraftClosing = { action: "ai.draft_failed" | "ai.draft_proposed"; detail: Record<string, unknown> };

export type FinishDraftInput = {
  callId: string;
  userId: string;
  accountId: string;
  status: Exclude<AiCall["status"], "pending">;
  errorCode: string | null;
  usage: AiUsage;
  /** Linked only if the account still exists (otherwise the item cascaded with it). */
  approvalItemId?: string | null;
  /** Audits `ai.provider_error` (deduped) first, with this status, when set. */
  providerError?: string | null;
  /** The error code recorded instead when the account is gone (owner Q6); omitted keeps `errorCode`. */
  errorCodeIfGone?: string;
  /** The closing audit, given whether the account still exists and the recorded cost. */
  closing: (r: { accountLive: boolean; costUsdMicros: number | null }) => DraftClosing;
};

async function closeDraftCall(tx: Executor, input: FinishDraftInput, accountLive: boolean) {
  const accountId = accountLive ? input.accountId : null;
  if (input.providerError) await auditProviderErrorDeduped(tx, input.userId, accountId, "draft", input.providerError);
  const call = await finishAiCall(tx, input.callId, {
    status: input.status,
    errorCode: accountLive ? input.errorCode : (input.errorCodeIfGone ?? input.errorCode),
    usage: input.usage,
    approvalItemId: accountLive ? (input.approvalItemId ?? null) : null,
  });
  const closing = input.closing({ accountLive, costUsdMicros: call.costUsdMicros });
  await audit({ userId: input.userId, accountId, action: closing.action, detail: closing.detail }, tx);
  return { costUsdMicros: call.costUsdMicros, accountLive };
}

/**
 * Finishes a started draft call and writes its closing audit in one transaction that locks the
 * account first (O2). If the account was disconnected while the call ran, the row is still finished
 * with the real usage (so the caps and the report stay right) and no item link, and the audits carry
 * a null account id instead of failing their FK. A Disconnect that arrives meanwhile waits for this.
 */
export async function finishDraftCall(ex: Executor, input: FinishDraftInput): Promise<{ costUsdMicros: number | null; accountLive: boolean }> {
  return ex.transaction(async (tx) => {
    if (!(await lockAccountForWrite(tx, input.accountId))) return closeDraftCall(tx, input, false);
    return closeDraftCall(tx, input, true);
  });
}
