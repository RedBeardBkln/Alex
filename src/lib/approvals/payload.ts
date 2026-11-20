import { createHash } from "node:crypto";
import { z } from "zod";
import { isValidAddress, MAX_RECIPIENTS } from "./addresses";
import { isValidSubject, MAX_BODY_CHARS, MSG_ID_RE } from "@/lib/gmail/compose";
import { sliceOnCodePoint, stripDisallowedControls, wellFormed } from "./text";

/** Longest quoted text included in a reply (owner Q7). */
export const MAX_QUOTE_CHARS = 20_000;

const address = z.string().refine(isValidAddress, "invalid address");

/** `email.send` payload (plan §4). Validated on every write and again before execution. */
export const emailSendPayload = z
  .object({
    to: z.array(address).min(1).max(MAX_RECIPIENTS),
    cc: z.array(address).max(MAX_RECIPIENTS),
    subject: z.string().refine(isValidSubject, "invalid subject"),
    bodyText: z.string().max(MAX_BODY_CHARS),
    quote: z.object({ included: z.boolean(), text: z.string().max(MAX_QUOTE_CHARS) }).nullable(),
    threading: z
      .object({
        gmailThreadId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
        inReplyTo: z.string().regex(MSG_ID_RE).nullable(),
        references: z.array(z.string().regex(MSG_ID_RE)).max(10),
      })
      .nullable(),
    replyToNotice: z.boolean(),
  })
  .strict()
  .refine((p) => p.to.length + p.cc.length <= MAX_RECIPIENTS, "too many recipients");

export type EmailSendPayload = z.infer<typeof emailSendPayload>;

/**
 * The only definition of "new message" (Phase 2d, plan §4): an `email.send` payload whose
 * `threading` is null. Every reply has a threading object (replyThreading always returns one). A
 * stored payload missing the key is not a new message, so it takes the stricter reply rules.
 */
export function isNewMessage(payload: unknown): boolean {
  return payload !== null && typeof payload === "object" && "threading" in payload && (payload as { threading: unknown }).threading === null;
}

/** JSON with object keys sorted at every level, so equal content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 (hex) of the canonical JSON of {kind, accountId, payload}. */
export function contentHash(kind: string, accountId: string | null, payload: unknown): string {
  return createHash("sha256").update(canonicalJson({ kind, accountId, payload })).digest("hex");
}

/** The text that is sent: the owner's text, then the quoted text if it is included. */
export function outgoingBody(p: EmailSendPayload): string {
  if (!p.quote || !p.quote.included || p.quote.text === "") return p.bodyText;
  return `${p.bodyText}\n\n${p.quote.text}`;
}

/**
 * Plain-text quote of the parent (owner Q7): an attribution line, then `> ` lines; the result is
 * capped at MAX_QUOTE_CHARS on a code-point boundary (review D2: a cut inside a surrogate pair made
 * the jsonb insert fail). The parent text is attacker-controlled, so lone surrogates are replaced
 * and control characters other than tab and newline are removed.
 */
export function quoteText(parent: { fromHeader: string | null; dateHeader: string | null; text: string | null }): string {
  const source = stripDisallowedControls(wellFormed(sliceOnCodePoint((parent.text ?? "").replace(/\r\n?/g, "\n"), MAX_QUOTE_CHARS)));
  if (source.trim() === "") return "";
  const who = sliceOnCodePoint(wellFormed(parent.fromHeader ?? "the sender").replace(/[\x00-\x1F\x7F]+/g, " "), 300);
  const when = parent.dateHeader ? `On ${sliceOnCodePoint(wellFormed(parent.dateHeader).replace(/[\x00-\x1F\x7F]+/g, " "), 100)}, ` : "";
  const quoted = source
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  return sliceOnCodePoint(`${when}${who} wrote:\n${quoted}`, MAX_QUOTE_CHARS);
}
