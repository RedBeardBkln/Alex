import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { emptyUsage, SPEND_LIMIT_CODE, type AiUsage } from "@/lib/ai-ledger/ledger";
import { parseDraftOutput, parseTriageOutput } from "../parse";
import { buildDraftRequest, buildTriageRequest, DRAFT_MODEL, TRIAGE_MODEL, type ModelRequest } from "../prompts";
import type { DraftOutcome, DraftProvider, ProviderStatus, TriageOutcome, TriageProvider } from "../types";

/**
 * Anthropic implementations of the AI providers (Phase 2c). The only module that imports
 * `@anthropic-ai/sdk` (a static test checks this).
 *
 * SDK usage follows the installed package's own types (node_modules/@anthropic-ai/sdk 1.11.0):
 * `new Anthropic({ apiKey, maxRetries })`, `client.messages.create(params, { signal, timeout })`
 * and `.withResponse()` for the request id; the error classes exported from the package root.
 * Content is read by block `type` (thinking blocks can come first), and `stop_reason` is checked
 * before parsing. No refusal fallback is used (approval amendment B).
 */

export const ANTHROPIC_TRIAGE_ID = "anthropic-haiku";
export const ANTHROPIC_DRAFT_ID = "anthropic-opus";

type Client = Pick<Anthropic, "messages">;

/** Content-free error code for a failed call; spend limits pause the feature for the day. */
export function classifyError(err: unknown): { code: string; requestId: string | null } {
  if (err instanceof APIUserAbortError) return { code: "aborted", requestId: null };
  if (err instanceof APIConnectionTimeoutError) return { code: "timeout", requestId: null };
  if (err instanceof APIConnectionError) return { code: "network", requestId: null };
  if (err instanceof APIError) {
    const requestId = err.requestID ?? null;
    const status = err.status ?? 0;
    const errorCode = err.errorCode ?? "";
    const retryAfter = err.headers?.get?.("retry-after") ?? null;
    // Spend limits (API errors reference): a 400 or 402 billing/spend-limit answer, or a 429
    // spend cap (no retry-after, or a spend-limit error code).
    if (errorCode.includes("spend_limit") || err.type === "billing_error" || status === 402 || (status === 429 && !retryAfter)) {
      return { code: SPEND_LIMIT_CODE, requestId };
    }
    if (status === 429) return { code: "rate_limit", requestId };
    if (status >= 500) return { code: "api_5xx", requestId };
    if (status > 0) return { code: `api_${status}`, requestId };
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return { code: "timeout", requestId: null };
  return { code: "unexpected", requestId: null };
}

function usageOf(model: string, provider: string, raw: Pick<Message, "usage">, latencyMs: number, requestId: string | null): AiUsage {
  const u = raw.usage;
  return {
    provider,
    model,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    thinkingTokens: u.output_tokens_details?.thinking_tokens ?? null,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    latencyMs,
    requestId,
  };
}

/** Sends one request; returns the stop reason, the joined text blocks and the usage, or a classified error. */
async function call(
  client: Client,
  provider: string,
  request: ModelRequest,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ ok: true; stop: string | null; text: string; usage: AiUsage } | { ok: false; code: string; usage: AiUsage }> {
  const started = Date.now();
  try {
    // The builders' plain-data request is checked against the SDK's own parameter type here.
    const params: MessageCreateParamsNonStreaming = request;
    const { data: raw, request_id } = await client.messages.create(params, { signal, timeout: timeoutMs }).withResponse();
    const text = raw.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("");
    return { ok: true, stop: raw.stop_reason, text, usage: usageOf(request.model, provider, raw, Date.now() - started, request_id ?? null) };
  } catch (err) {
    const { code, requestId } = classifyError(err);
    return { ok: false, code, usage: { ...emptyUsage(provider, request.model, Date.now() - started), requestId } };
  }
}

/** Maps a stop reason to a status (plan §6.5, amendment B). */
export function statusForStop(stop: string | null): { status: ProviderStatus; code: string | null } {
  if (stop === "end_turn") return { status: "ok", code: null };
  if (stop === "refusal") return { status: "refused", code: "refusal" };
  if (stop === "max_tokens") return { status: "invalid", code: "max_tokens" };
  return { status: "invalid", code: `stop_${stop ?? "none"}` };
}

export function anthropicClient(apiKey: string): Anthropic {
  // The SDK retries transient failures twice by default; set explicitly.
  return new Anthropic({ apiKey, maxRetries: 2 });
}

export function anthropicTriageProvider(client: Client, timeoutMs = 30_000): TriageProvider {
  return {
    id: ANTHROPIC_TRIAGE_ID,
    async triage(input, signal): Promise<TriageOutcome> {
      const r = await call(client, ANTHROPIC_TRIAGE_ID, buildTriageRequest(input), signal, timeoutMs);
      if (!r.ok) return { status: "error", result: null, errorCode: r.code, usage: r.usage };
      const s = statusForStop(r.stop);
      if (s.status !== "ok") return { status: s.status, result: null, errorCode: s.code, usage: r.usage };
      const result = parseTriageOutput(r.text);
      return result ? { status: "ok", result, errorCode: null, usage: r.usage } : { status: "invalid", result: null, errorCode: "schema", usage: r.usage };
    },
  };
}

export function anthropicDraftProvider(client: Client, timeoutMs = 90_000): DraftProvider {
  return {
    id: ANTHROPIC_DRAFT_ID,
    async draft(input, signal): Promise<DraftOutcome> {
      const r = await call(client, ANTHROPIC_DRAFT_ID, buildDraftRequest(input), signal, timeoutMs);
      if (!r.ok) return { status: "error", body: null, notes: null, errorCode: r.code, usage: r.usage };
      const s = statusForStop(r.stop);
      if (s.status !== "ok") return { status: s.status, body: null, notes: null, errorCode: s.code, usage: r.usage };
      const parsed = parseDraftOutput(r.text);
      return parsed
        ? { status: "ok", body: parsed.body, notes: parsed.notes, errorCode: null, usage: r.usage }
        : { status: "invalid", body: null, notes: null, errorCode: "schema", usage: r.usage };
    },
  };
}

export { DRAFT_MODEL, TRIAGE_MODEL };
