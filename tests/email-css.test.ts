import { describe, expect, it } from "vitest";
import sanitizeHtml from "sanitize-html";
import {
  isTokenAtKeyword,
  isTokenBadString,
  isTokenBadURL,
  isTokenFunction,
  isTokenURL,
  tokenize,
} from "@csstools/css-tokenizer";
import {
  CssBudget,
  cssOutputIsSafe,
  MAX_CSS_CHARS,
  MAX_CSS_NESTING,
  MAX_CSS_PARSE_ERRORS,
  MAX_CSS_PER_MESSAGE,
  sanitizeStyleAttribute,
  sanitizeStylesheet,
  sanitizeStylesheetWithTamperedSerializer,
} from "@/lib/email-css";
import { EMAIL_IFRAME_SANDBOX, emailCsp, emailDocument, isStructurallySafe, sanitizeEmailHtml } from "@/lib/email-html";

// Plan Revision 3 (§8, AC 18a–18k): CSS is parsed with @csstools and regenerated from an allowlist.

const off = { allowRemoteImages: false };
const on = { allowRemoteImages: true };
const modes = [off, on];

const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite",
  "code", "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark",
  "ol", "p", "pre", "q", "s", "samp", "section", "small", "span", "strike", "strong", "style", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "var", "wbr",
]);

/** Every CSS string emitted in a sanitized message: style element texts and style attribute values (entity-decoded). */
function emittedCss(html: string): string[] {
  const out: string[] = [];
  sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    parseStyleAttributes: false,
    onOpenTag: (_name, attribs) => {
      if (attribs.style !== undefined) out.push(attribs.style);
    },
  });
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(m[1]!);
  return out;
}

function tagsIn(html: string): string[] {
  const seen: string[] = [];
  sanitizeHtml(html, { allowedTags: false, allowedAttributes: false, allowVulnerableTags: true, onOpenTag: (n) => seen.push(n) });
  return seen;
}

/** AC 18c: no url/bad-url token, no function but colour functions, no at-keyword but media. */
function noCssLoad(css: string): boolean {
  for (const t of tokenize({ css })) {
    if (isTokenURL(t) || isTokenBadURL(t) || isTokenBadString(t)) return false;
    if (isTokenFunction(t) && !["rgb", "rgba", "hsl", "hsla"].includes(t[4].value.toLowerCase())) return false;
    if (isTokenAtKeyword(t) && t[4].value.toLowerCase() !== "media") return false;
  }
  return true;
}

/** AC 18b + 18c + 18e on one input, in both modes. */
function assertSafe(html: string, attackerMarker = "e.example") {
  const outputs = modes.map((m) => sanitizeEmailHtml(html, m));
  for (const out of outputs) {
    expect(isStructurallySafe(out), out).toBe(true);
    for (const t of tagsIn(out)) expect(ALLOWED_TAGS.has(t), `tag ${t}`).toBe(true);
    expect(out.toLowerCase()).not.toContain("<script");
    for (const css of emittedCss(out)) {
      expect(css, "no < in style text").not.toContain("<");
      expect(css.toLowerCase()).not.toContain(attackerMarker);
      expect(noCssLoad(css), css).toBe(true);
      expect(cssOutputIsSafe(css), css).toBe(true);
    }
  }
  // AC 18g: CSS output is identical between modes.
  expect(emittedCss(outputs[0]!)).toEqual(emittedCss(outputs[1]!));
  return outputs;
}

// ---- 18b: payload replay -------------------------------------------------------------------

