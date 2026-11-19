/**
 * Structural post-check for sanitized email HTML (plan Revision 4). Import-free, so both the render
 * worker (via email-html.ts) and the main thread (render.ts re-checks every worker reply before it
 * is stored) can use it, without the page or the main thread loading the sanitizer.
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
