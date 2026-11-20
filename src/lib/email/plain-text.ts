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

// ---- Depth pre-scan: a linear model of htmlparser2 12.0.0's open-element stack (follow-up F1/H1) ----
//
// Transcribed from node_modules/htmlparser2/dist/Parser.js and Tokenizer.js, in HTML mode as
// sanitize-html drives it. tests/email-depth.test.ts compares these tables with the installed parser,
// and compares the computed depth with the parser's on a generated corpus. So a parser upgrade that
// changes behaviour fails a test, and the dependency guard in version.ts forces a SANITIZER_VERSION bump.

/** htmlparser2 `voidElements`. */
const HP2_VOID = new Set([
  "area", "base", "basefont", "br", "col", "command", "embed", "frame", "hr", "img", "input", "isindex", "keygen",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** htmlparser2 `specialStartSequences`: raw-text/RCDATA elements whose content isn't parsed (outside foreign content). */
const HP2_SPECIAL = new Set(["iframe", "noembed", "noframes", "plaintext", "script", "style", "title", "textarea", "xmp"]);

/** htmlparser2 `htmlIntegrationElements` (SVG-adjusted case). */
const HP2_INTEGRATION = new Set(["mi", "mo", "mn", "ms", "mtext", "annotation-xml", "foreignObject", "desc", "title"]);

/** htmlparser2 `svgTagNameAdjustments`. */
const HP2_SVG_ADJUST = new Map<string, string>([
  ["altglyph", "altGlyph"], ["altglyphdef", "altGlyphDef"], ["altglyphitem", "altGlyphItem"], ["animatecolor", "animateColor"],
  ["animatemotion", "animateMotion"], ["animatetransform", "animateTransform"], ["clippath", "clipPath"], ["feblend", "feBlend"],
  ["fecolormatrix", "feColorMatrix"], ["fecomponenttransfer", "feComponentTransfer"], ["fecomposite", "feComposite"],
  ["feconvolvematrix", "feConvolveMatrix"], ["fediffuselighting", "feDiffuseLighting"], ["fedisplacementmap", "feDisplacementMap"],
  ["fedistantlight", "feDistantLight"], ["fedropshadow", "feDropShadow"], ["feflood", "feFlood"], ["fefunca", "feFuncA"],
  ["fefuncb", "feFuncB"], ["fefuncg", "feFuncG"], ["fefuncr", "feFuncR"], ["fegaussianblur", "feGaussianBlur"], ["feimage", "feImage"],
  ["femerge", "feMerge"], ["femergenode", "feMergeNode"], ["femorphology", "feMorphology"], ["feoffset", "feOffset"],
  ["fepointlight", "fePointLight"], ["fespecularlighting", "feSpecularLighting"], ["fespotlight", "feSpotLight"], ["fetile", "feTile"],
  ["feturbulence", "feTurbulence"], ["foreignobject", "foreignObject"], ["glyphref", "glyphRef"], ["lineargradient", "linearGradient"],
  ["radialgradient", "radialGradient"], ["textpath", "textPath"],
]);

/** htmlparser2 `openImpliesClose`: opening the key pops the top of the stack while it is in the set. */
const HP2_IMPLIES_CLOSE: Map<string, Set<string>> = (() => {
  const formTags = new Set(["input", "option", "optgroup", "select", "button", "datalist", "textarea"]);
  const pTag = new Set(["p"]);
  const headingTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p"]);
  const tableSectionTags = new Set(["thead", "tbody"]);
  const ddtTags = new Set(["dd", "dt"]);
  const rtpTags = new Set(["rt", "rp"]);
  return new Map<string, Set<string>>([
    ["tr", new Set(["tr", "th", "td"])],
    ["th", new Set(["th"])],
    ["td", new Set(["thead", "th", "td"])],
    ["body", new Set(["head", "link", "script"])],
    ["a", new Set(["a"])],
    ["li", new Set(["li"])],
    ["p", pTag],
    ["h1", headingTags],
    ["h2", headingTags],
    ["h3", headingTags],
    ["h4", headingTags],
    ["h5", headingTags],
    ["h6", headingTags],
    ["select", formTags],
    ["input", formTags],
    ["output", formTags],
    ["button", formTags],
    ["datalist", formTags],
    ["textarea", formTags],
    ["option", new Set(["option"])],
    ["optgroup", new Set(["optgroup", "option"])],
    ["dd", ddtTags],
    ["dt", ddtTags],
    ...["address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "header", "hr", "main", "nav", "ol", "pre", "section", "table", "ul"].map(
      (k) => [k, pTag] as [string, Set<string>],
    ),
    ["rt", rtpTags],
    ["rp", rtpTags],
    ["tbody", tableSectionTags],
    ["tfoot", tableSectionTags],
  ]);
})();

/** For tests: the transcribed tables. */
export const HTMLPARSER2_TABLES = { HP2_VOID, HP2_SPECIAL, HP2_INTEGRATION, HP2_SVG_ADJUST, HP2_IMPLIES_CLOSE };

/** htmlparser2 Tokenizer `isWhitespace` (no \v). */
const isHp2Space = (c: number) => c === 32 || c === 10 || c === 9 || c === 12 || c === 13;
/** htmlparser2 Tokenizer `isEndOfTagSection`. */
const isEndOfTagSection = (c: number) => c === 47 || c === 62 || isHp2Space(c);

/** A forward-only finder: caches the next occurrence of `needle`, so repeated searches stay linear. */
function finder(haystack: string, needle: string) {
  let cached = -2; // -2: not searched yet; -1: none left
  return (from: number): number => {
    if (cached === -1 || cached >= from) return cached;
    cached = haystack.indexOf(needle, from);
    return cached;
  };
}

/**
 * The `>` ending an opening tag whose name ended at `k`, following htmlparser2's attribute states
 * (quoted values may contain `>`), encoded as `2 * index + 1` if the tag was self-closing (`/` then
 * `>`) and `2 * index` if not. -1: the tag runs to the end of input.
 */
function openTagEnd(html: string, k: number): number {
  const BEFORE = 0, SELF = 1, NAME = 2, AFTER_NAME = 3, BEFORE_VALUE = 4, UNQUOTED = 5;
  let state = BEFORE;
  const n = html.length;
  for (let j = k; j < n; j++) {
    const c = html.charCodeAt(j);
    switch (state) {
      case BEFORE:
        if (c === 62) return 2 * j;
        if (c === 47) state = SELF;
        else if (!isHp2Space(c)) state = NAME;
        break;
      case SELF:
        if (c === 62) return 2 * j + 1;
        if (!isHp2Space(c)) {
          state = BEFORE;
          j--; // reconsume
        }
        break;
      case NAME:
        if (c === 61 || isEndOfTagSection(c)) {
          state = AFTER_NAME;
          j--; // reconsume
        }
        break;
      case AFTER_NAME:
        if (c === 61) state = BEFORE_VALUE;
        else if (c === 47 || c === 62) {
          state = BEFORE;
          j--; // reconsume
        } else if (!isHp2Space(c)) state = NAME;
        break;
      case BEFORE_VALUE:
        if (c === 34 || c === 39) {
          const q = html.indexOf(c === 34 ? '"' : "'", j + 1);
          if (q < 0) return -1;
          j = q;
          state = BEFORE;
        } else if (!isHp2Space(c)) {
          state = UNQUOTED;
          j--; // reconsume
        }
        break;
      case UNQUOTED:
        if (isHp2Space(c) || c === 62) {
          state = BEFORE;
          j--; // reconsume
        }
        break;
    }
  }
  return -1;
}

/** End index (exclusive) of a tag name starting at `start`, or -1 if it runs to the end of input. */
function tagNameEnd(html: string, start: number): number {
  let k = start;
  while (k < html.length && !isEndOfTagSection(html.charCodeAt(k))) k++;
  return k < html.length ? k : -1;
}

/** Per distinct tag name: its most recent open stack slot (or -1) and its table lookups. */
type NameEntry = {
  name: string;
  top: number;
  isVoid: boolean;
  closes: Set<string> | null;
  /** The foreignContext value pushed when it opens (svg, math, integration point), or -1. */
  context: number;
};

// htmlparser2 foreignContext values.
const FOREIGN_NONE = 0;
const FOREIGN_SVG = 1;
const FOREIGN_MATHML = 2;

/**
 * Maximum open-element depth that htmlparser2 12.0.0 reaches on `html` (HTML mode, as sanitize-html
 * runs it), computed in linear time without running the parser. It transcribes the parser's
 * open-element stack:
 * - an opening tag first pops the top of the stack while it is in `openImpliesClose` for that tag,
 *   then pushes it unless it is void; a second `<form>` inside a form is ignored
 * - `/>` self-closes only in foreign (svg/math) content; outside it, it is ignored
 * - a closing tag pops down to the most recent open element of that name and is ignored when none
 *   is open (a stray close never lowers the depth); a stray `</p>` opens and closes a `p`
 * - names are lowercased, SVG names are case-adjusted in svg content, and `<image>` is the void
 *   `img` outside foreign content
 * - comments (`<!--` … `-->`/`--!>`, plus `<!-->` and `<!--->`), `<!…>` (including CDATA), `<?…>` and
 *   `</`+non-letter are skipped as the tokenizer skips them; a tag name runs to whitespace, `/` or
 *   `>`; quoted attribute values may contain `>`; raw-text element contents (outside foreign
 *   content) are not parsed
 *
 * Tag names are lowercased with the same `String.prototype.toLowerCase` the parser uses (including
 * long and non-ASCII names), so names compare exactly as they do in the parser. A marker that "only
 * ever counts higher" isn't safe: an element the model keeps open can be the target of a later close
 * that the parser treats as stray, and that pop would make the model count lower.
 *
 * `<![CDATA[` is a bogus comment ending at the first `>`: sanitize-html rewrites it to `<!&#91;CDATA[`
 * before parsing (sanitize-html 2.18.2 index.js, GHSA-2rjc-9xvg-45j7), and this models that input.
 *
 * The stack is used only at its end, with each slot linking to the previous open slot of the same
 * name (one entry per distinct name), so every element is pushed and popped at most once. Stops early once the depth exceeds
 * `stopAbove`, if given.
 */
export function htmlNestingDepth(html: string, stopAbove = Infinity): number {
  const n = html.length;
  let lower: string | null = null; // asciiLower(html), only computed once raw text is skipped
  const stack: NameEntry[] = [];
  const prevSame: number[] = []; // per slot: the previous slot holding the same name, or -1
  const entries = new Map<string, NameEntry>(); // one entry per distinct name, never deleted
  const foreign: number[] = [FOREIGN_NONE]; // htmlparser2 foreignContext, top at the end
  let max = 0;

  const entry = (name: string): NameEntry => {
    let e = entries.get(name);
    if (e === undefined) {
      const context = name === "svg" ? FOREIGN_SVG : name === "math" ? FOREIGN_MATHML : HP2_INTEGRATION.has(name) ? FOREIGN_NONE : -1;
      e = { name, top: -1, isVoid: HP2_VOID.has(name), closes: HP2_IMPLIES_CLOSE.get(name) ?? null, context };
      entries.set(name, e);
    }
    return e;
  };
  const inForeign = () => foreign[foreign.length - 1] !== FOREIGN_NONE;
  const isOpen = (name: string) => (entries.get(name)?.top ?? -1) >= 0;

  const push = (e: NameEntry) => {
    prevSame.push(e.top);
    e.top = stack.length;
    if (e.context >= 0) foreign.push(e.context);
    stack.push(e);
    if (stack.length > max) max = stack.length;
  };
  const pop = () => {
    const e = stack.pop()!;
    e.top = prevSame.pop()!;
    if (e.context >= 0) foreign.pop();
  };

  /** htmlparser2 `readTagName` for an already-lowercased exact name. */
  const adjust = (name: string): string => {
    if (foreign[foreign.length - 1] === FOREIGN_SVG) return HP2_SVG_ADJUST.get(name) ?? name;
    if (foreign.length > 1) {
      const adjusted = HP2_SVG_ADJUST.get(name);
      if (adjusted !== undefined && isOpen(adjusted)) return adjusted;
    }
    if (!inForeign()) return name === "image" ? "img" : name;
    return name;
  };

  /** htmlparser2 `emitOpenTag`; returns whether the element was pushed. */
  const openTag = (e: NameEntry): boolean => {
    if (e.name === "form" && e.top >= 0) return false;
    const closes = e.closes;
    if (closes !== null) while (stack.length > 0 && closes.has(stack[stack.length - 1]!.name)) pop();
    if (e.isVoid) return false;
    push(e);
    return true;
  };

  /** htmlparser2 `onclosetag`. */
  const closeTag = (e: NameEntry) => {
    if (e.isVoid) return; // </br> only emits an implicit <br>
    if (e.top >= 0) {
      const slot = e.top;
      while (stack.length > slot) pop();
    } else if (e.name === "p") {
      openTag(e);
      if (stack[stack.length - 1] === e) pop();
    }
  };

  const nextCommentEnd = finder(html, "-->");
  const nextCommentBangEnd = finder(html, "--!>");

  let i = 0;
  while (i < n && max <= stopAbove) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const c = html.charCodeAt(lt + 1);

    if (c === 33 /* ! */) {
      if (html.startsWith("!--", lt + 1)) {
        const s = lt + 4;
        if (html.charCodeAt(s) === 62) {
          i = s + 1; // <!-->
          continue;
        }
        if (html.charCodeAt(s) === 45 && html.charCodeAt(s + 1) === 62) {
          i = s + 2; // <!--->
          continue;
        }
        const a = nextCommentEnd(s);
        const b = nextCommentBangEnd(s);
        if (a < 0 && b < 0) break;
        i = b >= 0 && (a < 0 || b < a) ? b + 4 : a + 3;
        continue;
      }
      const gt = html.indexOf(">", lt + 2);
      if (gt < 0) break;
      i = gt + 1; // doctype, CDATA (see above) or bogus comment
      continue;
    }

    if (c === 63 /* ? */) {
      const gt = html.indexOf(">", lt + 2);
      if (gt < 0) break;
      i = gt + 1; // bogus comment
      continue;
    }

    if (c === 47 /* / */) {
      if (lt + 2 >= n) break;
      const c2 = html.charCodeAt(lt + 2);
      if (isAsciiLetter(c2)) {
        const end = tagNameEnd(html, lt + 2);
        if (end < 0) break;
        closeTag(entry(adjust(html.slice(lt + 2, end).toLowerCase())));
        const gt = html.indexOf(">", end);
        if (gt < 0) break;
        i = gt + 1;
        continue;
      }
      if (c2 === 62) {
        i = lt + 3; // "</>" is dropped
        continue;
      }
      const gt = html.indexOf(">", lt + 2);
      if (gt < 0) break;
      i = gt + 1; // bogus comment
      continue;
    }

    if (!isAsciiLetter(c)) {
      i = lt + 1; // text
      continue;
    }

    // Opening tag.
    const nameEnd = tagNameEnd(html, lt + 1);
    if (nameEnd < 0) break; // a name running to the end of input is never emitted
    const lowered = html.slice(lt + 1, nameEnd).toLowerCase();
    const special = !inForeign() && HP2_SPECIAL.has(lowered);
    const e = entry(adjust(lowered));
    const pushed = openTag(e);
    const tagEnd = openTagEnd(html, nameEnd);
    if (tagEnd < 0) break; // already opened: htmlparser2 emits the name when it ends
    i = (tagEnd >> 1) + 1;
    if ((tagEnd & 1) === 1 && inForeign()) {
      // htmlparser2 `closeCurrentTag`: pops the element if it is still on top.
      if (pushed && stack.length > 0 && stack[stack.length - 1] === e) pop();
      continue;
    }
    if (special) {
      if (lowered === "plaintext") break; // everything after <plaintext> is text
      // Raw text: skip to `</name` followed by whitespace, `/` or `>`, then process that close normally.
      const needle = `</${lowered}`;
      lower ??= asciiLower(html);
      let e = lower.indexOf(needle, i);
      while (e >= 0) {
        const after = e + needle.length;
        if (after >= n) {
          e = -1;
          break;
        }
        if (isEndOfTagSection(html.charCodeAt(after))) break;
        e = lower.indexOf(needle, e + 1);
      }
      if (e < 0) break;
      i = e;
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
