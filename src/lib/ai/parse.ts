import { sliceOnCodePoint, stripAllControls, stripInvisible, wellFormed } from "@/lib/approvals/text";
import { TRIAGE_CATEGORIES, type TriageResult } from "./types";

/**
 * Parsing model output (Phase 2c, plan §6.5). The output is model text derived from attacker
 * input, so it is validated strictly:
 * - it must be one JSON object with exactly the schema's keys (extra keys mean invalid)
 * - the category is matched case-insensitively against the enum; anything else is invalid
 * - text fields are made well-formed, control characters (except newline and tab in the draft
 *   body) removed, and capped; the summary also loses bidi and invisible characters
 * Callers check `stop_reason` before calling these (refusal and max_tokens never get here).
 */

export const SUMMARY_CAP = 200;
export const DRAFT_BODY_CAP = 20_000;
export const DRAFT_NOTES_CAP = 500;

function parseObject(text: string, keys: string[]): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k))) return null;
  return value as Record<string, unknown>;
}

/** One line of plain text: no controls, no bidi or invisible characters, whitespace collapsed. */
export function cleanSummary(s: string): string {
  const plain = stripInvisible(stripAllControls(wellFormed(s)))
    .replace(/[\t\n]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return sliceOnCodePoint(plain, SUMMARY_CAP).trim();
}

export function parseTriageOutput(text: string): TriageResult | null {
  const o = parseObject(text, ["category", "needs_reply", "summary"]);
  if (!o) return null;
  if (typeof o.category !== "string" || typeof o.needs_reply !== "boolean" || typeof o.summary !== "string") return null;
  const category = TRIAGE_CATEGORIES.find((c) => c === (o.category as string).trim().toLowerCase());
  if (!category) return null;
  return { category, needsReply: o.needs_reply, summary: cleanSummary(o.summary) };
}

/** The draft body: well-formed, CRLF normalized, controls other than newline and tab removed, capped, non-empty. */
export function cleanDraftBody(s: string): string {
  const t = stripAllControls(wellFormed(s).replace(/\r\n?/g, "\n")).trim();
  return sliceOnCodePoint(t, DRAFT_BODY_CAP);
}

export function parseDraftOutput(text: string): { body: string; notes: string } | null {
  const o = parseObject(text, ["body", "notes"]);
  if (!o || typeof o.body !== "string" || typeof o.notes !== "string") return null;
  const body = cleanDraftBody(o.body);
  if (body === "") return null;
  return { body, notes: cleanSummaryLike(o.notes, DRAFT_NOTES_CAP) };
}

function cleanSummaryLike(s: string, cap: number): string {
  const plain = stripInvisible(stripAllControls(wellFormed(s).replace(/\r\n?/g, "\n"))).trim();
  return sliceOnCodePoint(plain, cap).trim();
}
