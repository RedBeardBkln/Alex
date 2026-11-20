/**
 * Structural post-check (plan Revision 4) and render check (follow-up G1) for sanitized email HTML.
 * Import-free, so both the render worker (via email-html.ts) and the main thread (render.ts re-checks
 * every worker reply before it is stored) can use it, without the page or the main thread loading
 * the sanitizer.
 */

/** Tags sanitized email HTML may contain (the sanitize-html allowlist in email-html.ts uses this list). */
export const EMAIL_ALLOWED_TAGS = [
  "a", "abbr", "address", "article", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite",
  "code", "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark",
  "ol", "p", "pre", "q", "s", "samp", "section", "small", "span", "strike", "strong", "style", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "var", "wbr",
];

/** ASCII-only lowercasing; never changes the string's length, so indexes stay aligned. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

const ALLOWED_TAG_SET = new Set(EMAIL_ALLOWED_TAGS);

/**
 * Structural check on the final output, independent of how it was produced:
 * - every <style> element's text contains no `<`, so it ends exactly where the sanitizer
 *   ended it
 * - outside style text, every `<` starts an allowlisted opening or closing tag (text and
 *   attribute values are entity-escaped by sanitize-html, so they contain no raw `<`).
 */
export function isStructurallySafe(html: string): boolean {
  const restParts: string[] = []; // joined once below (no growing-string accumulator)
  let pos = 0;
  const lower = asciiLower(html); // length-preserving, so indexes into html stay aligned
  for (;;) {
    const open = lower.indexOf("<style", pos);
    if (open < 0) {
      restParts.push(html.slice(pos));
      break;
    }
    const openEnd = html.indexOf(">", open);
    if (openEnd < 0) return false;
    const close = lower.indexOf("</style", openEnd);
    if (close < 0) return false;
    if (html.slice(openEnd + 1, close).includes("<")) return false;
    restParts.push(html.slice(pos, openEnd + 1));
    pos = close;
  }
  const rest = restParts.join("");
  const tag = /<(\/?)([^\s/>]*)/g;
  for (let m = tag.exec(rest); m; m = tag.exec(rest)) {
    if (!ALLOWED_TAG_SET.has(m[2]!.toLowerCase())) return false;
  }
  return true;
}

// ---- Render check (phase-2a-followups G1, owner Q1) ---------------------------------------------

/**
 * Attributes sanitized email HTML may carry: an import-free copy of the sanitize-html
 * `allowedAttributes` in email-html.ts (tests/email-postcheck.test.ts asserts they are equal).
 */
export const EMAIL_ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  "*": [
    "style", "class", "id", "dir", "lang", "title", "align", "valign", "width", "height", "bgcolor", "color",
    "border", "cellpadding", "cellspacing", "colspan", "rowspan", "nowrap", "span",
  ],
  a: ["href", "name", "target", "rel"],
  img: ["src", "srcset", "alt", "width", "height"],
  font: ["face", "size", "color"],
  table: ["summary"],
  ol: ["start", "type"],
  ul: ["type"],
  li: ["value"],
};

const COMMON_ATTRIBUTE_SET = new Set(EMAIL_ALLOWED_ATTRIBUTES["*"]);
const TAG_ATTRIBUTE_SETS = new Map(Object.entries(EMAIL_ALLOWED_ATTRIBUTES).map(([tag, names]) => [tag, new Set(names)]));
const URL_ATTRIBUTES = new Set(["href", "src", "cite"]);
const HREF_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/** The four entities sanitize-html's `escapeHtml` writes into attribute values (index.js 915-924). */
const VALUE_ENTITIES: readonly [string, string][] = [["&amp;", "&"], ["&quot;", '"'], ["&lt;", "<"], ["&gt;", ">"]];

/**
 * The attribute value a browser sees, or null if `raw` contains an `&` that doesn't start one of
 * `&amp; &quot; &lt; &gt;`. sanitize-html escapes every `&` (decodeEntities: true), so genuine output
 * never has any other reference, and rejecting them means `&colon;`, `&#92;` and the like can't hide
 * a scheme or a backslash from the checks below.
 */
