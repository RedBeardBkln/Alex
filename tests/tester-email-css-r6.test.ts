import { describe, expect, it } from "vitest";
import {
  isTokenAtKeyword,
  isTokenBadString,
  isTokenBadURL,
  isTokenDelim,
  isTokenFunction,
  isTokenString,
  isTokenURL,
  tokenize,
} from "@csstools/css-tokenizer";
import { MAX_CSS_CHARS, MAX_CSS_NESTING, MAX_CSS_PARSE_ERRORS, MAX_CSS_PER_MESSAGE, sanitizeStyleAttribute, sanitizeStylesheet } from "@/lib/email-css";
import { emailCsp, emailDocument, isStructurallySafe, sanitizeEmailHtml } from "@/lib/email-html";

// Tester round 6 (Revision 3): independent differential checks of the parser + allowlist CSS path.

const off = { allowRemoteImages: false };
const on = { allowRemoteImages: true };
const COLOUR_FNS = new Set(["rgb", "rgba", "hsl", "hsla"]);

/** Independent re-tokenization check of one emitted CSS string (stylesheet or declaration list). */
function assertEmittedCssSafe(css: string, label: string) {
  if (css === "") return;
  expect(css, label).not.toMatch(/[<\\"\n\r\f\t\u0000-\u001f\u007f]/);
  expect(css, label).not.toMatch(/[^\x20-\x7e]/);
  let errors = 0;
  const tokens = tokenize({ css }, { onParseError: () => errors++ });
  expect(errors, `${label}: parse errors on re-tokenize`).toBe(0);
  for (const t of tokens) {
    expect(isTokenURL(t) || isTokenBadURL(t) || isTokenBadString(t), `${label}: url/bad token`).toBe(false);
    if (isTokenFunction(t)) expect(COLOUR_FNS.has(t[4].value.toLowerCase()), `${label}: function ${t[4].value}`).toBe(true);
    if (isTokenAtKeyword(t)) expect(t[4].value.toLowerCase(), label).toBe("media");
    if (isTokenDelim(t)) expect(".*>+~/!=|^$#".includes(t[4].value), `${label}: delim ${t[4].value}`).toBe(true);
    if (isTokenString(t)) expect(t[4].value, label).toMatch(/^[A-Za-z0-9 _.-]{1,64}$/);
  }
  // Quotes only in font-family/font values or attribute selectors.
  for (const m of css.matchAll(/'[^']*'/g)) {
    const before = css.slice(Math.max(0, m.index! - 200), m.index!);
    const inAttr = /\[[A-Za-z0-9_-]+[~|^$*]?=$/.test(before);
    const inFont = /(?:^|[;{])font(?:-family)?:[^;{}]*$/.test(before);
    expect(inAttr || inFont, `${label}: quote outside font/attribute: ...${before.slice(-60)}${m[0]}`).toBe(true);
  }
}

/** CSS texts in a sanitized HTML output: style element bodies and style attribute values (decoded). */
function cssIn(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push(m[1]!);
  for (const m of html.matchAll(/\sstyle="([^"]*)"/gi)) out.push(m[1]!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  return out;
}

const H = "e.example.com";
const L = (id: string) => `https://${H}/${id}`;
const NL = ["\n", "\r", "\f", "\r\n"];
const SHEETS: string[] = [];
const DECLS: string[] = [];
// U1-class and string/escape variants.
for (const n of NL) {
  SHEETS.push(`a{background:url("data:,x${n});background:url(${L("u1")});y:")}`);
  SHEETS.push(`a{font-family:"x${n};cursor:url(${L("cur")}),auto;y:"}`);
  SHEETS.push(`@font-face{font-family:f;src:url("data:,x${n});src:url(${L("ff")});y:")}`);
  SHEETS.push(`[title="x${n}]{} b{background-image:url(${L("sel")})}"]{color:red}`);
  SHEETS.push(`a{color:red;x:'${n}';background:url(${L("sq")})}`);
  DECLS.push(`background:url("data:,x${n});background:url(${L("attr")});y:")`);
  DECLS.push(`font-family:'a${n};cursor:url(${L("attr2")});x:'`);
}
SHEETS.push(`a{font-family:"a\\\n;background:url(${L("escnl")});x:"}`);
SHEETS.push(`a{background:u\\72l(${L("esc")})}`, `a{background:\\75rl(${L("esc2")})}`, `a{\\62 ackground:url(${L("escp")})}`, `a{b\\61 ckground-color:red;\\63 ursor:url(${L("escc")}),auto}`);
SHEETS.push(`a{background:u/**/rl(${L("cmt")})}`, `a{background:url(${L("nul")}\u0000)}`, `a{background:url(${L("fffd")}�)}`, `a{background:url(${L("lone")}\uD800)}`);
SHEETS.push(`a{background:url(${L("eof")}`, `a{font-family:"unterminated`, `a{color:red}</style><img src=x onerror=alert(1)>`);
// Functions.
for (const fn of [`image(${L("i")})`, `image-set(url(${L("is")}) 1x)`, `cross-fade(url(${L("x")}),url(${L("y")}))`, "element(#x)", "paint(p)", `src(${L("s")})`, "var(--x)", "env(x)", "attr(data-x)", "calc(1px + 2px)", "linear-gradient(red,blue)", "radial-gradient(red,blue)", "expression(alert(1))", "rgb(var(--x),0,0)", "rgb(calc(1),0,0)", "rgb(1 2 3 / url(x))", "hsl(10deg 10% 10%)", "rgba(1,2,3,.5)", "RGB(1,2,3)"]) {
  SHEETS.push(`a{color:${fn};background:${fn};width:${fn};list-style:${fn};unicode-range:U+0-7F}`);
}
// At-rules and nesting.
SHEETS.push(
  `@import url(${L("imp")});`,
  `@import "${L("imp2")}";`,
  `@namespace url(${L("ns")});`,
  `@media screen and (min-width:1px), url(${L("mq")}) {a{color:red}}`,
  `@media (max-width:600px){a{color:red;background:url(${L("mqb")})}@media all{b{color:blue}}}`,
  `@media (min-resolution:2/1),print{a{color:red}}`,
  `@media x,y{a{color:red}}`,
  `@MEDIA ALL{a{color:red}}`,
  `@me\\64 ia all{a{color:red}}`,
  `@media "x"{a{color:red}}`,
  `@media (--x:1){a{color:red}}`,
  `@media (min-width:calc(1px)){a{color:red}}`,
  `@supports (display:block){a{color:red}}`,
  `@keyframes k{from{color:red}}`,
  `@layer l{a{color:red}}`,
  `@container (min-width:1px){a{color:red}}`,
  `@font-face{font-family:f;src:url(${L("ffs")})}`,
  `@property --p{syntax:'<url>';initial-value:url(${L("prop")})}`,
  `@scope (.a){b{color:red}}`,
  `@page{margin:0}`,
  `a{color:red;b{color:blue}}`,
  `a{color:red;&:hover{color:blue}}`,
  `a{color:red;.x &{background:url(${L("nest")})}}`,
  `a{color:red !important;color:blue!important;margin:0 ! important;padding:!important 0;width:1px !important !important}`,
  `a{color:red}}}}b{color:blue}`,
  `<!-- a{color:red} -->`,
);
// Selectors.
for (const sel of [":has(a)", ":is(a)", ":where(a)", ":not(a)", "a::before", "a::after", "*|a", '[title="a"i]', `[title='a"b']`, '[title="a\\"b"]', `[x^="${L("s")}"]`, "a:nth-child(1)", "&", "a!", ":host", "::part(x)", "a:visited", ":root", "a>b+c~d", "a , b", ".a.b#c[d]", "[d='safe-value']", "[d=val]", "a\\:hover", "#123", ".\\31 23", "a::-webkit-scrollbar", "a:hover:focus", "@media", "a[title]{} b"]) {
  SHEETS.push(`${sel}{color:green;background:url(${L("selbody")})}`);
}
// S2-type properties.
for (const d of ["cursor:url(X),auto", "-moz-binding:url(X)", "filter:url(X)", "mask:url(X)", "content:url(X)", "behavior:url(X)", "list-style-image:url(X)", "border-image:url(X) 30", "background-image:url(X)", "background:#fff url(X)", "background:url(X) red", "background:url(X)", "--x:url(X)", "mso-line-height-rule:exactly", "-webkit-text-size-adjust:100%"]) {
  const v = d.replace(/X/g, L("s2"));
  SHEETS.push(`a{${v}}`);
  DECLS.push(v);
}

describe("differential: every emitted CSS re-tokenizes clean (independent of cssOutputIsSafe)", () => {
  it("stylesheets: safe tokens, no attacker host, idempotent", () => {
    for (const s of SHEETS) {
      const out = sanitizeStylesheet(s);
      assertEmittedCssSafe(out, JSON.stringify(s));
      expect(out, JSON.stringify(s)).not.toContain(H);
      expect(sanitizeStylesheet(out), `idempotent: ${JSON.stringify(s)}`).toBe(out);
    }
  });

  it("declaration lists (style attributes): safe tokens, no attacker host, idempotent", () => {
    for (const d of [...DECLS, ...SHEETS.map((s) => s.replace(/^[^{]*\{/, "").replace(/\}$/, ""))]) {
      const out = sanitizeStyleAttribute(d);
      assertEmittedCssSafe(out, JSON.stringify(d));
      expect(out, JSON.stringify(d)).not.toContain(H);
      expect(sanitizeStyleAttribute(out), `idempotent: ${JSON.stringify(d)}`).toBe(out);
    }
  });

  it("through the full HTML pipeline in both modes: CSS byte-identical between modes and structurally safe", () => {
    for (const s of SHEETS) {
      const attr = s.replace(/^[^{]*\{/, "").replace(/\}$/, "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\f/g, "&#12;");
      const html = `<style>${s}</style><div style="${attr}">x</div>`;
      const a = sanitizeEmailHtml(html, off);
      const b = sanitizeEmailHtml(html, on);
      expect(cssIn(a), JSON.stringify(s)).toEqual(cssIn(b));
      for (const out of [a, b]) {
        expect(isStructurallySafe(out)).toBe(true);
        for (const css of cssIn(out)) {
          assertEmittedCssSafe(css, JSON.stringify(s));
          expect(css).not.toContain(H);
        }
      }
    }
  });

  it("random token soup (fixed seed, 6,000 inputs) never yields unsafe or non-idempotent CSS", () => {
    const parts = [
      "a", "b", "{", "}", "(", ")", "[", "]", ";", ":", ",", " ", "\n", "\r", "\f", "\\", "\\\n", '"', "'", "/*", "*/", "url(", "URL(", "u\\72l(", "@media ", "@import ", "@font-face", "!important",
      "color", "background", "background-color", "position", "fixed", "sticky", "absolute", "float", "left", "#fff", "red", "rgb(", "hsl(", "calc(", "var(--x)", "1px", "50%", "10deg", "1e9", "-0",
      "https://e.example.com/x", "data:,x", "<", "</style>", "&", ".c", "#i", ">", "+", "~", "*", "=", "^=", "|", "$", "\u0000", "�", "é", "İ", "--x", "-webkit-", "mso-", "&quot;",
    ];
    let seed = 1234567;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    for (let k = 0; k < 6000; k++) {
      let css = "";
      const len = 3 + Math.floor(rand() * 40);
      for (let j = 0; j < len; j++) css += parts[Math.floor(rand() * parts.length)];
      const a = sanitizeStylesheet(css);
      const d = sanitizeStyleAttribute(css);
      assertEmittedCssSafe(a, JSON.stringify(css));
      assertEmittedCssSafe(d, JSON.stringify(css));
      expect(a).not.toContain(H);
      expect(d).not.toContain(H);
      expect(sanitizeStylesheet(a), JSON.stringify(css)).toBe(a);
      expect(sanitizeStyleAttribute(d), JSON.stringify(css)).toBe(d);
    }
  });
});

describe("self-tests of the checker and corpus (so passing means something)", () => {
  it("assertEmittedCssSafe rejects known-bad CSS", () => {
    for (const bad of ["a{background:url(x)}", "a{color:var(--x)}", "@import 'x';", "@font-face{}", 'a{font-family:"x"}', "a{x:'a\nb'}", "a{color:red}</style>", "a{b:c\\d}", "a{content:'x'}"]) {
      expect(() => assertEmittedCssSafe(bad, bad), bad).toThrow();
    }
  });

  it("the corpus and soup produce real (non-empty) output often enough to be meaningful", () => {
    const nonEmpty = SHEETS.filter((s) => sanitizeStylesheet(s) !== "").length;
    expect(nonEmpty).toBeGreaterThanOrEqual(25); // most of the corpus is hostile; 32 of 122 observed
    expect(sanitizeStylesheet("a{color:red;margin:0 auto;font-family:'Arial',sans-serif}@media (max-width:600px){.x{width:100%!important}}")).toBe(
      "a{color:red;margin:0 auto;font-family:'Arial',sans-serif}@media (max-width:600px){.x{width:100% !important}}",
    );
  });
});

describe("allowlist conformance with the owner's decisions", () => {
  it("position: static/relative/absolute kept (any case); fixed/sticky/-webkit-sticky and junk dropped; float/clear kept", () => {
    for (const v of ["static", "relative", "absolute", "ABSOLUTE"]) expect(sanitizeStyleAttribute(`position:${v};top:0`)).toMatch(new RegExp(`position:${v}`, "i"));
    for (const v of ["fixed", "sticky", "-webkit-sticky", "FIXED", "fixed !important", "absolute fixed", "inherit fixed", "f\\69xed"]) {
      expect(sanitizeStyleAttribute(`position:${v}`), v).not.toMatch(/position/);
    }
    expect(sanitizeStyleAttribute("float:left;clear:both")).toBe("float:left;clear:both");
    expect(sanitizeStylesheet(".a{position:sticky;top:0}")).toBe(".a{top:0}");
  });

  it("background shorthand: colour-only kept; colour+image keeps only the colour (as background-color); no colour → dropped", () => {
    expect(sanitizeStyleAttribute("background:#fff")).toBe("background:#fff");
    expect(sanitizeStyleAttribute(`background:#fff url(${L("b")})`)).toBe("background-color:#fff");
    expect(sanitizeStyleAttribute(`background:url(${L("b")}) red !important`)).toBe("background-color:red !important");
    expect(sanitizeStyleAttribute(`background:rgb(1,2,3) linear-gradient(red,blue)`)).toBe("background-color:rgb(1,2,3)");
    expect(sanitizeStyleAttribute(`background:url(${L("b")})`)).toBe("");
    expect(sanitizeStyleAttribute(`background:var(--x)`)).toBe("");
    expect(sanitizeStyleAttribute(`background-image:url(${L("b")});background-color:blue`)).toBe("background-color:blue");
  });

  it("calc() and gradients are dropped wherever they appear", () => {
    for (const d of ["width:calc(100% - 10px)", "background:linear-gradient(red,blue)", "background-color:linear-gradient(red,blue)", "margin:calc(1px)", "color:rgb(calc(1),0,0)", "width:min(1px,2px)", "width:clamp(1px,2px,3px)"]) {
      expect(sanitizeStyleAttribute(d), d).toBe("");
    }
  });

  it("the HTML background attribute is removed in both modes, for every scheme", () => {
    for (const opts of [off, on]) {
      for (const u of ["https://ok.example.org/a.png", "data:image/png;base64,AA", "/rel.png", "http://x.example.org/a.png"]) {
        const out = sanitizeEmailHtml(`<table background="${u}"><tr background="${u}"><th background="${u}">a</th><td background="${u}">b</td></tr></table><body background="${u}">`, opts);
        expect(out, u).not.toMatch(/background=/i);
      }
    }
  });

  it("CSP has no font-src, and img-src https only with the toggle", () => {
    expect(emailCsp(off)).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(emailCsp(on)).toBe("default-src 'none'; img-src https: data:; style-src 'unsafe-inline'");
    expect(emailDocument("<p>x</p>", on)).not.toContain("font-src");
  });

  it("'Show remote images' changes only <img>: https img src comes back, nothing else differs", () => {
    const html = `<img src="https://ok.example.org/a.png"><style>a{color:red;background:url(https://ok.example.org/b.png)}</style><p style="color:blue;background:url(https://ok.example.org/c.png)">x</p><table background="https://ok.example.org/d.png"><tr><td>x</td></tr></table>`;
    const a = sanitizeEmailHtml(html, off);
    const b = sanitizeEmailHtml(html, on);
    expect(b).toContain('src="https://ok.example.org/a.png"');
    expect(a).not.toContain("ok.example.org");
    expect(b.replace(' src="https://ok.example.org/a.png"', "")).toBe(a);
  });
});

describe("caps at their boundaries (independent)", () => {
  it("MAX_CSS_CHARS per block and attribute: at the cap kept, +1 dropped", () => {
    const pad = (n: number) => "a{color:red}" + " ".repeat(n - 12);
    expect(sanitizeStylesheet(pad(MAX_CSS_CHARS))).toBe("a{color:red}");
    expect(sanitizeStylesheet(pad(MAX_CSS_CHARS + 1))).toBe("");
    const apad = (n: number) => "color:red" + " ".repeat(n - 9);
    expect(sanitizeStyleAttribute(apad(MAX_CSS_CHARS))).toBe("color:red");
    expect(sanitizeStyleAttribute(apad(MAX_CSS_CHARS + 1))).toBe("");
  });

  it("MAX_CSS_PER_MESSAGE across style blocks: exactly the budget renders, one more char drops only the last block", () => {
    const block = (n: number) => `<style>${"a{color:red}" + " ".repeat(n - 12)}</style>`;
    const half = MAX_CSS_PER_MESSAGE / 2;
    const exact = sanitizeEmailHtml(block(half) + block(half) + "<p>tail</p>", off);
    expect(exact.match(/a\{color:red\}/g)?.length).toBe(2);
    const over = sanitizeEmailHtml(block(half) + block(half + 1) + "<p>tail</p>", off);
    expect(over.match(/a\{color:red\}/g)?.length).toBe(1);
    expect(over).toContain("<p>tail</p>");
    expect(isStructurallySafe(over)).toBe(true);
  });

  it("MAX_CSS_PARSE_ERRORS: 100 bad strings kept, 101 dropped", () => {
    const bad = (n: number) => "a{color:red}" + "b{x:'\n}".repeat(n);
    const count = (css: string) => {
      let e = 0;
      tokenize({ css }, { onParseError: () => e++ });
      return e;
    };
    expect(count(bad(MAX_CSS_PARSE_ERRORS))).toBe(MAX_CSS_PARSE_ERRORS);
    expect(sanitizeStylesheet(bad(MAX_CSS_PARSE_ERRORS))).toContain("a{color:red}");
    expect(sanitizeStylesheet(bad(MAX_CSS_PARSE_ERRORS + 1))).toBe("");
  });

  it("nesting: depth 32 kept, 33 dropped; very deep (2,000) dropped without throwing; rest of message renders", () => {
    const nest = (d: number) => "a{color:red}b{x:" + "(".repeat(d - 1) + ")".repeat(d - 1) + "}";
    expect(sanitizeStylesheet(nest(MAX_CSS_NESTING))).toContain("a{color:red}");
    expect(sanitizeStylesheet(nest(MAX_CSS_NESTING + 1))).toBe("");
    const deep = "a{color:red}" + "[".repeat(2000);
    expect(() => sanitizeStylesheet(deep)).not.toThrow();
    expect(sanitizeStylesheet(deep)).toBe("");
    const out = sanitizeEmailHtml(`<style>${deep}</style><p>still here</p>`, off);
    expect(out).toContain("<p>still here</p>");
  });
});

describe("V1: long value lists serialize in quadratic time (joinParts endsWith on a growing string)", () => {
  const C = MAX_CSS_CHARS;
  it("one maximal (MAX_CSS_CHARS) style block of plain idents in font-family is parsed and sanitizes in under 500 ms", { timeout: 120_000 }, () => {
    const css = `a{font-family:${"x ".repeat(Math.floor((C - 20) / 2))}}`;
    expect(css.length).toBeLessThanOrEqual(C);
    const t0 = performance.now();
    const out = sanitizeStylesheet(css);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out.length, "really parsed, not dropped by the cap").toBeGreaterThan(C / 4);
  });

  it("a message spending its full MAX_CSS_PER_MESSAGE budget across two style attributes (both parsed) sanitizes in under 1 s", { timeout: 120_000 }, () => {
    // Two attributes of exactly half the per-message budget each: both are parsed and kept.
    const half = MAX_CSS_PER_MESSAGE / 2;
    const attr = (k: string) => {
      const head = `font-family:${k} `;
      return head + "x ".repeat(Math.floor((half - head.length) / 2)) + (((half - head.length) % 2) ? "x" : "");
    };
    const a1 = attr("a1");
    const a2 = attr("a2");
    expect(a1.length + a2.length).toBe(MAX_CSS_PER_MESSAGE);
    const t0 = performance.now();
    const out = sanitizeEmailHtml(`<p style="${a1}">a</p><p style="${a2}">b</p><p style="color:red">c</p>`, off);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out, "first attribute parsed and kept").toContain('style="font-family:a1 x x');
    expect(out, "second attribute parsed and kept").toContain('style="font-family:a2 x x');
    // The budget is exactly spent: a third attribute, however small, is dropped; the message stays HTML.
    expect(out).not.toContain("color:red");
    expect(out).toContain(">c</p>");
    expect(isStructurallySafe(out)).toBe(true);
  });

  it("quadrupling a colour-function list costs at most 2.5^2 = 6.25x (16 K -> 64 K, both under the cap, best of 5; quadratic would be ~16x)", { timeout: 120_000 }, () => {
    const run = (n: number) => {
      const css = `a{color:${"rgb(1,2,3) ".repeat(Math.floor(n / 11))}}`;
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        sanitizeStylesheet(css);
        best = Math.min(best, performance.now() - t0);
      }
      return Math.max(best, 5);
    };
    run(8_000);
    // Both sizes stay under MAX_CSS_CHARS so the CSS is really parsed (over the cap it is dropped instantly).
    expect(`a{color:${"rgb(1,2,3) ".repeat(Math.floor(65_536 / 11))}}`.length).toBeLessThanOrEqual(MAX_CSS_CHARS);
    expect(sanitizeStylesheet(`a{color:${"rgb(1,2,3) ".repeat(Math.floor(65_536 / 11))}}`)).not.toBe("");
    const a = run(16_384);
    const b = run(65_536);
    expect(b / a, `${a.toFixed(0)} ms -> ${b.toFixed(0)} ms`).toBeLessThan(6.25);
  });
});

describe("timing (in-process smoke; separate-process doubling is in the report)", () => {
  it("my round-4 T1/T2 shapes and a U1 flood stay fast", { timeout: 60_000 }, () => {
    const shapes = [
      `<style>a{background:url(${" ".repeat(100_000)}x</style>`,
      `<style>a{background:${"url(data:x)".repeat(11_000)}}</style>`,
      `<style>${'a{x:"\n}'.repeat(17_000)}</style>`,
      `<div style="background:url(${" ".repeat(100_000)}x">t</div>`,
    ];
    // Round 8 (128 K caps): every shape's CSS must stay under MAX_CSS_CHARS, or it is dropped unparsed.
    for (const s of shapes) expect(s.replace(/^<[^>]*>/, "").replace(/<\/style>$|">t<\/div>$/, "").length).toBeLessThanOrEqual(MAX_CSS_CHARS);
    for (const s of shapes) {
      const t0 = performance.now();
      sanitizeEmailHtml(s, off);
      expect(performance.now() - t0, s.slice(0, 40)).toBeLessThan(1000);
    }
  });
});
