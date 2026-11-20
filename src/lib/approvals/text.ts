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
/**
 * Removes C0 controls (except tab and newline), DEL and the C1 controls U+0080–U+009F (round 3,
 * E1). For AI-written text, which is never sent with any control character.
 */
export function stripAllControls(s: string): string {
  const out: string[] = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (isDisallowedControl(c) || (c >= 0x80 && c <= 0x9f)) continue;
    out.push(ch);
  }
  return out.join("");
}

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

/**
 * Bidi and invisible formatting characters flagged on the approval page and removed from AI
 * summaries (Phase 2c, plan §6.7): U+202A–202E, U+2066–2069, U+200B–200F, U+2060–2064, U+FEFF,
 * plus ALM (U+061C), U+180E, U+2028/U+2029, the tag characters U+E0000–E007F (round 2) and the C1
 * controls U+0080–U+009F (round 3).
 */
export function isInvisibleOrBidi(c: number): boolean {
  return (
    (c >= 0x80 && c <= 0x9f) || // C1 controls, e.g. NEL and CSI (round 3, E1)
    c === 0x061c ||
    c === 0x180e || // Mongolian vowel separator (review round 1, O2)
    c === 0xfeff ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202e) || // line/paragraph separators and LRE..RLO
    (c >= 0x2060 && c <= 0x2064) ||
    (c >= 0x2066 && c <= 0x2069) ||
    (c >= 0xe0000 && c <= 0xe007f) // tag characters ("ASCII smuggling"; review round 1, O2)
  );
}

/** Every bidi or invisible character in `s` (by code point), with its UTF-16 index. */
export function findInvisible(s: string): { codePoint: number; index: number }[] {
  const out: { codePoint: number; index: number }[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    if (isInvisibleOrBidi(c)) out.push({ codePoint: c, index: i });
    if (c > 0xffff) i++; // the low surrogate of a pair
  }
  return out;
}

export function stripInvisible(s: string): string {
  const out: string[] = [];
  for (const ch of s) if (!isInvisibleOrBidi(ch.codePointAt(0)!)) out.push(ch);
  return out.join("");
}