function decodeValue(raw: string): string | null {
  if (!raw.includes("&")) return raw;
  const parts: string[] = [];
  let pos = 0;
  for (let amp = raw.indexOf("&"); amp >= 0; amp = raw.indexOf("&", pos)) {
    const entity = VALUE_ENTITIES.find(([e]) => raw.startsWith(e, amp));
    if (!entity) return null;
    parts.push(raw.slice(pos, amp), entity[1]);
    pos = amp + entity[0].length;
  }
  parts.push(raw.slice(pos));
  return parts.join("");
}

/**
 * The URL scheme a browser would read, lowercased, or "" for none, or "//" for a protocol-relative
 * URL. Mirrors launder's `naughtyHref` (which sanitize-html uses): characters 0x00-0x20 are removed
 * first, then `^[a-zA-Z][a-zA-Z0-9.+-]*:` is the scheme.
 */
function urlScheme(value: string): string {
  const cleaned = value.replace(/[\x00-\x20]+/g, "");
  const m = /^([a-zA-Z][a-zA-Z0-9.+-]*):/.exec(cleaned);
  if (m) return m[1]!.toLowerCase();
  return /^[/\\]{2}/.test(cleaned) ? "//" : "";
}

/** Revision 3 CSS output character set (email-css.ts `OUTPUT_CHARSET_RE`). */
const CSS_CHARSET_RE = /^[A-Za-z0-9 _#.,:;%!()[\]{}'=~^$*|+>/@-]*$/;

/**
 * CSS from a style element or style attribute: charset, `@` only as `@media `, no `url(`, `\` or
 * `expression`, and no function but the colour functions.
 */
function isCssSafe(css: string): boolean {
  if (!CSS_CHARSET_RE.test(css)) return false; // also excludes `\`, quotes other than `'`, and `<`
  for (let at = css.indexOf("@"); at >= 0; at = css.indexOf("@", at + 1)) {
    if (!css.startsWith("@media ", at)) return false;
  }
  const lower = asciiLower(css);
  if (lower.includes("url(") || lower.includes("expression")) return false;
  // Review round 2 (E1): no CSS function except the colour functions, as the worker's
  // cssOutputIsSafe requires (so image-set(), -webkit-image-set() and the like can't load anything).
  // Each `(` walks back only over the identifier just before it, so this stays linear.
  for (let open = css.indexOf("("); open >= 0; open = css.indexOf("(", open + 1)) {
    let start = open;
    while (start > 0 && isCssIdentChar(css.charCodeAt(start - 1))) start--;
    if (start < open && !CSS_FUNCTIONS.has(css.slice(start, open))) return false;
  }
  return true;
}

/** The only CSS functions the Revision 3 serializer emits (email-css.ts COLOUR_FUNCTIONS). */
const CSS_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla"]);

/** Characters of a CSS identifier in the output charset: letters, digits, `-` and `_`. */
const isCssIdentChar = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 95;

/** One attribute (name already lowercased, value decoded) on `tag`, in `variant`. */
function isAttributeSafe(tag: string, name: string, value: string, variant: "default" | "remote"): boolean {
  if (!COMMON_ATTRIBUTE_SET.has(name) && !TAG_ATTRIBUTE_SETS.get(tag)?.has(name)) return false;
  if (name === "style") return isCssSafe(value);
  // Review round 2 (E2): the sanitizer's `a` transform forces exactly these values on every link.
  if (tag === "a" && name === "target") return value === "_blank";
  if (tag === "a" && name === "rel") return value === "noopener noreferrer";
  if (name === "srcset") {
    if (variant === "default") return false;
    for (const candidate of value.split(",")) {
      const c = candidate.trim();
      if (c.length === 0) continue;
      const url = c.split(/\s+/)[0]!;
      if (urlScheme(url) !== "https") return false;
    }
    return true;
  }
  if (URL_ATTRIBUTES.has(name)) {
    const scheme = urlScheme(value);
    if (scheme === "//") return false; // sanitize-html runs with allowProtocolRelative: false
    // Review round 2 (E3): the sanitizer removes every image source that isn't data: (or https: in
    // the remote variant), so a relative or empty src is rejected. Relative href/cite stay allowed.
    if (name === "src") return scheme === "data" || (variant === "remote" && scheme === "https");
    if (scheme === "") return true; // relative
    return HREF_SCHEMES.has(scheme);
  }
  return true;
}

const isNameChar = (c: number) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;

/**
 * The render check run on the main thread on every worker reply before it is stored
 * (render.ts), in addition to the worker's own sanitizer. Import-free, linear and reject-only:
 * `false` means the message is stored as plain text (`text`/`postcheck`). Never used by pages.
 *
 * It relies on how sanitize-html serializes (escapeHtml in index.js 915-924, attributes at
 * 628-649): text and attribute values have `& < >` escaped, attribute values are double-quoted with
 * `"` escaped, and a tag is `<name attr="v" attr>` or `<name … />`. So every tag runs from `<` to
 * the next `>`. Anything else is rejected. Checks, on top of isStructurallySafe:
 * - tag and attribute names are lowercase, and every attribute is in EMAIL_ALLOWED_ATTRIBUTES
 * - attribute values use only `&amp; &quot; &lt; &gt;` references
 * - `href`/`cite`: a scheme (as launder reads it) must be http, https, mailto or tel, or the URL is
 *   relative; `src`: the scheme must be data (plus https in the remote variant), never relative or
 *   empty; never protocol-relative
 * - `<a>`: `target` only `_blank`, `rel` only `noopener noreferrer` (what the sanitizer forces)
 * - `srcset`: absent in the default variant; only https candidates in the remote variant
 * - CSS (style element text and `style` values): the Revision 3 output character set, `@` only as
 *   `@media `, no `url(`, `\` or `expression` (case-insensitive), and no function other than
 *   rgb, rgba, hsl and hsla
 */
export function isRenderSafe(html: string, variant: "default" | "remote"): boolean {
  if (!isStructurallySafe(html)) return false;
  const n = html.length;
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return true;
    const gt = html.indexOf(">", lt);
    if (gt < 0) return false;
    if (html.charCodeAt(lt + 1) === 47 /* / */) {
      for (let k = lt + 2; k < gt; k++) if (!isNameChar(html.charCodeAt(k))) return false;
      i = gt + 1;
      continue;
    }
    // Opening tag: name, then ` name` or ` name="value"` attributes, then `>` or ` />`.
    let k = lt + 1;
    while (k < gt && isNameChar(html.charCodeAt(k))) k++;
    const tag = html.slice(lt + 1, k);
    if (tag.length === 0) return false;
    while (k < gt) {
      if (html.charCodeAt(k) !== 32) return false;
      k++;
      if (k === gt - 1 && html.charCodeAt(k) === 47) {
        k++; // " />"
        break;
      }
      const nameStart = k;
      while (k < gt && isNameChar(html.charCodeAt(k))) k++;
      if (k === nameStart) return false;
      const name = html.slice(nameStart, k);
      let value = "";
      if (html.charCodeAt(k) === 61 /* = */) {
        if (html.charCodeAt(k + 1) !== 34 /* " */) return false;
        const q = html.indexOf('"', k + 2);
        if (q < 0 || q > gt) return false;
        const decoded = decodeValue(html.slice(k + 2, q));
        if (decoded === null) return false;
        value = decoded;
        k = q + 1;
      }
      if (!isAttributeSafe(tag, name, value, variant)) return false;
    }
    i = gt + 1;
    if (tag === "style") {
      // isStructurallySafe found this element's end, and its text has no `<`.
      const close = html.indexOf("</style", i);
      if (close < 0 || close >= n || !isCssSafe(html.slice(i, close))) return false;
      i = close;
    }
  }
}
