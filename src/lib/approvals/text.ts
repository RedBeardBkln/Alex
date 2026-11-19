/**
 * Text hygiene for approval payloads (Phase 2b review round 1, D2/D4 and the bidi note). Import-free.
 * Written with char-code checks rather than regex escapes on purpose.
 */

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;

/** Replaces lone surrogates with U+FFFD, so the text is valid UTF-16 and can be stored in jsonb. */
export function wellFormed(s: string): string {
  return s.toWellFormed();
}

/** The first `max` UTF-16 code units, never cutting a surrogate pair in half. */
export function sliceOnCodePoint(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = isHighSurrogate(s.charCodeAt(max - 1)) ? max - 1 : max;
  return s.slice(0, cut);
}

/** C0 controls other than tab and newline, plus DEL. CR is normalized to LF before this check. */
const isDisallowedControl = (c: number) => (c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f;

/** True if owner text (body) contains NUL or another disallowed control character. */
export function hasDisallowedControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (isDisallowedControl(s.charCodeAt(i))) return true;
  return false;
}

/** Removes disallowed control characters (for derived text such as the quote, which isn't owner input). */
export function stripDisallowedControls(s: string): string {
  const out: string[] = [];
  for (const ch of s) if (!isDisallowedControl(ch.charCodeAt(0))) out.push(ch);
  return out.join("");
}

/** Bidirectional formatting characters (ALM, LRM, RLM, LRE..RLO, LRI..PDI), which can make text display misleadingly. */
export function isBidiControl(c: number): boolean {
  return c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
}

export function hasBidiControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (isBidiControl(s.charCodeAt(i))) return true;
  return false;
}

export function stripBidiControls(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) if (!isBidiControl(s.charCodeAt(i))) out.push(s[i]!);
  return out.join("");
}
