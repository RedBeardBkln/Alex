import { isValidAddress } from "@/lib/approvals/addresses";
import { stripAllControls, wellFormed } from "@/lib/approvals/text";

/**
 * Gmail signature HTML to plain text (phase email-signatures, plan section 6). Pure and synchronous:
 * no I/O, no fetch, no dynamic import. Only `@/lib/approvals/text` and `@/lib/approvals/addresses`
 * are imported (a static test pins this), and only `lib/signatures/refresh.ts` calls it.
 *
 * Why not `htmlToPlainText` (src/lib/email/plain-text.ts): it drops every attribute, so it can't
 * write link targets, and it is a SANITIZER_SOURCE_FILES entry that must not change. The tag
 * classification below follows the structure of its `readTag`/`skipRawText`, but tag ends are found
 * quote-aware here, because an attribute value (an href) is read.
 *
 * One left-to-right scan. Every search is an indexOf or a forward loop from the current position,
 * and the position only moves forward. Output is collected in an array and joined once; a link
 * target is inserted at a recorded index. The result is plain text: it is rendered as React text or
 * put in a text/plain body, never as HTML, so a mis-parse can garble or reveal text but can't inject
 * markup.
 *
 * Links: each anchor's target is written after its visible text, `Book a meeting <https://…>`
 * (owner Q1b b); an image-only link becomes the bare `<target>` (owner Q-B a). Only http, https,
 * mailto and tel targets are ever written (linkTarget). The `new URL` calls are bounded by the input:
 * each parses at most 2,048 units of an href or of an anchor's visible text, both of which are part
 * of the at most 64 KiB input, and anchors past the 20th expanded one parse nothing.
 */

/** Longest signature HTML read, in UTF-16 units; longer is `too_large` and isn't scanned. */
export const MAX_SIGNATURE_HTML = 65_536;
/** Longest converted signature, in UTF-16 units (Gmail's own limit is 10,000 characters). Longer is `too_large`, never cut (owner Q-C). */
export const MAX_SIGNATURE_TEXT = 10_000;
/** Anchors that get a written target; later anchors keep their text only. */
export const MAX_SIGNATURE_LINKS = 20;
/** Longest href (raw) or written target, in UTF-16 units. */
export const MAX_LINK_TARGET = 2_048;

export type SignatureConversion = { state: "set"; text: string } | { state: "none" } | { state: "too_large" };

const MAX_TAG_NAME = 32;
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "title", "textarea", "xmp", "noscript", "template", "noembed", "noframes", "iframe"]);
const LINE_BREAK_ELEMENTS = new Set(["br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "hr", "ul", "ol"]);
const CELL_ELEMENTS = new Set(["td", "th"]);

/** ASCII-only lowercasing; never changes the string's length, so indexes stay aligned. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

const isAsciiLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isAsciiLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
/** HTML whitespace (CR is normalized to LF before the scan, but an entity can still produce one). */
const isHtmlSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
/** Whitespace for "does the link have visible text": HTML whitespace plus NBSP. */
const isBlank = (c: number) => isHtmlSpace(c) || c === 0xa0;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHexDigit = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

// ---- Entities (plan 6.5) ---------------------------------------------------------------------------

const REPLACEMENT = String.fromCharCode(0xfffd);
const NBSP = String.fromCharCode(0xa0);

const NAMED_ENTITIES: [string, string][] = [
  ["amp;", "&"],
  ["lt;", "<"],
  ["gt;", ">"],
  ["quot;", '"'],
  ["apos;", "'"],
  ["nbsp;", NBSP],
];

function codePointText(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return REPLACEMENT;
  return String.fromCodePoint(cp);
}

/** Decodes the supported entities. Bounded lookahead at each `&`; unknown named entities stay literal. */
export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const amp = s.indexOf("&", pos);
    if (amp < 0) {
      out.push(s.slice(pos));
      break;
    }
    out.push(s.slice(pos, amp));
    const named = NAMED_ENTITIES.find(([name]) => s.startsWith(name, amp + 1));
    if (named) {
      out.push(named[1]);
      pos = amp + 1 + named[0].length;
      continue;
    }
    if (s.charCodeAt(amp + 1) === 35 /* # */) {
      const hex = s.charCodeAt(amp + 2) === 120 || s.charCodeAt(amp + 2) === 88; // x X
      const start = amp + (hex ? 3 : 2);
      const digit = hex ? isHexDigit : isDigit;
      let k = start;
      while (k < s.length && k - start < 8 && digit(s.charCodeAt(k))) k++;
      if (k > start) {
        let value = parseInt(s.slice(start, k), hex ? 16 : 10);
        if (k < s.length && digit(s.charCodeAt(k))) {
          // More than 8 digits: invalid. Skip the rest of the run (each digit is visited once).
          value = NaN;
          while (k < s.length && digit(s.charCodeAt(k))) k++;
        }
        out.push(codePointText(value));
        pos = s.charCodeAt(k) === 59 /* ; */ ? k + 1 : k;
        continue;
      }
    }
    out.push("&");
    pos = amp + 1;
  }
  return out.join("");
}