const S1_CLOSERS = [String.raw`</sty\le>`, "</sty\u0000le>", "</sty@import x;le>", String.raw`</STY\LE >`, "</sty/**/le>", String.raw`</s\tyle>`, "</ style>", "</STYLE >"];
const S1_PAYLOADS = [
  '<meta http-equiv="refresh" content="0;url=https:&#x2f;&#x2f;e.example/opened?id=1">',
  '<img src="http:&#x2f;&#x2f;e.example/a.gif">',
  '<link rel="stylesheet" href="https://e.example/s.css">',
  '<iframe src="https://e.example/f"></iframe>',
  '<form action="https://e.example/post"><input name="x"></form>',
  '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
  "<script>alert(1)</script>",
];
const S2_CSS = [
  "@font-face{font-family:x;src:url(https://e.example/f.woff)}",
  "@namespace url(https://e.example/ns);",
  ".a{-moz-binding:url(https://e.example/x.xml#b)}",
  ".a{cursor:url(https://e.example/c.cur),auto}",
  ".a{filter:url(https://e.example/f.svg#x)}",
  ".a{mask-image:url(https://e.example/m.png)}",
  ".a{content:url(https://e.example/k.png)}",
  ".a{behavior:url(https://e.example/x.htc)}",
  ".a{background:url(https://e.example/a.png)}",
  ".a{background-image:url('https://e.example/b.png')}",
  ".a{list-style-image:url(https://e.example/c.png)}",
  ".a{border-image:url(https://e.example/e.png) 30 round}",
  "@media screen{.a{background:url(https://e.example/g.png)}}",
  ".a{background:url(data:image/png;base64,AAAA)}",
  "@import url(https://e.example/x.css);",
  "@import 'https://e.example/y.css';",
  ".a{background:image-set('https://e.example/i.png' 1x)}",
  String.raw`.a{background:u\72l(https://e.example/esc.png)}`,
  String.raw`.a{background:\75rl(https://e.example/esc2.png)}`,
  ".a{background:u/**/rl(https://e.example/split.png)}",
  ".a{background:url(https:&#x2f;&#x2f;e.example/ent.png)}",
];
const NL = ["\n", "\r", "\f", "\r\n"];
const U1_CSS = NL.flatMap((nl) => [
  `a{background:url("data:,x${nl});background:url(https://e.example/default.png);y:")}`,
  `a{background:url('data:,x${nl});cursor:url(https://e.example/cursor.png),auto;y:')}`,
  `@font-face{font-family:f;src:url("data:,x${nl});src:url(https://e.example/f.woff);y:")}`,
  `a{font-family:"x${nl};-moz-binding:url(https://e.example/b.xml);y:"}`,
  `a[title="x${nl}"]{background:url(https://e.example/attr.png)}b{color:red}`,
  `a{background:url("https://e.example/ok.png${nl});cursor:url(https://e.example/c.png);y:")}`,
]);
const ESCAPE_CSS = [
  "a{font-family:'x\\\nbackground:url(https://e.example/escnl.png)'}",
  'a{font-family:"unterminated at EOF',
  "a{font-family:'</style><script>alert(1)</script>'}",
  "a{c\\olor:red;background:url(https://e.example/x\\0.png)}",
  "a{color:red\u0000;background:url(https://e.example/nul.png)}",
  "a{color:\uFFFD;background:url(https://e.example/fffd.png)}",
  "a{font-family:\uD800x;background:url(https://e.example/surrogate.png)}",
];
const T1_T2_CSS = [
  `a{background:url(${" ".repeat(3000)}x`,
  `a{b:${'url("'.repeat(500)}"${" ".repeat(500)}x`,
  `a{background:${"url(data:x)".repeat(2000)}}`,
];

describe("18b/18c/18d: every earlier payload is safe in both modes", () => {
  for (const closer of S1_CLOSERS) {
    for (const payload of S1_PAYLOADS) {
      it(`S1 ${JSON.stringify(closer)} + ${payload.slice(0, 30)}`, () => assertSafe(`<style>a{color:red}${closer}${payload}</style><p>after</p>`));
    }
  }
  const cssCorpus = [...S2_CSS, ...U1_CSS, ...ESCAPE_CSS, ...T1_T2_CSS];
  for (const css of cssCorpus) {
    it(`style element: ${JSON.stringify(css).slice(0, 80)}`, () => assertSafe(`<style>${css}</style><p>x</p>`));
    it(`style attribute: ${JSON.stringify(css).slice(0, 80)}`, () => {
      const decl = css.replace(/^[^{]*\{/, "").replace(/\}$/, "");
      assertSafe(`<div style="${decl.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">x</div>`);
    });
  }

  it("18d: live declarations hidden behind a bad string are absent; the following rule survives", () => {
    for (const nl of NL) {
      const out = sanitizeStylesheet(`a{background:url("data:,x${nl});background:url(https://e.example/d.png);y:")} b{color:red}`);
      expect(out).not.toMatch(/url|e\.example/);
      const font = sanitizeStylesheet(`a{font-family:"x${nl};-moz-binding:url(https://e.example/b.xml);y:"} b{color:red}`);
      expect(font).not.toMatch(/binding|url|e\.example/);
    }
  });
});

// ---- 18e: output invariants ----------------------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOUP = [
  "a", "b", ".x", "#y", "*", ">", "+", "~", ",", ":", ";", "{", "}", "(", ")", "[", "]", " ", "\n", "\r", "\f", "\t",
  "color", "background", "margin", "font-family", "position", "red", "#fff", "1px", "2em", "50%", "0", "-1",
  "url(", "url(https://evil.example/x)", "url('data:x')", '"', "'", '"str"', "'s\n", "\\", "\\72", "\\0", "/*", "*/",
  "@media", "@import", "@font-face", "@", "<", "</style>", "!", "important", "rgb(1,2,3)", "calc(1px+2px)", "var(--x)",
  "expression(", "--x", "-webkit-", "mso-", "&", "|", "^", "$", "=", "\u0000", "\uFFFD", "é", "\uD800",
];

