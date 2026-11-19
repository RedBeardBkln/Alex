/**
 * Linear-time HTML helpers that never use htmlparser2 (plan Revision 4, R4.2):
 * - htmlNestingDepth: the maximum open-element depth, used to route absurdly nested mail to text
 * - htmlToPlainText: a plain-text rendering, used whenever HTML can't be shown safely
 *
 * Both are single left-to-right passes. Every search is an indexOf from the current position, and
 * the position then moves past what was found; when a search finds nothing (no closing `>`, `-->`
 * or raw-text end tag) the scan stops, so no input is examined more than a bounded number of
 * times. Output is collected in arrays and joined once. The result of htmlToPlainText is text,
 * rendered by React as text, never as HTML.
 */

/** Most input code units htmlToPlainText reads; the rest is ignored and the output marked truncated. */
export const MAX_PLAINTEXT_INPUT = 4 * 1024 * 1024;
/** Most output code units of a plain-text rendering; beyond it the output is marked truncated. */
export const MAX_RENDERED_TEXT = 256 * 1024;
const MAX_TAG_NAME = 32;

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "title", "textarea", "xmp", "noscript", "template", "noembed", "noframes", "iframe"]);
const BLOCK_ELEMENTS = new Set(["br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote"]);

/** ASCII-only lowercasing; never changes the string's length, so indexes stay aligned. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

const isAsciiLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isAsciiLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;

type Tag =
  | { kind: "skip"; next: number } // comment, <!…>, <?…>
  | { kind: "text"; next: number } // a "<" that doesn't start a tag
  | { kind: "eof" } // an unterminated tag or comment: nothing after it is examined
  | { kind: "tag"; name: string; closing: boolean; selfClosing: boolean; next: number };

/** Classifies the markup starting at `lt` (where html[lt] === "<"). Never scans backwards. */
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
  if (j >= n || !isAsciiLetter(html.charCodeAt(j))) return { kind: "text", next: lt + 1 };
  let k = j;
  while (k < n && k - j < MAX_TAG_NAME && isNameChar(html.charCodeAt(k))) k++;
  const name = lower.slice(j, k);
  const gt = html.indexOf(">", k);
  if (gt < 0) return { kind: "eof" };
  return { kind: "tag", name, closing, selfClosing: html.charCodeAt(gt - 1) === 47, next: gt + 1 };
}

/** Position just after the end tag of a raw-text element opened before `from`, or the input length. */
function skipRawText(html: string, lower: string, name: string, from: number): number {
  const end = lower.indexOf(`</${name}`, from);
  if (end < 0) return html.length;
  const gt = html.indexOf(">", end);
  return gt < 0 ? html.length : gt + 1;
}

/**
 * Maximum open-element depth: `<name` opens, `</name` closes (never below 0). Void elements,
 * self-closing tags, comments, `<!…>`/`<?…>` and raw-text element contents don't count. Stops
 * early once the depth exceeds `stopAbove`, if given.
 */
export function htmlNestingDepth(html: string, stopAbove = Infinity): number {
  const lower = asciiLower(html);
  const n = html.length;
  let depth = 0;
  let max = 0;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const tag = readTag(html, lower, lt);
    if (tag.kind === "eof") break;
    i = tag.next;
    if (tag.kind !== "tag") continue;
    if (tag.closing) {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (VOID_ELEMENTS.has(tag.name) || tag.selfClosing) continue;
    if (RAW_TEXT_ELEMENTS.has(tag.name)) {
      i = skipRawText(html, lower, tag.name, i);
      continue;
    }
    depth += 1;
    if (depth > max) {
      max = depth;
      if (max > stopAbove) return max;
    }
  }
  return max;
}

/** Collects output parts up to MAX_RENDERED_TEXT code units. */
class TextOut {
  parts: string[] = [];
  length = 0;
  full = false;
  push(s: string) {
    if (this.full || s.length === 0) return;
    const room = MAX_RENDERED_TEXT - this.length;
    if (s.length > room) {
      this.parts.push(s.slice(0, room));
      this.length = MAX_RENDERED_TEXT;
      this.full = true;
      return;
    }
    this.parts.push(s);
    this.length += s.length;
  }
}

const NAMED_ENTITIES: [string, string][] = [
  ["amp;", "&"],
  ["lt;", "<"],
  ["gt;", ">"],
  ["quot;", '"'],
  ["#39;", "'"],
  ["apos;", "'"],
  ["nbsp;", " "],
];

const isDigit = (c: number) => c >= 48 && c <= 57;
const isHexDigit = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

function codePointText(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
  return String.fromCodePoint(cp);
}

/** Decodes the supported entities in `s` into `out`. Bounded lookahead at each `&`. */
function pushDecoded(s: string, out: TextOut): void {
  let pos = 0;
  while (!out.full) {
    const amp = s.indexOf("&", pos);
    if (amp < 0) {
      out.push(s.slice(pos));
      return;
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
}

/**
 * Plain-text rendering of HTML: tags, comments and raw-text element contents are skipped, block
 * elements (br p div tr li h1–h6 table blockquote, opening and closing) become newlines, the common
 * entities and numeric references are decoded, and runs of 3+ newlines collapse to 2.
 */
export function htmlToPlainText(html: string): { text: string; truncated: boolean } {
  let truncated = false;
  let input = html;
  if (input.length > MAX_PLAINTEXT_INPUT) {
    input = input.slice(0, MAX_PLAINTEXT_INPUT);
    truncated = true;
  }
  const lower = asciiLower(input);
  const n = input.length;
  const out = new TextOut();
  let i = 0;
  while (i < n && !out.full) {
    const lt = input.indexOf("<", i);
    if (lt < 0) {
      pushDecoded(input.slice(i), out);
      break;
    }
    if (lt > i) pushDecoded(input.slice(i, lt), out);
    const tag = readTag(input, lower, lt);
    if (tag.kind === "eof") break;
    if (tag.kind === "text") {
      out.push("<");
      i = tag.next;
      continue;
    }
    i = tag.next;
    if (tag.kind !== "tag") continue;
    if (!tag.closing && !tag.selfClosing && RAW_TEXT_ELEMENTS.has(tag.name)) {
      i = skipRawText(input, lower, tag.name, i);
      continue;
    }
    if (BLOCK_ELEMENTS.has(tag.name)) out.push("\n");
  }
  if (out.full) truncated = true;
  const text = out.parts
    .join("")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, truncated };
}

/** The plain-text rendering of a message: its text body when it has one, otherwise its HTML converted. */
export function renderPlainText(html: string | null, text: string | null): { text: string; truncated: boolean } {
  if (text && text.trim() !== "") {
    return text.length > MAX_RENDERED_TEXT ? { text: text.slice(0, MAX_RENDERED_TEXT), truncated: true } : { text, truncated: false };
  }
  return html ? htmlToPlainText(html) : { text: "", truncated: false };
}
