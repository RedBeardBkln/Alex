import {
  isTokenAtKeyword,
  isTokenBadString,
  isTokenBadURL,
  isTokenCDC,
  isTokenCDO,
  isTokenCloseCurly,
  isTokenCloseParen,
  isTokenCloseSquare,
  isTokenColon,
  isTokenComma,
  isTokenComment,
  isTokenDelim,
  isTokenDimension,
  isTokenFunction,
  isTokenHash,
  isTokenIdent,
  isTokenNumber,
  isTokenOpenCurly,
  isTokenOpenParen,
  isTokenOpenSquare,
  isTokenPercentage,
  isTokenSemicolon,
  isTokenString,
  isTokenURL,
  tokenize,
  type CSSToken,
} from "@csstools/css-tokenizer";
import {
  isFunctionNode,
  isSimpleBlockNode,
  isTokenNode,
  isWhiteSpaceOrCommentNode,
  parseListOfComponentValues,
  type ComponentValue,
  type FunctionNode,
  type SimpleBlockNode,
} from "@csstools/css-parser-algorithms";

/**
 * Email CSS (plan Revision 3, §8.3–8.7): parse with a CSS Syntax Level 3 tokenizer/parser
 * (@csstools), map component values onto a small allowlist model, and serialize that model
 * with our own code from decoded values. Nothing from the original text is passed through.
 * Output is identical in both rendering modes: CSS can never load anything (no url() in any
 * form, no at-rule but @media).
 */

/** Most UTF-16 code units processed per style block or style attribute; longer CSS is dropped. */
export const MAX_CSS_CHARS = 128 * 1024;
/** Total CSS budget for one message across all style blocks and attributes. */
export const MAX_CSS_PER_MESSAGE = 128 * 1024;
/** Tokenizer parse errors tolerated per block or attribute before the CSS is dropped. */
export const MAX_CSS_PARSE_ERRORS = 100;
/** Deepest bracket nesting accepted (the parser itself throws at 512). */
export const MAX_CSS_NESTING = 32;
const MAX_COMPOUNDS_PER_RULE = 32;
const MAX_SELECTOR_CHARS = 1024;
const MAX_MEDIA_PRELUDE_CHARS = 256;

/** Per-message CSS budget (MAX_CSS_PER_MESSAGE). */
export class CssBudget {
  remaining: number;
  constructor(remaining = MAX_CSS_PER_MESSAGE) {
    this.remaining = remaining;
  }
  take(n: number): boolean {
    if (n > this.remaining) {
      this.remaining = 0;
      return false;
    }
    this.remaining -= n;
    return true;
  }
}

// ---- Allowlists (§8.5) ---------------------------------------------------------------------

const sides = ["top", "right", "bottom", "left"];
const PROPERTIES = new Set<string>([
  // colour, background
  "color", "background-color", "background", "opacity",
  // font, text
  "font", "font-family", "font-size", "font-style", "font-weight", "font-variant", "line-height", "letter-spacing",
  "word-spacing", "text-align", "text-decoration", "text-decoration-line", "text-decoration-style",
  "text-decoration-color", "text-indent", "text-transform", "text-shadow", "text-overflow", "white-space",
  "word-break", "word-wrap", "overflow-wrap", "hyphens", "vertical-align", "direction",
  // box
  "margin", ...sides.map((s) => `margin-${s}`),
  "padding", ...sides.map((s) => `padding-${s}`),
  "border", ...sides.map((s) => `border-${s}`),
  "border-width", "border-style", "border-color",
  ...sides.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  "border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius",
  "border-bottom-left-radius", "box-shadow", "box-sizing", "outline", "outline-width", "outline-style", "outline-color",
  // sizing
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  // layout
  "display", "float", "clear", "overflow", "overflow-x", "overflow-y", "visibility", "position",
  "top", "right", "bottom", "left", "z-index",
  // tables, lists
  "table-layout", "border-collapse", "border-spacing", "caption-side", "empty-cells", "list-style", "list-style-type",
  "list-style-position",
]);