describe("18e: invariants on a random token-soup corpus (10,000 cases, fixed seed)", () => {
  it("every output is in the safe charset, re-tokenizes cleanly, is a fixed point, and carries no marker", { timeout: 120_000 }, () => {
    const rnd = mulberry32(20261118);
    for (let n = 0; n < 10_000; n++) {
      const len = 1 + Math.floor(rnd() * 40);
      let s = "";
      for (let k = 0; k < len; k++) s += SOUP[Math.floor(rnd() * SOUP.length)]!;
      for (const out of [sanitizeStylesheet(s), sanitizeStyleAttribute(s)]) {
        expect(cssOutputIsSafe(out), `${JSON.stringify(s)} -> ${JSON.stringify(out)}`).toBe(true);
        expect(out).not.toMatch(/evil|url|<|\\|"|\n/);
      }
      const sheet = sanitizeStylesheet(s);
      expect(sanitizeStylesheet(sheet), JSON.stringify(s)).toBe(sheet);
      const attr = sanitizeStyleAttribute(s);
      expect(sanitizeStyleAttribute(attr), JSON.stringify(s)).toBe(attr);
    }
  });

  it("idempotence holds for the payload corpus and the fidelity fixtures", () => {
    for (const css of [...S2_CSS, ...U1_CSS, ...ESCAPE_CSS, ...FIXTURE_CSS]) {
      const once = sanitizeStylesheet(css);
      expect(sanitizeStylesheet(once)).toBe(once);
    }
  });

  it("a tampered serializer output is dropped, not emitted", () => {
    const tampers = [
      (c: string) => `${c}a{background:url(https://e.example/x)}`,
      (c: string) => `${c}@import 'x';`,
      (c: string) => `${c}a{b:"x\ny"}`,
      (c: string) => `${c}</style>`,
      (c: string) => `${c}/*x*/`,
      (c: string) => `${c}a{b:calc(1px)}`,
      (c: string) => `${c}@font-face{}`,
      (c: string) => `${c}a{b:\\61}`,
    ];
    expect(sanitizeStylesheetWithTamperedSerializer("a{color:red}", (c) => c)).toBe("a{color:red}");
    for (const tamper of tampers) expect(sanitizeStylesheetWithTamperedSerializer("a{color:red}", tamper)).toBe("");
  });
});

// ---- 18f: allowlist behaviour --------------------------------------------------------------

const decl = (d: string) => sanitizeStyleAttribute(d);

describe("18f: allowlist", () => {
  const kept: [string, string][] = [
    ["color:#1A2b3C", "color:#1A2b3C"],
    ["color:rgb(255, 0, 0)", "color:rgb(255,0,0)"],
    ["color:rgba(0,0,0,.5)", "color:rgba(0,0,0,0.5)"],
    ["color:hsl(120deg 50% 50% / 0.5)", "color:hsl(120deg 50% 50% / 0.5)"],
    ["background-color:transparent", "background-color:transparent"],
    ["background:#fff", "background:#fff"],
    ["background:#fff no-repeat center", "background:#fff no-repeat center"],
    ["opacity:0.25", "opacity:0.25"],
    ["font:italic bold 12px/30px Georgia, serif", "font:italic bold 12px / 30px Georgia,serif"],
    ["font-family:'Helvetica Neue', Arial, sans-serif", "font-family:'Helvetica Neue',Arial,sans-serif"],
    ['font-family:"Segoe UI"', "font-family:'Segoe UI'"],
    ["font-size:14PX", "font-size:14px"],
    ["line-height:1.5", "line-height:1.5"],
    ["text-align:center", "text-align:center"],
    ["text-decoration:underline dotted red", "text-decoration:underline dotted red"],
    ["text-shadow:1px 1px 2px #000", "text-shadow:1px 1px 2px #000"],
    ["white-space:nowrap", "white-space:nowrap"],
    ["vertical-align:top", "vertical-align:top"],
    ["margin:0 auto", "margin:0 auto"],
    ["padding:10px 20px 10px 20px", "padding:10px 20px 10px 20px"],
    ["padding-left:2.54cm", "padding-left:2.54cm"],
    ["border:1px solid #cccccc", "border:1px solid #cccccc"],
    ["border-bottom:2px dashed rgb(0,0,0)", "border-bottom:2px dashed rgb(0,0,0)"],
    ["border-radius:4px / 8px", "border-radius:4px / 8px"],
    ["box-shadow:0 1px 3px rgba(0,0,0,0.2)", "box-shadow:0 1px 3px rgba(0,0,0,0.2)"],
    ["box-sizing:border-box", "box-sizing:border-box"],
    ["outline:none", "outline:none"],
    ["width:100%", "width:100%"],
    ["max-width:600px", "max-width:600px"],
    ["min-height:10vh", "min-height:10vh"],
    ["display:inline-block", "display:inline-block"],
    ["float:left", "float:left"],
    ["clear:both", "clear:both"],
    ["overflow:hidden", "overflow:hidden"],
    ["visibility:hidden", "visibility:hidden"],
    ["position:relative", "position:relative"],
    ["position:absolute;top:0;left:-10px;z-index:2", "position:absolute;top:0;left:-10px;z-index:2"],
    ["position:STATIC", "position:STATIC"],
    ["table-layout:fixed", "table-layout:fixed"],
    ["border-collapse:collapse", "border-collapse:collapse"],
    ["border-spacing:0", "border-spacing:0"],
    ["list-style:none", "list-style:none"],
    ["list-style-type:disc", "list-style-type:disc"],
    ["color:red !important", "color:red !important"],
    ["color:red!IMPORTANT", "color:red !important"],
    ["COLOR:Red", "color:Red"],
    ["b\\61 ckground-color:red", "background-color:red"], // hex escape decoded, as the browser does
    ["b\\000061ckground-color:red", "background-color:red"],
    ["font-size:1.123456px", "font-size:1.1235px"],
    ["margin:+5px", "margin:5px"],
    ["margin:-0px", "margin:0px"],
  ];
  for (const [input, output] of kept) it(`keeps ${input}`, () => expect(decl(input)).toBe(output));

  const dropped = [
    "--brand:red", "color:var(--brand)", "width:calc(100% - 10px)", "width:expression(alert(1))", "behavior:url(x.htc)",
    "-moz-binding:url(x)", "-webkit-text-size-adjust:100%", "-ms-interpolation-mode:bicubic", "mso-line-height-rule:exactly",
    "content:'x'", "cursor:pointer", "filter:blur(1px)", "background-image:none", "list-style-image:none", "mask:none",
    "animation:spin 1s", "transition:all 1s", "will-change:transform", "position:fixed", "position:sticky",
    "position:relative absolute", "color:attr(x)", "color:env(x)", "background:linear-gradient(red, blue)",
    "color:rgb(var(--x),0,0)", "color:rgb(1deg,2,3)", "color:hsl(calc(1),2%,3%)", "color:#12", "color:#ggg",
    "width:1e9px", "width:10furlongs", "transform:rotate(1deg)", "font-family:'x\\'y'", "color:'red'",
    "font-family:'" + "a".repeat(65) + "'", "margin:1px/2px", "color:\\72 ed\\", "width:1px{}", "color:{red}",
    "color:[red]", "color:(red)", "color", ":red", "color:", "color:red;;", "1px:red", "color:é", "color:-1x\\",
  ];
  for (const input of dropped) {
    it(`drops ${JSON.stringify(input)}`, () => {
      const out = decl(input);
      if (input === "color:red;;") expect(out).toBe("color:red");
      else expect(out).toBe("");
    });
  }

  it("Q-R3-4: a mixed background shorthand keeps only its colour, as background-color", () => {
    expect(decl("background:#fff url(https://e.example/x.png) no-repeat")).toBe("background-color:#fff");
    expect(decl("background:url(x) rgb(1,2,3) !important")).toBe("background-color:rgb(1,2,3) !important");
    expect(decl("background:linear-gradient(red,blue) navy")).toBe("background-color:navy");
    expect(decl("background:url(x) top left no-repeat")).toBe("");
  });

  it("selectors follow 8.5.4", () => {
    const ok: [string, string][] = [
      ["p{color:red}", "p{color:red}"],
      ["P.Lead , #main>td+th~a:hover{color:red}", "P.Lead,#main > td + th ~ a:hover{color:red}"],
      ["table td .x{color:red}", "table td .x{color:red}"],
      ["*{margin:0}", "*{margin:0}"],
      ["a[href]{color:red}", "a[href]{color:red}"],
      ["a[class~=x][lang|='en'][a^=b][a$=c][a*=d][a=e]{color:red}", "a[class~=x][lang|='en'][a^=b][a$=c][a*=d][a=e]{color:red}"],
      ["li:first-child,li:LAST-CHILD{color:red}", "li:first-child,li:last-child{color:red}"],
    ];
    for (const [i, o] of ok) expect(sanitizeStylesheet(i)).toBe(o);
    const bad = [
      "p::before{color:red}", "p:not(.x){color:red}", "p:nth-child(2){color:red}", "p:has(a){color:red}", "p:is(a){color:red}",
      "svg|a{color:red}", "&.x{color:red}", "p!{color:red}", "'p'{color:red}", "p>{color:red}", ",p{color:red}",
      "p,{color:red}", "a[x=1]{color:red}", "a[x=y i]{color:red}", ".1x{color:red}",
      "#1{color:red}", "p:hovering{color:red}", "[x]p{color:red}", `${"p ".repeat(33)}{color:red}`,
    ];
    for (const b of bad) expect(sanitizeStylesheet(`${b} q{color:blue}`), b).toBe("q{color:blue}");
    // A newline inside an attribute-selector string: the bad string ends at the newline, and the
    // following `"` opens a new string to EOF, so (as in a browser) nothing after it survives.
    expect(sanitizeStylesheet('p{color:red} a[href="x\ny"]{color:red} q{color:blue}')).toBe("p{color:red}");
  });

  it("@media with a valid prelude is kept with its filtered rules; other at-rules and nested @media are dropped", () => {
    expect(sanitizeStylesheet("@media only screen and (max-width: 600px){.a{width:100%!important;cursor:pointer}}")).toBe(
      "@media only screen and (max-width:600px){.a{width:100% !important}}",
    );
    expect(sanitizeStylesheet("@media (min-resolution:2/1),print{p{color:red}}")).toBe("@media (min-resolution:2/1),print{p{color:red}}");
    expect(sanitizeStylesheet("@MEDIA screen{p{color:red}}")).toBe("@media screen{p{color:red}}");
    for (const at of [
      "@supports (display:grid){p{color:red}}",
      "@import 'x.css';",
      "@font-face{font-family:x}",
      "@namespace svg 'x';",
      "@keyframes k{from{color:red}}",
      "@media screen{@media print{p{color:red}}}",
      "@media url(x){p{color:red}}",
      "@media (max-width:calc(1px)){p{color:red}}",
      "@media 'x'{p{color:red}}",
      "@page{margin:0}",
      "@charset 'utf-8';",
    ]) {
      expect(sanitizeStylesheet(`${at} q{color:blue}`), at).toBe("q{color:blue}");
    }
  });

  it("rules with no surviving declaration, nested rules and EOF before a block are dropped", () => {
    expect(sanitizeStylesheet("a{cursor:pointer} b{color:red}")).toBe("b{color:red}");
    expect(sanitizeStylesheet("a{color:red; b{color:blue}}")).toBe("a{color:red}");
    expect(sanitizeStylesheet("a{color:red} b")).toBe("a{color:red}");
    expect(sanitizeStylesheet("<!-- a{color:red} -->")).toBe("a{color:red}");
  });
});

// ---- 18g/18h: toggle and CSP ---------------------------------------------------------------

describe("18g/18h: remote toggle and CSP", () => {
  it("the toggle affects only <img src/srcset>; the background attribute is removed in both modes", () => {
    const html =
      '<img src="https://i.example/a.png" srcset="https://i.example/b.png 2x"><table background="data:image/png;base64,AA"><tr><td background="https://i.example/bg.png" style="background:url(https://i.example/c.png);color:red">x</td></tr></table>';
    const [def, tog] = assertSafe(html, "i.example");
    expect(def).not.toContain("i.example");
    expect(tog).toContain('src="https://i.example/a.png"');
    expect(tog).toContain('srcset="https://i.example/b.png 2x"');
    for (const out of [def!, tog!]) {
      expect(out).not.toContain("background=");
      expect(out).toContain('style="color:red"');
    }
  });

  it("emailCsp has no font-src", () => {
    expect(emailCsp(off)).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(emailCsp(on)).toBe("default-src 'none'; img-src https: data:; style-src 'unsafe-inline'");
    expect(emailDocument("<p>x</p>", on)).not.toContain("font-src");
    expect(EMAIL_IFRAME_SANDBOX).not.toMatch(/allow-scripts|allow-same-origin/);
  });

  it("style attributes are owned by sanitizeStyleAttribute (sanitize-html's postcss pass is off)", () => {
    // With parseStyleAttributes on, sanitize-html would re-serialize this; our canonical output must survive as-is.
    const out = sanitizeEmailHtml('<p style="COLOR : Red  !important ; margin:0 auto">x</p>', off);
    expect(out).toContain('style="color:Red !important;margin:0 auto"');
  });
});

// ---- 18i: caps -----------------------------------------------------------------------------

describe("18i: caps and fallbacks (boundary and boundary + 1)", () => {
  const pad = (n: number, head: string) => head + " ".repeat(n - head.length);

  it("MAX_CSS_CHARS per block and attribute", () => {
    expect(sanitizeStylesheet(pad(MAX_CSS_CHARS, "a{color:red}"))).toBe("a{color:red}");
    expect(sanitizeStylesheet(pad(MAX_CSS_CHARS + 1, "a{color:red}"))).toBe("");
    expect(sanitizeStyleAttribute(pad(MAX_CSS_CHARS, "color:red"))).toBe("color:red");
    expect(sanitizeStyleAttribute(pad(MAX_CSS_CHARS + 1, "color:red"))).toBe("");
  });

  it("MAX_CSS_PER_MESSAGE across a message", () => {
    // Owner Round 7: both caps are 128 Ki code units, so one maximal block spends the whole message budget.
    expect(MAX_CSS_CHARS).toBe(128 * 1024);
    expect(MAX_CSS_PER_MESSAGE).toBe(128 * 1024);
    const half = MAX_CSS_PER_MESSAGE / 2;
    const exact = new CssBudget();
    expect(sanitizeStylesheet(pad(half, "a{color:red}"), exact)).toBe("a{color:red}");
    expect(sanitizeStyleAttribute(pad(MAX_CSS_PER_MESSAGE - half, "color:red"), exact)).toBe("color:red");
    expect(sanitizeStyleAttribute("color:red", exact)).toBe(""); // budget spent
    const over = new CssBudget();
    expect(sanitizeStylesheet(pad(half, "a{color:red}"), over)).toBe("a{color:red}");
    expect(sanitizeStyleAttribute(pad(MAX_CSS_PER_MESSAGE - half + 1, "color:red"), over)).toBe("");
    const full = new CssBudget();
    expect(sanitizeStylesheet(pad(MAX_CSS_CHARS, "a{color:red}"), full)).toBe("a{color:red}");
    expect(sanitizeStyleAttribute("color:red", full)).toBe("");
    // Through the real pipeline: the message still renders as HTML and stays safe.
    // 10 (attribute) + 64 Ki (first block) fits; + 64 Ki (second block) is 10 over the 128 Ki budget.
    const block = `<style>${pad(MAX_CSS_PER_MESSAGE / 2, "a{color:red}")}</style>`;
    // Style attributes are charged during HTML parsing, style elements afterwards: the attribute and
    // the first block fit; the second block would exceed the per-message budget and is dropped.
    const html = `<p style="color:blue">x</p>${block}${block}`;
    const out = sanitizeEmailHtml(html, off);
    expect(out).toContain('<p style="color:blue">x</p>');
    expect(out.match(/a\{color:red\}/g)).toHaveLength(1);
    expect(out.endsWith("<style></style>")).toBe(true);
    expect(isStructurallySafe(out)).toBe(true);
  });

  it("MAX_CSS_PARSE_ERRORS per block", () => {
    // Each "'x<LF>" is exactly one tokenizer parse error (an unterminated string ended by a newline).
    const bad = (n: number) => `a{color:red}${"'x\n".repeat(n)}`;
    expect(sanitizeStylesheet(bad(MAX_CSS_PARSE_ERRORS))).toBe("a{color:red}");
    expect(sanitizeStylesheet(bad(MAX_CSS_PARSE_ERRORS + 1))).toBe("");
  });

  it("nesting depth 32, and the library's 512 limit, drop only that CSS", () => {
    const nest = (d: number) => `a{color:red}b{width:${"(".repeat(d)}${")".repeat(d)}}`;
    expect(sanitizeStylesheet(nest(MAX_CSS_NESTING - 1))).toBe("a{color:red}"); // + the {} block = 32
    expect(sanitizeStylesheet(nest(MAX_CSS_NESTING))).toBe("");
    expect(sanitizeStylesheet(nest(600))).toBe("");
    const out = sanitizeEmailHtml(`<style>${nest(600)}</style><p style="color:red">x</p>`, off);
    expect(out).toBe('<style></style><p style="color:red">x</p>');
  });
});

// ---- 18j: linear time ----------------------------------------------------------------------

function best(fn: () => unknown, runs = 5): number {
  let min = Infinity;
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    fn();
    min = Math.min(min, performance.now() - s);
  }
  return min;
}

