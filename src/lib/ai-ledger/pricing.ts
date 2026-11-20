/**
 * Claude API prices (Phase 2c), in US dollars per million tokens, from
 * https://platform.claude.com/docs/en/about-claude/pricing (read 2026-11-19). Import-free.
 *
 * - Thinking is billed as output tokens and is included in `output_tokens`.
 * - Haiku 5.5's long-prompt tier applies when the whole prompt (input + cache writes + cache reads)
 *   exceeds 100K tokens.
 * - Cache writes are priced at the 5-minute rate (the only TTL Alex requests).
 * - Global (default) inference; batch and US-only pricing are not used.
 * Costs are estimates; the report says so.
 */

export const PRICING_VERSION = "anthropic-2026-11-19";

type Rates = { input: number; output: number; cacheWrite5m: number; cacheRead: number };

const HAIKU_5_5: Rates = { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheRead: 0.01 };
const HAIKU_5_5_LONG: Rates = { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheRead: 0.05 };
const OPUS_5_5: Rates = { input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.2 };

export const HAIKU_LONG_PROMPT_TOKENS = 100_000;

export type TokenCounts = { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number };

function ratesFor(model: string, promptTokens: number): Rates | null {
  if (model === "claude-haiku-5-5") return promptTokens > HAIKU_LONG_PROMPT_TOKENS ? HAIKU_5_5_LONG : HAIKU_5_5;
  if (model === "claude-opus-5-5") return OPUS_5_5;
  return null;
}

/**
 * Estimated cost in millionths of a dollar (USD per MTok equals micro-dollars per token), rounded
 * to the nearest micro-dollar. Null for a model without a known price.
 */
export function costUsdMicros(model: string, t: TokenCounts): number | null {
  const prompt = t.inputTokens + t.cacheWriteTokens + t.cacheReadTokens;
  const r = ratesFor(model, prompt);
  if (!r) return null;
  return Math.round(t.inputTokens * r.input + t.outputTokens * r.output + t.cacheWriteTokens * r.cacheWrite5m + t.cacheReadTokens * r.cacheRead);
}

/** Micro-dollars from a dollar amount (for caps). */
export const usdToMicros = (usd: number) => Math.round(usd * 1_000_000);

/**
 * Worst-case cost reserved for a draft call while it is in flight (round 3, E3), so concurrent
 * drafts can't exceed a dollar cap. Opus 5.5 at the draft limits:
 * - output: max_tokens 16,000 (thinking included)
 * - input: the whole sender-controlled part of the request, the read_thread tool result, is at most
 *   THREAD_TEXT_CAP (30,000) UTF-16 code units by construction (capThread in src/lib/ai/prompts.ts:
 *   headers, JSON keys and escapes included, E4 follow-up), plus 2,000 tokens for the system
 *   prompt, the owner instruction and the request structure
 * 32,000 × $4 + 16,000 × $20 per MTok = 128,000 + 320,000 = 448,000 micro-dollars ($0.448).
 *
 * The bound rests on two assumptions, neither exact:
 * - A: at most one input token per code unit of the tool result. Not verifiable against Anthropic's
 *   tokenizer (it isn't documented per character); ordinary text uses far fewer. If an unusual
 *   script took 3 tokens per unit, a hostile draft's input would be about 92,000 tokens, ≈ $0.69.
 * - B: the fixed parts fit in the 2,000-token allowance. The request without messages is 3,530
 *   characters of JSON (5,587 with a 2,000-character instruction), and the owner's smoke run of
 *   2026-11-20 measured about 1,584 tokens of fixed overhead for a draft (input plus cache write),
 *   so a maximum-length instruction may go slightly over (fractions of a cent).
 * Keep in step with DRAFT_MAX_TOKENS and THREAD_TEXT_CAP in src/lib/ai/prompts.ts (a test checks).
 */
export const DRAFT_RESERVED_INPUT_TOKENS = 30_000 + 2_000;
export const DRAFT_RESERVED_OUTPUT_TOKENS = 16_000;
export const DRAFT_RESERVED_COST_MICROS = costUsdMicros("claude-opus-5-5", {
  inputTokens: DRAFT_RESERVED_INPUT_TOKENS,
  outputTokens: DRAFT_RESERVED_OUTPUT_TOKENS,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
})!;

/**
 * Worst-case cost of one triage call (round 4, B1), derived like the draft reserve: Haiku 5.5 at
 * TRIAGE_MAX_TOKENS 1,024 output, and the read_message tool result (at most MESSAGE_TEXT_CAP, 6,000
 * code units, headers included, by construction) at one token per code unit, plus 2,000 tokens of
 * prompt and structure. 8,000 × $0.10 + 1,024 × $0.50 per MTok = 1,312 µ$. The same assumptions A
 * and B as the draft reserve apply (the owner's smoke run measured about 1,539 tokens of fixed
 * triage overhead).
 * Keep in step with TRIAGE_MAX_TOKENS and MESSAGE_TEXT_CAP in src/lib/ai/prompts.ts (a test checks).
 */
export const TRIAGE_RESERVED_INPUT_TOKENS = 6_000 + 2_000;
export const TRIAGE_RESERVED_OUTPUT_TOKENS = 1_024;
export const TRIAGE_RESERVED_COST_MICROS = costUsdMicros("claude-haiku-5-5", {
  inputTokens: TRIAGE_RESERVED_INPUT_TOKENS,
  outputTokens: TRIAGE_RESERVED_OUTPUT_TOKENS,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
})!;

/**
 * Error codes after which the request may have reached Anthropic and been billed, but no usage came
 * back (round 4, B1). Such calls are recorded at the purpose's reserved worst case, as are draft
 * rows swept as `abandoned`. Definite refusals (spend limit, 429, other 4xx) stay at $0.
 */
export const AMBIGUOUS_ERROR_CODES: readonly string[] = ["timeout", "aborted", "network", "unexpected", "api_5xx"];
/** Codes whose recorded cost is the reserve, not a measured figure: shown as "estimated (no usage returned)". */
export const ESTIMATED_COST_CODES: readonly string[] = [...AMBIGUOUS_ERROR_CODES, "abandoned"];

/** The reserved cost to record for a failed call, or null if its cost comes from the returned usage. */
export function ambiguousFailureCost(purpose: "triage" | "draft", status: string, errorCode: string | null): number | null {
  if (status !== "error" || errorCode === null || !AMBIGUOUS_ERROR_CODES.includes(errorCode)) return null;
  return purpose === "draft" ? DRAFT_RESERVED_COST_MICROS : TRIAGE_RESERVED_COST_MICROS;
}