const POSITION_VALUES = new Set(["static", "relative", "absolute"]);
const STRING_PROPERTIES = new Set(["font-family", "font"]);
const SLASH_PROPERTIES = new Set(["font", "border-radius"]);
const UNITS = new Set(["px", "em", "rem", "ex", "ch", "pt", "pc", "cm", "mm", "in", "vw", "vh", "vmin", "vmax"]);
const COLOUR_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla"]);
const PSEUDO_CLASSES = new Set([
  "hover", "active", "focus", "visited", "link", "first-child", "last-child", "only-child", "first-of-type",
  "last-of-type", "empty", "root",
]);
const ATTRIBUTE_OPERATOR_PREFIXES = new Set(["~", "|", "^", "$", "*"]);

/** CSS named colours plus transparent/currentcolor, for salvaging a colour from a mixed `background` (Q-R3-4). */
const NAMED_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
    "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
    "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
    "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue " +
    "lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
    "mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange " +
    "orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna " +
    "silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet " +
    "wheat white whitesmoke yellow yellowgreen transparent currentcolor"
  ).split(" "),
);

const IDENT_RE = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
const HEX_COLOUR_RE = /^(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const SAFE_STRING_RE = /^[A-Za-z0-9 _.-]{1,64}$/;

/** ASCII-only lowercasing (length-preserving; non-ASCII stays and then fails the ident pattern). */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

const isSafeIdent = (v: string) => IDENT_RE.test(v) && !v.startsWith("--");

/** Canonical decimal: at most 4 fraction digits, no exponent; null outside ±1e6 or non-finite. */
function formatNumber(v: number): string | null {
  if (!Number.isFinite(v) || Math.abs(v) > 1e6) return null;
  const rounded = Math.round(v * 10_000) / 10_000;
  if (Object.is(rounded, -0) || rounded === 0) return "0";
  const s = String(rounded);
  return /e/i.test(s) ? null : s;
}

// ---- Parsing (§8.3) ------------------------------------------------------------------------

class TooManyErrors extends Error {}

/** Tokenize and parse into component values, or null if the CSS must be dropped. */
function parseComponents(text: string): ComponentValue[] | null {
  if (text.length > MAX_CSS_CHARS) return null;
  let errors = 0;
  let tokens: CSSToken[];
  try {
    tokens = tokenize(
      { css: text },
      {
        onParseError: () => {
          errors += 1;
          if (errors > MAX_CSS_PARSE_ERRORS) throw new TooManyErrors();
        },
      },
    );
  } catch {
    return null;
  }
  // Nesting pre-check on the flat token list (keeps the parser well away from its 512 limit).
  let depth = 0;
  for (const t of tokens) {
    if (isTokenOpenCurly(t) || isTokenOpenParen(t) || isTokenOpenSquare(t) || isTokenFunction(t)) {
      depth += 1;
      if (depth > MAX_CSS_NESTING) return null;
    } else if ((isTokenCloseCurly(t) || isTokenCloseParen(t) || isTokenCloseSquare(t)) && depth > 0) {
      depth -= 1;
    }
  }
  try {
    return parseListOfComponentValues(tokens);
  } catch {
    return null; // includes the library's own nesting-depth error
  }
}

const isBlock = (n: ComponentValue, open: (t: CSSToken) => boolean): n is SimpleBlockNode =>
  isSimpleBlockNode(n) && open(n.startToken);
const isCurly = (n: ComponentValue): n is SimpleBlockNode => isBlock(n, isTokenOpenCurly);
const tokenOf = (n: ComponentValue | undefined): CSSToken | null => (n && isTokenNode(n) ? n.value : null);

// ---- Values (§8.5.2) -----------------------------------------------------------------------

type ValueCtx = { property: string; inColourFunction: boolean };

/** Serializes one value component, or null if it isn't allowed (which drops the declaration). */
function valueComponent(n: ComponentValue, ctx: ValueCtx): string | null {
  if (isFunctionNode(n)) return ctx.inColourFunction ? null : colourFunction(n, ctx);
  if (!isTokenNode(n)) return null; // blocks
  const t = n.value;
  if (isTokenIdent(t)) {
    const v = t[4].value;
    if (ctx.inColourFunction || !isSafeIdent(v)) return null;
    return v;
  }
  if (isTokenNumber(t)) return formatNumber(t[4].value);
  if (isTokenPercentage(t)) {
    const v = formatNumber(t[4].value);
    return v === null ? null : `${v}%`;
  }
  if (isTokenDimension(t)) {
    const unit = asciiLower(t[4].unit);
    const ok = UNITS.has(unit) && !ctx.inColourFunction ? true : unit === "deg" && ctx.inColourFunction;
    if (!ok) return null;
    const v = formatNumber(t[4].value);
    return v === null ? null : `${v}${unit}`;
  }
  if (isTokenHash(t)) {
    if (ctx.inColourFunction) return null;
    return HEX_COLOUR_RE.test(t[4].value) ? `#${t[4].value}` : null;
  }
  if (isTokenString(t)) {
    if (ctx.inColourFunction || !STRING_PROPERTIES.has(ctx.property)) return null;
    return SAFE_STRING_RE.test(t[4].value) ? `'${t[4].value}'` : null;
  }
  if (isTokenComma(t)) return ",";
  if (isTokenDelim(t) && t[4].value === "/") {
    return ctx.inColourFunction || SLASH_PROPERTIES.has(ctx.property) ? "/" : null;
  }
  return null;
}

function colourFunction(n: FunctionNode, ctx: ValueCtx): string | null {
  const name = asciiLower(n.getName());
  if (!COLOUR_FUNCTIONS.has(name)) return null;
  const inner: ValueCtx = { property: ctx.property, inColourFunction: true };
  const parts: string[] = [];
  for (const c of n.value) {
    if (isWhiteSpaceOrCommentNode(c)) continue;
    const t = tokenOf(c);
    // deg is only allowed in hsl()/hsla().
    if (t && isTokenDimension(t) && name !== "hsl" && name !== "hsla") return null;
    const s = valueComponent(c, inner);
    if (s === null) return null;
    parts.push(s);
  }
  return `${name}(${joinParts(parts)})`;
}

/** Joins serialized components with single spaces; commas attach to the preceding component. */
function joinParts(parts: string[]): string {
  // Linear: state is tracked in a variable and the output is joined once. (Calling endsWith on a
  // string grown with += forced V8 to flatten it on every iteration, which was quadratic: V1.)
  const out: string[] = [];
  let atStart = true;
  let lastWasComma = false;
  for (const p of parts) {
    if (p === ",") {
      out.push(",");
      lastWasComma = true;
    } else {
      out.push(atStart || lastWasComma ? p : ` ${p}`);
      lastWasComma = false;
    }
    atStart = false;
  }
  return out.join("");
}

const isColourComponent = (n: ComponentValue): boolean => {
  if (isFunctionNode(n)) return COLOUR_FUNCTIONS.has(asciiLower(n.getName()));
  const t = tokenOf(n);
  if (!t) return false;
  if (isTokenHash(t)) return HEX_COLOUR_RE.test(t[4].value);
  if (isTokenIdent(t)) return NAMED_COLOURS.has(asciiLower(t[4].value));
  return false;
};

type Declaration = { name: string; value: string; important: boolean };

/** Validates one declaration's value components (whitespace and comments already allowed as separators). */
function declarationValue(property: string, components: ComponentValue[]): string | null {
  const parts: string[] = [];
  const ctx: ValueCtx = { property, inColourFunction: false };
  for (const c of components) {
    if (isWhiteSpaceOrCommentNode(c)) continue;
    const s = valueComponent(c, ctx);
    if (s === null) return null;
    parts.push(s);
  }
  if (parts.length === 0) return null;
  if (property === "position" && !(parts.length === 1 && POSITION_VALUES.has(asciiLower(parts[0]!)))) return null;
  return joinParts(parts);
}

/** Parses a declaration list (a rule block or a style attribute) into allowlisted declarations. */
function declarations(components: ComponentValue[]): Declaration[] {
  const out: Declaration[] = [];
  let piece: ComponentValue[] = [];
  const flush = () => {
    const d = declaration(piece);
    if (d) out.push(...d);
    piece = [];
  };
  for (const c of components) {
    const t = tokenOf(c);
    if (t && isTokenSemicolon(t)) flush();
    else piece.push(c);
  }
  flush();
  return out;
}

function declaration(piece: ComponentValue[]): Declaration[] | null {
  let i = 0;
  while (i < piece.length && isWhiteSpaceOrCommentNode(piece[i])) i++;
  const nameTok = tokenOf(piece[i]);
  if (!nameTok || !isTokenIdent(nameTok)) return null;
  const name = asciiLower(nameTok[4].value);
  i++;
  while (i < piece.length && isWhiteSpaceOrCommentNode(piece[i])) i++;
  const colon = tokenOf(piece[i]);
  if (!colon || !isTokenColon(colon)) return null;
  let value = piece.slice(i + 1);
  if (value.some(isCurly)) return null; // nested rules
  // Trailing "!important".
  let important = false;
  let end = value.length;
  while (end > 0 && isWhiteSpaceOrCommentNode(value[end - 1])) end--;
  const last = tokenOf(value[end - 1]);
  if (last && isTokenIdent(last) && asciiLower(last[4].value) === "important") {
    let k = end - 2;
    while (k >= 0 && isWhiteSpaceOrCommentNode(value[k])) k--;
    const bang = tokenOf(value[k]);
    if (bang && isTokenDelim(bang) && bang[4].value === "!") {
      important = true;
      value = value.slice(0, k);
    }
  }
  if (!PROPERTIES.has(name)) return null;
  const v = declarationValue(name, value);
  if (v !== null) return [{ name, value: v, important }];
  // Q-R3-4: a background shorthand that mixes a colour with something disallowed keeps only the colour.
  if (name === "background") {
    const colours = value.filter((c) => !isWhiteSpaceOrCommentNode(c) && isColourComponent(c));
    const colour = colours.length > 0 ? declarationValue("background-color", [colours[colours.length - 1]!]) : null;
    if (colour !== null) return [{ name: "background-color", value: colour, important }];
  }
  return null;
}

// ---- Selectors (§8.5.4) --------------------------------------------------------------------

/** Validates and serializes a selector list, or returns null (which drops the rule). */
function selectorList(prelude: ComponentValue[]): string | null {
  const out: string[] = [];
  let outLen = 0;
  const emit = (piece: string) => {
    out.push(piece);
    outLen += piece.length;
  };
  let compounds = 0;
  let inCompound = false; // currently inside a compound selector
  let pendingSpace = false; // whitespace seen since the last compound
  let needCompound = true; // after start, a comma or a combinator

  const startCompound = () => {
    if (!inCompound) {
      if (!needCompound && pendingSpace) emit(" "); // descendant combinator
      inCompound = true;
      needCompound = false;
      compounds += 1;
    }
    pendingSpace = false;
  };

  for (let i = 0; i < prelude.length; i++) {
    const n = prelude[i]!;
    if (isWhiteSpaceOrCommentNode(n)) {
      if (inCompound) {
        inCompound = false;
        pendingSpace = true;
      }
      continue;
    }
    if (isBlock(n, isTokenOpenSquare)) {
      const attr = attributeSelector(n);
      if (attr === null) return null;
      startCompound();
      emit(attr);
      continue;
    }
    const t = tokenOf(n);
    if (!t) return null; // functions (:not( etc.), other blocks
    if (isTokenIdent(t) || (isTokenDelim(t) && t[4].value === "*")) {
      if (inCompound) return null; // a type selector must start its compound
      const v = isTokenIdent(t) ? t[4].value : "*";
      if (v !== "*" && !isSafeIdent(v)) return null;
      startCompound();
      emit(v);
      continue;
    }
    if (isTokenDelim(t) && t[4].value === ".") {
      const next = tokenOf(prelude[i + 1]);
      if (!next || !isTokenIdent(next) || !isSafeIdent(next[4].value)) return null;
      startCompound();
      emit(`.${next[4].value}`);
      i++;
      continue;
    }
    if (isTokenHash(t)) {
      if (!isSafeIdent(t[4].value)) return null;
      startCompound();
      emit(`#${t[4].value}`);
      continue;
    }
    if (isTokenColon(t)) {
      const next = tokenOf(prelude[i + 1]);
      if (!next || !isTokenIdent(next)) return null; // "::", ":not(" etc.
      const pseudo = asciiLower(next[4].value);
      if (!PSEUDO_CLASSES.has(pseudo)) return null;
      startCompound();
      emit(`:${pseudo}`);
      i++;
      continue;
    }
    if (isTokenDelim(t) && (t[4].value === ">" || t[4].value === "+" || t[4].value === "~")) {
      if (needCompound) return null;
      emit(` ${t[4].value} `);
      inCompound = false;
      pendingSpace = false;
      needCompound = true;
      continue;
    }
    if (isTokenComma(t)) {
      if (needCompound) return null;
      emit(",");
      inCompound = false;
      pendingSpace = false;
      needCompound = true;
      continue;
    }
    return null;
  }
  if (needCompound || out.length === 0) return null;
  if (compounds > MAX_COMPOUNDS_PER_RULE || outLen > MAX_SELECTOR_CHARS) return null;
  return out.join("");
}

function attributeSelector(block: SimpleBlockNode): string | null {
  const parts = block.value.filter((c) => !isWhiteSpaceOrCommentNode(c));
  const name = tokenOf(parts[0]);
  if (!name || !isTokenIdent(name) || !isSafeIdent(name[4].value)) return null;
  if (parts.length === 1) return `[${name[4].value}]`;
  let k = 1;
  let op = "";
  const first = tokenOf(parts[k]);
  if (first && isTokenDelim(first) && first[4].value === "=") {
    op = "=";
    k += 1;
  } else if (first && isTokenDelim(first) && ATTRIBUTE_OPERATOR_PREFIXES.has(first[4].value)) {
    const eq = tokenOf(parts[k + 1]);
    if (!eq || !isTokenDelim(eq) || eq[4].value !== "=") return null;
    op = `${first[4].value}=`;
    k += 2;
  } else {
    return null;
  }
  const val = tokenOf(parts[k]);
  if (!val || parts.length !== k + 1) return null;
  let v: string;
  if (isTokenIdent(val) && isSafeIdent(val[4].value)) v = val[4].value;
  else if (isTokenString(val) && SAFE_STRING_RE.test(val[4].value)) v = `'${val[4].value}'`;
  else return null;
  return `[${name[4].value}${op}${v}]`;
}

// ---- Rules and @media (§8.5.5) -------------------------------------------------------------

function mediaPrelude(prelude: ComponentValue[]): string | null {
  const parts: string[] = [];
  for (const n of prelude) {
    if (isWhiteSpaceOrCommentNode(n)) continue;
    if (isBlock(n, isTokenOpenParen)) {
      const inner = n.value.filter((c) => !isWhiteSpaceOrCommentNode(c));
      const feature = tokenOf(inner[0]);
      const colon = tokenOf(inner[1]);
      if (!feature || !isTokenIdent(feature) || !isSafeIdent(feature[4].value) || !colon || !isTokenColon(colon)) return null;
      const rest = inner.slice(2);
      let value: string | null = null;
      const a = tokenOf(rest[0]);
      if (rest.length === 1 && a) {
        if (isTokenNumber(a)) value = formatNumber(a[4].value);
        else if (isTokenDimension(a) && UNITS.has(asciiLower(a[4].unit))) {
          const v = formatNumber(a[4].value);
          value = v === null ? null : `${v}${asciiLower(a[4].unit)}`;
        } else if (isTokenIdent(a) && isSafeIdent(a[4].value)) value = a[4].value;
      } else if (rest.length === 3) {
        const slash = tokenOf(rest[1]);
        const b = tokenOf(rest[2]);
        if (a && b && slash && isTokenNumber(a) && isTokenNumber(b) && isTokenDelim(slash) && slash[4].value === "/") {
          const x = formatNumber(a[4].value);
          const y = formatNumber(b[4].value);
          value = x !== null && y !== null ? `${x}/${y}` : null;
        }
      }
      if (value === null) return null;
      parts.push(`(${asciiLower(feature[4].value)}:${value})`);
      continue;
    }
    const t = tokenOf(n);
    if (t && isTokenIdent(t) && isSafeIdent(t[4].value)) parts.push(asciiLower(t[4].value));
    else if (t && isTokenComma(t)) parts.push(",");
    else return null;
  }
  const q = joinParts(parts);
  if (q.length > MAX_MEDIA_PRELUDE_CHARS) return null;
  return q === "" ? "all" : q;
}

/** Serializes the qualified rules (and, at top level, @media blocks) of a component list. */
function rules(components: ComponentValue[], topLevel: boolean): string {
  const out: string[] = [];
  let i = 0;
  while (i < components.length) {
    const n = components[i]!;
    const t = tokenOf(n);
    if (isWhiteSpaceOrCommentNode(n) || (t && (isTokenCDO(t) || isTokenCDC(t) || isTokenSemicolon(t)))) {
      i++;
      continue;
    }
    if (t && isTokenAtKeyword(t)) {
      // Prelude up to a top-level ";" (statement at-rule) or a {} block.
      let j = i + 1;
      const prelude: ComponentValue[] = [];
      let block: SimpleBlockNode | null = null;
      for (; j < components.length; j++) {
        const c = components[j]!;
        const ct = tokenOf(c);
        if (ct && isTokenSemicolon(ct)) break;
        if (isCurly(c)) {
          block = c;
          break;
        }
        prelude.push(c);
      }
      i = j + 1;
      if (topLevel && block && asciiLower(t[4].value) === "media") {
        const q = mediaPrelude(prelude);
        const body = q === null ? "" : rules(block.value, false);
        if (q !== null && body !== "") out.push(`@media ${q}{${body}}`);
      }
      continue;
    }
    // Qualified rule: prelude up to the next {} block.
    let j = i;
    const prelude: ComponentValue[] = [];
    let block: SimpleBlockNode | null = null;
    for (; j < components.length; j++) {
      const c = components[j]!;
      if (isCurly(c)) {
        block = c;
        break;
      }
      prelude.push(c);
    }
    i = j + 1;
    if (!block) break; // EOF before a block: drop
    const sel = selectorList(prelude);
    if (sel === null) continue;
    const decls = declarations(block.value);
    if (decls.length > 0) out.push(`${sel}{${serializeDeclarations(decls)}}`);
  }
  return out.join("");
}

const serializeDeclarations = (decls: Declaration[]) =>
  decls.map((d) => `${d.name}:${d.value}${d.important ? " !important" : ""}`).join(";");

// ---- Output invariants (§8.6) --------------------------------------------------------------

const OUTPUT_CHARSET_RE = /^[A-Za-z0-9 _#.,:;%!()[\]{}'=~^$*|+>/@-]*$/;
const OUTPUT_DELIMS = new Set([".", "*", ">", "+", "~", "/", "!", "=", "|", "^", "$", "#"]);

/**
 * Production check on every output: restricted character set, `@` only as `@media `, and a
 * re-tokenization that contains no url/bad-url/bad-string/comment/CDO/CDC, no functions but
 * colour functions, no at-keyword but media, and only expected delims.
 */
export function cssOutputIsSafe(css: string): boolean {
  if (!OUTPUT_CHARSET_RE.test(css)) return false;
  for (let at = css.indexOf("@"); at >= 0; at = css.indexOf("@", at + 1)) {
    if (css.slice(at, at + 7) !== "@media ") return false;
  }
  let bad = false;
  const tokens = tokenize({ css }, { onParseError: () => (bad = true) });
  if (bad) return false;
  for (const t of tokens) {
    if (isTokenURL(t) || isTokenBadURL(t) || isTokenBadString(t) || isTokenComment(t) || isTokenCDO(t) || isTokenCDC(t)) return false;
    if (isTokenFunction(t) && !COLOUR_FUNCTIONS.has(t[4].value)) return false;
    if (isTokenAtKeyword(t) && t[4].value !== "media") return false;
    if (isTokenDelim(t) && !OUTPUT_DELIMS.has(t[4].value)) return false;
  }
  return true;
}

function finish(css: string): string {
  return css === "" || cssOutputIsSafe(css) ? css : "";
}

// ---- Entry points (§8.4) -------------------------------------------------------------------

/** Sanitizes the text of a `<style>` element. Returns "" when the CSS must be dropped. */
export function sanitizeStylesheet(text: string, budget?: CssBudget): string {
  return stylesheetWith(text, budget, (css) => css);
}

function stylesheetWith(text: string, budget: CssBudget | undefined, serialize: (css: string) => string): string {
  if (text.length > MAX_CSS_CHARS || (budget && !budget.take(text.length))) return "";
  const components = parseComponents(text);
  if (!components) return "";
  return finish(serialize(rules(components, true)));
}

/**
 * Test hook (AC 18e): runs the stylesheet path with `tamper` applied to the serialized CSS
 * before the production invariant check, to show a bad serializer output is dropped.
 */
export function sanitizeStylesheetWithTamperedSerializer(text: string, tamper: (css: string) => string): string {
  return stylesheetWith(text, undefined, tamper);
}

/** Sanitizes a `style` attribute value (already entity-decoded). Returns "" when it must be removed. */
export function sanitizeStyleAttribute(text: string, budget?: CssBudget): string {
  if (text.length > MAX_CSS_CHARS || (budget && !budget.take(text.length))) return "";
  const components = parseComponents(text);
  if (!components) return "";
  return finish(serializeDeclarations(declarations(components)));
}