describe("18j: linear time (doubling, best of 5 in-process; the tester runs separate processes)", () => {
  const shapes: Record<string, (n: number) => string> = {
    "unterminated url( + spaces": (n) => `a{background:url(${" ".repeat(n)}x`,
    "many quoted url(": (n) => `a{b:${'url("'.repeat(n / 5)}"${" ".repeat(n / 2)}x`,
    "url(data:x) run": (n) => `a{background:${"url(data:x)".repeat(n / 11)}}`,
    "bad-string flood (under the error cap)": (n) => `a{font-family:'x\n';${"color:red;".repeat(n / 10)}}`,
    "escape flood": (n) => `a{${"\\61".repeat(n / 3)}:red}`,
    "26k-style declaration list": (n) => `a{${"color:red;".repeat(n / 10)}}`,
    "nesting near 32": (n) => `a{width:${"(".repeat(30)}${"x ".repeat(n / 2)}${")".repeat(30)}}`,
    "selectors": (n) => `${"a .b>c,".repeat(n / 7)}d{color:red}`,
  };
  for (const [name, make] of Object.entries(shapes)) {
    it(name, { timeout: 60_000 }, () => {
      sanitizeStylesheet(make(8_192)); // warm-up
      const t1 = Math.max(best(() => sanitizeStylesheet(make(32_768))), 5);
      const t2 = best(() => sanitizeStylesheet(make(65_536)));
      const t4 = best(() => sanitizeStylesheet(make(131_072)));
      expect(t2 / t1, `${t1} -> ${t2}`).toBeLessThan(3.5);
      expect(t4 / Math.max(t2, 5), `${t2} -> ${t4}`).toBeLessThan(3.5);
      expect(t4).toBeLessThan(1500);
    });
  }

  it("many tiny style attributes", { timeout: 60_000 }, () => {
    const html = (n: number) => '<p style="color:red;margin:0">x</p>'.repeat(n);
    const t1 = Math.max(best(() => sanitizeEmailHtml(html(1000), off)), 2);
    const t2 = best(() => sanitizeEmailHtml(html(2000), off));
    expect(t2 / t1).toBeLessThan(3.5);
  });

  it("a whole thread of 8 worst-case messages under the caps renders in under 2 s (both modes)", { timeout: 60_000 }, () => {
    const worst = [
      `<style>a{background:url(${" ".repeat(MAX_CSS_CHARS - 40)}x</style>`,
      `<style>${"a .b>c{color:red;margin:0 auto;font-family:'Arial',sans-serif}".repeat(3000)}</style>`,
      '<p style="color:red;margin:0;padding:1px 2px">x</p>'.repeat(3000),
      `<style>${"\\61".repeat(80_000)}</style>`,
      `<style>a{font-family:'x\n';${"color:red;".repeat(20_000)}}</style>`,
      `<style>${'url("'.repeat(30_000)}"</style>`,
      `<style>@media screen{${"p{color:red}".repeat(15_000)}}</style>`,
      `<style>${"{".repeat(31)}${"x".repeat(100_000)}</style>`,
    ];
    const s = performance.now();
    for (const mode of modes) for (const m of worst) emailDocument(m, mode);
    expect(performance.now() - s).toBeLessThan(2000);
  });
});

