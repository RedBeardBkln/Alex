import { env } from "@/lib/env";
import { usdToMicros } from "./pricing";

/**
 * AI configuration (Phase 2c, owner Q4). Page-safe: no SDK. The caps are per UTC day, checked
 * against the `ai_calls` log before every call, and env-overridable. An invalid override falls
 * back to the default.
 */

export const DEFAULT_CAPS = {
  triageCalls: 400,
  triageUsd: 0.5,
  draftCalls: 25,
  draftUsd: 3,
  totalUsd: 3.5,
} as const;

export type Caps = { triageCalls: number; triageMicros: number; draftCalls: number; draftMicros: number; totalMicros: number };

function num(value: string | undefined, fallback: number, integer: boolean): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) return fallback;
  return n;
}

export function aiCaps(e: Pick<ReturnType<typeof env>, "AI_TRIAGE_MAX_CALLS_PER_DAY" | "AI_TRIAGE_MAX_USD_PER_DAY" | "AI_DRAFT_MAX_CALLS_PER_DAY" | "AI_DRAFT_MAX_USD_PER_DAY" | "AI_MAX_USD_PER_DAY"> = env()): Caps {
  return {
    triageCalls: num(e.AI_TRIAGE_MAX_CALLS_PER_DAY, DEFAULT_CAPS.triageCalls, true),
    triageMicros: usdToMicros(num(e.AI_TRIAGE_MAX_USD_PER_DAY, DEFAULT_CAPS.triageUsd, false)),
    draftCalls: num(e.AI_DRAFT_MAX_CALLS_PER_DAY, DEFAULT_CAPS.draftCalls, true),
    draftMicros: usdToMicros(num(e.AI_DRAFT_MAX_USD_PER_DAY, DEFAULT_CAPS.draftUsd, false)),
    totalMicros: usdToMicros(num(e.AI_MAX_USD_PER_DAY, DEFAULT_CAPS.totalUsd, false)),
  };
}

/** True when an API key is set. Without it every AI feature is off. */
export function aiConfigured(): boolean {
  return !!env().ANTHROPIC_API_KEY;
}

/** The configured triage provider id, or null when triage is off (no key, or an unknown id). */
export const KNOWN_TRIAGE_PROVIDERS = ["anthropic-haiku"] as const;
export function triageProviderId(): (typeof KNOWN_TRIAGE_PROVIDERS)[number] | null {
  if (!aiConfigured()) return null;
  const id = env().AI_TRIAGE_PROVIDER ?? "anthropic-haiku";
  return (KNOWN_TRIAGE_PROVIDERS as readonly string[]).includes(id) ? (id as (typeof KNOWN_TRIAGE_PROVIDERS)[number]) : null;
}

/** Start of the current UTC day, and of the next one (when a cap pause ends). */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
export function nextUtcMidnight(now: Date): Date {
  return new Date(utcDayStart(now).getTime() + 86_400_000);
}