// ---- Tags ------------------------------------------------------------------------------------------

type Tag =
  | { kind: "skip"; next: number } // comment, <!…>, <?…>
  | { kind: "text" } // a "<" that doesn't start a tag
  | { kind: "eof" } // unterminated comment, tag or quote: nothing after it is examined
  | { kind: "tag"; name: string; closing: boolean; href: string | null; next: number };

/**
 * Classifies the markup at `lt` (html[lt] === "<"). Attributes are read until a `>` outside quotes.
 * `href` is the first `href` attribute (ASCII case-insensitive) of an opening `a` tag, else null.
 */
function readTag(html: string, lower: string, lt: number): Tag {
  const n = html.length;
  if (html.startsWith("!--", lt + 1)) {
    const end = html.indexOf("-->", lt + 4);
    return end < 0 ? { kind: "eof" } : { kind: "skip", next: end + 3 };
  }
  const c = html.charCodeAt(lt + 1);
  if (c === 33 /* ! */ || c === 63 /* ? */) {
    const gt = html.indexOf(">", lt + 2);
    return gt < 0 ? { kind: "eof" } : { kind: "skip", next: gt + 1 };
  }
  let j = lt + 1;
  const closing = c === 47; /* / */
  if (closing) j += 1;
  if (j >= n || !isAsciiLetter(html.charCodeAt(j))) return { kind: "text" };
  let k = j;
  while (k < n && k - j < MAX_TAG_NAME && isNameChar(html.charCodeAt(k))) k++;
  const name = lower.slice(j, k);
  const wantHref = !closing && name === "a";
  let href: string | null = null;
  for (;;) {
    while (k < n && (isHtmlSpace(html.charCodeAt(k)) || html.charCodeAt(k) === 47)) k++;
    if (k >= n) return { kind: "eof" };
    if (html.charCodeAt(k) === 62 /* > */) return { kind: "tag", name, closing, href, next: k + 1 };
    // Attribute name: up to whitespace, "=", ">" or "/"; at least one character, so the scan advances.
    const nameStart = k;
    k++;
    while (k < n) {
      const d = html.charCodeAt(k);
      if (isHtmlSpace(d) || d === 61 || d === 62 || d === 47) break;
      k++;
    }
    const attrName = lower.slice(nameStart, k);
    while (k < n && isHtmlSpace(html.charCodeAt(k))) k++;
    let value: string | null = null;
    if (k < n && html.charCodeAt(k) === 61 /* = */) {
      k++;
      while (k < n && isHtmlSpace(html.charCodeAt(k))) k++;
      if (k >= n) return { kind: "eof" };
      const q = html.charCodeAt(k);
      if (q === 34 || q === 39) {
        const end = html.indexOf(q === 34 ? '"' : "'", k + 1);
        if (end < 0) return { kind: "eof" };
        value = html.slice(k + 1, end);
        k = end + 1;
      } else {
        const start = k;
        while (k < n && !isHtmlSpace(html.charCodeAt(k)) && html.charCodeAt(k) !== 62) k++;
        value = html.slice(start, k);
      }
    }
    if (wantHref && href === null && attrName === "href") href = value ?? "";
  }
}

/** Position just after the end tag of a raw-text element opened before `from`, or -1 if there is none. */
function skipRawText(html: string, lower: string, name: string, from: number): number {
  const end = lower.indexOf(`</${name}`, from);
  if (end < 0) return -1;
  const gt = html.indexOf(">", end);
  return gt < 0 ? -1 : gt + 1;
}

// ---- Links (plan 6.4) ------------------------------------------------------------------------------

const isC0OrSpace = (c: number) => c <= 0x20;
const isControl = (c: number) => c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function percentDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Printable ASCII (0x21–0x7E) with no "<" or ">", at most MAX_LINK_TARGET units. */
function passesFinalGate(target: string): boolean {
  if (target.length === 0 || target.length > MAX_LINK_TARGET) return false;
  for (let i = 0; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || c === 60 || c === 62) return false;
  }
  return true;
}

const TEL_RE = /^\+?[0-9 ().-]{1,64}$/;