// ---- Fidelity smoke test -------------------------------------------------------------------

const FIXTURE_CSS = [
  // 1. Classic table newsletter with a responsive media query.
  `body{margin:0;padding:0;background-color:#f4f4f4}
   .wrapper{width:100%;table-layout:fixed;background-color:#f4f4f4}
   .main{max-width:600px;margin:0 auto;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#333333}
   .hero{background:#0a66c2 url(https://cdn.example.com/hero.jpg) no-repeat center;padding:40px 20px;color:#ffffff}
   h1{font-size:28px;line-height:34px;margin:0 0 10px}
   .btn{display:inline-block;padding:12px 24px;border-radius:4px;background-color:#ff6600;color:#fff !important;text-decoration:none}
   .footer td{font-size:12px;color:#999999;padding:20px}
   @font-face{font-family:Brand;src:url(https://cdn.example.com/brand.woff2)}
   @media only screen and (max-width:600px){.main{width:100% !important}.col{display:block !important;width:100% !important}}`,
  // 2. Outlook-flavoured with mso and vendor properties.
  `table{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt}
   img{border:0;-ms-interpolation-mode:bicubic;max-width:100%}
   p{margin:0 0 16px;-webkit-text-size-adjust:100%;font:14px/1.5 'Segoe UI',Tahoma,sans-serif}
   a:hover{color:#004080}
   .card{box-shadow:0 1px 3px rgba(0,0,0,0.15);border:1px solid #e1e1e1;float:left;width:48%}`,
  // 3. Modern utility-ish CSS with features that are dropped.
  `:root{--brand:#123456}
   .title::before{content:'★'}
   .grid{display:flex;gap:16px}
   .box{width:calc(100% - 20px);background-image:linear-gradient(#fff,#eee);position:relative;top:2px;z-index:1}
   .sticky{position:sticky;top:0}
   ul{list-style:none;padding-left:0}`,
];