/** "+" (if present) and the digits of a tel value matching TEL_RE with 3–20 digits, else null. */
function telDigits(value: string): string | null {
  if (!TEL_RE.test(value)) return null;
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 3 || digits.length > 20) return null;
  return (value.charCodeAt(0) === 43 ? "+" : "") + digits;
}

/** Trims HTML whitespace and NBSP only (not Unicode format characters, which stay visible to the warning). */
function trimBlank(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isBlank(s.charCodeAt(a))) a++;
  while (b > a && isBlank(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

function hasWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (isBlank(s.charCodeAt(i))) return true;
  return false;
}

/** True when the visible text already is the target (plan 6.4 step 9). Exact comparisons only. */
function visibleEqualsTarget(protocol: string, target: string, visible: string): boolean {
  const v = trimBlank(visible);
  if (v === "" || v.length > MAX_LINK_TARGET) return false;
  if (protocol === "tel:") {
    // Owner Round 3, D2 (tel only): the link text's ASCII digits equal the rebuilt target's digits,
    // so "+1 (555) 123-4567" over tel:+15551234567 isn't repeated. Text with no digits never matches.
    return asciiDigits(v) === asciiDigits(target);
  }
  if (hasWhitespace(v)) return false;
  if (protocol === "http:" || protocol === "https:") {
    if (parseUrl(v)?.href === target) return true;
    if (v.indexOf(":") >= 0) return false;
    return parseUrl(`https://${v}`)?.href === target || parseUrl(`http://${v}`)?.href === target;
  }
  if (protocol === "mailto:") {
    const lv = asciiLower(v);
    const lt = asciiLower(target);
    return lv === lt || `mailto:${lv}` === lt;
  }
  return false;
}

/** "?", "#" or "%" in a decoded mailto address (each would start or encode a query or fragment). */
function hasMailtoUnsafe(addr: string): boolean {
  for (let i = 0; i < addr.length; i++) {
    const c = addr.charCodeAt(i);
    if (c === 63 /* ? */ || c === 35 /* # */ || c === 37 /* % */) return true;
  }
  return false;
}

/** The ASCII digits of `s`, in order. */
function asciiDigits(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) if (isDigit(s.charCodeAt(i))) out.push(s[i]!);
  return out.join("");
}

/**
 * The target written after a link's visible text, or null (no target written). Only http, https,
 * mailto and tel; credentials refused; mailto and tel rebuilt from validated parts; the result is
 * printable ASCII with no spaces, "<" or ">". Null also when the visible text already is the target.
 */
export function linkTarget(rawHref: string | null, visibleText: string): string | null {
  if (rawHref === null || rawHref.length > MAX_LINK_TARGET) return null;
  let value = decodeEntities(rawHref).replace(/[\t\n\r]/g, "");
  let a = 0;
  let b = value.length;
  while (a < b && isC0OrSpace(value.charCodeAt(a))) a++;
  while (b > a && isC0OrSpace(value.charCodeAt(b - 1))) b--;
  value = value.slice(a, b);
  for (let i = 0; i < value.length; i++) if (isControl(value.charCodeAt(i))) return null;
  const url = parseUrl(value);
  if (!url) return null;
  let target: string;
  switch (url.protocol) {
    case "http:":
    case "https:":
      if (url.username !== "" || url.password !== "") return null;
      target = url.href;
      break;
    case "mailto:": {
      // The query and fragment (?subject=, body=, cc=) are dropped: WHATWG leaves "<", ">" and spaces
      // in them, and pre-filled bodies or extra recipients are hidden behaviour.
      // Tester D-1: "?", "#" and "%" are valid atext, so a percent-encoded "?" or "#" in the path
      // (mailto:a%3Fcc=…) would decode into a live query or fragment in the rebuilt target, and a "%"
      // left after decoding (double encoding) would let one appear later. Such a link keeps its
      // text only. Nothing is re-encoded.
      const addr = percentDecode(url.pathname);
      if (addr === null || !isValidAddress(addr) || hasMailtoUnsafe(addr)) return null;
      target = `mailto:${addr}`;
      break;
    }
    case "tel:": {
      const decoded = percentDecode(url.pathname);
      const d = decoded === null ? null : telDigits(decoded);
      if (d === null) return null;
      target = `tel:${d}`;
      break;
    }
    default:
      return null; // javascript:, data:, vbscript:, file:, blob:, ftp:, sms: and every other scheme
  }
  if (!passesFinalGate(target)) return null;
  if (visibleEqualsTarget(url.protocol, target, visibleText)) return null;
  return target;
}

// ---- The scan (plan 6.3) ---------------------------------------------------------------------------