describe("fidelity smoke test (constructed fixtures)", () => {
  it("fixture 1: widths, colours, padding and the max-width @media rule survive; images and fonts don't", () => {
    const out = sanitizeStylesheet(FIXTURE_CSS[0]!);
    for (const kept of ["max-width:600px", "background-color:#f4f4f4", "padding:40px 20px", "border-radius:4px", "color:#fff !important", "@media only screen and (max-width:600px){", ".main{width:100% !important}"]) {
      expect(out).toContain(kept);
    }
    expect(out).toContain(".hero{background-color:#0a66c2;padding:40px 20px;color:#ffffff}"); // Q-R3-4 salvage
    expect(out).not.toMatch(/url|font-face|Brand|cdn\.example/);
  });

  it("fixture 2: mso/vendor properties are dropped, the rest kept", () => {
    const out = sanitizeStylesheet(FIXTURE_CSS[1]!);
    expect(out).toContain("table{border-collapse:collapse}");
    expect(out).toContain("img{border:0;max-width:100%}");
    expect(out).toContain("font:14px / 1.5 'Segoe UI',Tahoma,sans-serif");
    expect(out).toContain("a:hover{color:#004080}");
    expect(out).toContain("float:left;width:48%");
    expect(out).not.toMatch(/mso|webkit|-ms-/);
  });

  it("fixture 3: custom properties, ::before, gap, calc, gradients and sticky are dropped (recorded in 02-implementation.md)", () => {
    const out = sanitizeStylesheet(FIXTURE_CSS[2]!);
    expect(out).toBe(".grid{display:flex}.box{position:relative;top:2px;z-index:1}.sticky{top:0}ul{list-style:none;padding-left:0}");
  });
});