/**
 * `lineStart`: nothing but ASCII spaces has been written since the last line break (or the start).
 * Owner Round 3, D1: a block element adds a line break only when this is false, so one `<div>` per
 * line (Gmail's editor) keeps single spacing; `<br>` always adds one, so `<div><br></div>` is still
 * a blank line, and an empty `<div></div>` adds nothing, as Gmail shows them.
 */
type ScanState = { out: string[]; anchor: { href: string | null; start: number } | null; expanded: number; lineStart: boolean };

/** True if `s` has a character other than an ASCII space. */
function hasContent(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) !== 32) return true;
  return false;
}

function pushBreak(st: ScanState): void {
  st.out.push("\n");
  st.lineStart = true;
}

/** Pushes a text run: entities decoded, runs of HTML whitespace collapsed to one space. */
function pushText(st: ScanState, raw: string): void {
  if (raw === "") return;
  const t = decodeEntities(raw).replace(/[ \t\n\f\r]+/g, " ");
  st.out.push(t);
  if (hasContent(t)) st.lineStart = false;
}

/** Closes the open anchor, writing its target after the visible text (plan 6.3 step 4). */
function closeAnchor(st: ScanState): void {
  const anchor = st.anchor;
  st.anchor = null;
  if (!anchor || anchor.href === null || st.expanded >= MAX_SIGNATURE_LINKS) return;
  const visible = st.out.slice(anchor.start).join("");
  const target = linkTarget(anchor.href, visible);
  if (target === null) return;
  st.expanded++;
  let last = visible.length - 1;
  while (last >= 0 && isBlank(visible.charCodeAt(last))) last--;
  st.out.length = anchor.start;
  if (last < 0) {
    // An image-only link (owner Q-B a): the bare target. The spaces collapse or trim away in clean-up.
    st.out.push(visible, ` <${target}> `);
    st.lineStart = false;
  } else {
    // Only blanks follow the insertion point, so `lineStart` is unchanged.
    st.out.push(visible.slice(0, last + 1), ` <${target}>`, visible.slice(last + 1));
  }
}

/** Clean-up of the whole output (plan 6.3 step 5). Bidi and invisible characters are kept. */
function cleanUp(text: string): string {
  const s = stripAllControls(text.split(NBSP).join(" ")).replace(/\t/g, " ");
  // Runs are collapsed before the trims, so no regex here backtracks over a long run.
  const lines = s.split("\n").map((line) => trimSpaces(line.replace(/ {2,}/g, " ")));
  const joined = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  let a = 0;
  let b = joined.length;
  while (a < b && joined.charCodeAt(a) === 10) a++;
  while (b > a && joined.charCodeAt(b - 1) === 10) b--;
  return joined.slice(a, b);
}

/** Trims ASCII spaces only (tabs are spaces by then; other characters are kept). */
function trimSpaces(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 32) a++;
  while (b > a && s.charCodeAt(b - 1) === 32) b--;
  return s.slice(a, b);
}

/** Converts a Gmail signature (HTML) to the plain text Alex sends. */
export function signatureToText(html: string): SignatureConversion {
  if (html.length > MAX_SIGNATURE_HTML) return { state: "too_large" };
  const input = wellFormed(html).replace(/\r\n?/g, "\n");
  const lower = asciiLower(input);
  const n = input.length;
  const st: ScanState = { out: [], anchor: null, expanded: 0, lineStart: true };
  let i = 0;
  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt < 0) {
      pushText(st, input.slice(i));
      break;
    }
    if (lt > i) pushText(st, input.slice(i, lt));
    const tag = readTag(input, lower, lt);
    if (tag.kind === "eof") break;
    if (tag.kind === "text") {
      st.out.push("<");
      st.lineStart = false;
      i = lt + 1;
      continue;
    }
    i = tag.next;
    if (tag.kind === "skip") continue;
    if (!tag.closing && RAW_TEXT_ELEMENTS.has(tag.name)) {
      const next = skipRawText(input, lower, tag.name, i);
      if (next < 0) break;
      i = next;
      continue;
    }
    if (tag.name === "a") {
      if (tag.closing) {
        if (st.anchor) closeAnchor(st);
      } else {
        if (st.anchor) closeAnchor(st);
        st.anchor = { href: tag.href, start: st.out.length };
      }
      continue;
    }
    if (tag.name === "br") pushBreak(st);
    else if (LINE_BREAK_ELEMENTS.has(tag.name)) {
      if (!st.lineStart) pushBreak(st);
    }
    else if (tag.closing && CELL_ELEMENTS.has(tag.name)) st.out.push(" ");
  }
  if (st.anchor) closeAnchor(st);
  const text = cleanUp(st.out.join(""));
  if (text === "") return { state: "none" };
  if (text.length > MAX_SIGNATURE_TEXT) return { state: "too_large" };
  return { state: "set", text };
}
