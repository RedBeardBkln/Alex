import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { htmlNestingDepth } from "@/lib/email/plain-text";
import { MAX_HTML_DEPTH } from "@/lib/email/render";

// Tester, task phase-2a-followups: independent differential of the F1/H1 depth pre-scan against the
// real parser. Safety property: the scan never reports LESS depth than htmlparser2 actually builds.

/**
 * Oracle: the maximum open-element stack length htmlparser2 reaches on `html`, driven exactly as
 * sanitize-html 2.18.2 drives it (CDATA rewrite, then `new Parser(cbs, { decodeEntities: true })`).
 * The stack is read from the parser itself after every callback.
 */
function oracleDepth(html: string): number {
  const input = html.replaceAll("<![CDATA[", "<!&#91;CDATA[");
  let max = 0;
  // eslint-disable-next-line prefer-const
  let parser: Parser;
  const look = () => {
    const len = (parser as unknown as { stack: string[] }).stack.length;
    if (len > max) max = len;
  };
  const cbs = {
    onopentagname: look,
    onopentag: look,
    onattribute: look,
    onclosetag: look,
    ontext: look,
    oncomment: look,
    onprocessinginstruction: look,
    oncdatastart: look,
  };
  parser = new Parser(cbs, { decodeEntities: true });
  parser.write(input);
  look();
  parser.end();
  return max;
}

const results = { total: 0, equal: 0, over: 0 };
function check(html: string) {
  const real = oracleDepth(html);
  const alex = htmlNestingDepth(html);
  results.total++;
  if (alex === real) results.equal++;
  else if (alex > real) results.over++;
  expect(alex, `UNDERCOUNT on ${JSON.stringify(html.slice(0, 300))}: alex ${alex} < parser ${real}`).toBeGreaterThanOrEqual(real);
  // The production call: htmlNestingDepth(html, 512) must report "> 512" whenever the parser goes deeper.
  if (real > MAX_HTML_DEPTH) expect(htmlNestingDepth(html, MAX_HTML_DEPTH)).toBeGreaterThan(MAX_HTML_DEPTH);
  return { real, alex };
}

let seed = 1;
const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), seed / 4294967296);
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;

// Unicode characters whose case mapping is unusual: KELVIN→k, İ→i̇ (2 units), ſ, ẞ→ß, Σ, ﬀ ligature,
// roman numeral, Cherokee, Deseret (surrogate pair), Georgian, combining marks, fullwidth, ZWJ, NUL.
const ODD = ["K", "İ", "ı", "ſ", "ẞ", "Σ", "ﬀ", "Ⅸ", "Ꭰ", "\u{10400}", "Ⴀ", "́", "Ｐ", "‍", "\u0000", "ß", "I", "i"];
const NAMES = [
  "p", "li", "td", "tr", "th", "dd", "dt", "option", "optgroup", "tbody", "thead", "tfoot", "h1", "h3", "a", "div", "span", "b", "table", "ul", "ol",
  "form", "select", "input", "button", "textarea", "br", "img", "image", "link", "track", "keygen", "mark", "blockquote", "kbd", "body", "head", "html",
  "script", "style", "title", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript", "template",
  "svg", "math", "foreignObject", "foreignobject", "FOREIGNOBJECT", "desc", "mi", "mo", "mn", "ms", "mtext", "annotation-xml", "clipPath", "feBlend", "lineargradient",
  "x", "zz", "x-y", "a".repeat(40),
];
const SPACES = [" ", "\t", "\n", "\f", "\r", "\v", ""];

function oddName(): string {
  const base = pick(NAMES);
  const r = rand();
  if (r < 0.15) return base.toUpperCase();
  if (r < 0.3) {
    // splice an odd character into the name
    const k = Math.floor(rand() * (base.length + 1));
    return base.slice(0, k) + pick(ODD) + base.slice(k);
  }
  if (r < 0.4) return base.replace(/k/g, "K").replace(/i/g, "İ");
  if (r < 0.5) return base.split("").map((c) => (rand() < 0.5 ? c.toUpperCase() : c)).join("");
  return base;
}

function attrs(): string {
  const parts: string[] = [];
  const n = Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    parts.push(
      pick([
        ' a="x>y"',
        " b='>'",
        " c=d",
        " e",
        ' f="',
        " g='",
        " h=>",
        " i= '<p>' ",
        " /",
        "/",
        ' j="</script>"',
        " k=\"<!--\"",
        " l='-->'",
        pick(SPACES) + "m=" + pick(SPACES) + "\"n\"",
      ]),
    );
  }
  return parts.join("");
}

function token(): string {
  const r = rand();
  const name = oddName();
  if (r < 0.34) return `<${name}${attrs()}${pick(["", " ", "/", " /"])}>`;
  if (r < 0.52) return `</${name}${pick(["", " ", " x", "\t", "/"])}>`;
  if (r < 0.62) return pick(["x", "text", "&lt;p&gt;", "&#60;div&#62;", " ", "\n"]);
  return pick([
    "<!-- c -->", "<!-->", "<!--->", "<!-- --!>", "<!-- -- >", "<!--", "-->", "--!>", "<![CDATA[<div><div>]]>", "<![CDATA[", "]]>",
    "<?x>", "<!x>", "<!DOCTYPE html>", "</>", "</ >", "</1>", "< p>", "<1p>", "<p<p>", "<", "</", ">", "<p\u0000>", "<p\f>", "</p\f>",
    "<svg/>", "<math/>", "<svg><circle/></svg>", "<math><mi/></math>", "<p/>", "<div/>", "<br/>", "</br>", "</p>", "</form>", "<form>",
    "<script>", "</script>", "</script ", "</SCRIPT>", "</scriptx>", "</script/", "<style>", "</style>", "<title>", "</title>", "<plaintext>",
    "<textarea>", "</textarea>", "<xmp>", "</xmp>", "<iframe>", "</iframe>", "<noscript>", "</noscript>", "<template>", "</template>",
    "<svg>", "</svg>", "<math>", "</math>", "<foreignObject>", "</foreignObject>", "<desc>", "<annotation-xml>", "<image>", "</image>",
  ]);
}

function soup(maxLen: number): string {
  const n = 1 + Math.floor(rand() * maxLen);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(token());
  return parts.join("");
}

describe("oracle self-test (so the differential means something)", () => {
  it("reads htmlparser2's real stack", () => {
    expect(oracleDepth("<div><div><div>x</div></div></div>")).toBe(3);
    expect(oracleDepth("<p>x<p>x<p>x")).toBe(1); // implied end tags
    expect(oracleDepth("<div/><div/><div/>")).toBe(3); // /> doesn't self-close in HTML
    expect(oracleDepth("<div></zz><div></zz>")).toBe(2); // stray closes ignored
    expect(oracleDepth("<noscript><div><div>")).toBe(3); // parsed by htmlparser2
    expect(oracleDepth("<script><div><div>")).toBe(1); // raw text
    expect(oracleDepth(`<p><linK><div><p></p></div>`)).toBe(2); // KELVIN lowercases to void "link"
  });
});

describe("depth pre-scan vs htmlparser2: never an undercount (independent tester generators)", () => {
  it("named adversarial cases (Unicode folding, foreign content, raw text, malformed tags)", () => {
    const K = "K";
    const cases = [
      // Unicode case-folding
      `<p><lin${K}><div><p></p></div>`, `<p><trac${K}><div></p>`, `<${K}bd><p><div></${K}bd>`, `<p><b${K}>x</bk><div></p>`, `<blo${K}quote><p></blockquote></p>`,
      `<SCRİPT><div><div></scri̇pt>`, `<ſcript><div><div>`, `<script><div></ſcript><div>`, `<script><div></SCRİPT><div></script><div>`,
      `<İ><div></i>`, `<ṕ><div></ṕ>`, `<ｐ><div></ｐ>`, `<a\u{10400}><div></a\u{10428}>`, `<a\u{10400}><div></A\u{10400}>`,
      `<TİTLE><div></title>`, `<TITLE><div></TITLE><div>`, `<title><div></tİtle><div>`,
      // foreign content
      `<svg><p><div></div></p></svg>`, `<svg><style><div><div></style></svg>`, `<svg><foreignObject><style><div></style></foreignObject></svg>`,
      `<svg><title><style><div></style></title></svg><div>`, `<math><mi><style><div></style></mi></math>`, `<math><annotation-xml><script><div></script></annotation-xml></math>`,
      `<svg><div/><div/><div/></svg>`, `<div/><div/><div/>`, `<svg><foreignObject><div/><div/></foreignObject></svg>`, `<SVG><CLIPPATH><div></clippath></svg>`,
      `<svg><clippath></clipPath><div>`, `<svg><lineargradient></linearGradient></svg><div>`, `<math><svg><desc><div/></desc></svg></math>`,
      `<svg><svg><svg></svg></svg></svg>`, `<svg>` + "<g>".repeat(50), `<math>` + "<mrow>".repeat(50) + `</math>`, `<svg><image><div></image></svg>`, `<image><div></image>`,
      // raw text and closers
      `<script><div><div></script ><div>`, `<script><div></script\t><div>`, `<script><div></script\v><div></script><div>`, `<script><div></scriptx><div>`,
      `<style><p></style/><div>`, `<textarea><div></textarea><div>`, `<xmp><div></xmp><div>`, `<plaintext><div><div><div>`, `<noscript><div><div></noscript>`,
      `<template><div><div></template>`, `<iframe><div></iframe ><div>`, `<script>` + "<div>".repeat(30), `<title><!--</title>--><div>`,
      // malformed tags and attribute quoting
      `<div a="x>y"><div b='>'><div c=">`, `<div a='<!--'><div></div>`, `<div a="--><div>"><div>`, `<p a=">"></p><p>`, `<div a=b>c><div>`,
      `<div\u0000x><div>`, `<div\fx><div>`, `<div/x><div>`, `<div x/><div>`, `<div//><div>`, `< div><div>`, `<<div>><div>`, `<div<div>><div>`,
      `</div x="</div>">`, `<div></div x><div>`, `<!--><div>`, `<!---><div>`, `<!-- --!><div>`, `<!-- -- ><div>-->`, `<![CDATA[><div><div>]]>`, `<![CDATA[<div>`,
      `<?x <div> ?><div>`, `<!x <div>><div>`, `</ div><div>`, `</1div><div>`, `</><div>`, `<div` , `<div a="`, `<div a='x`, `<div></`, `<div></div`,
      // implied ends and strays
      `<p>x`.repeat(30), `<ul>` + `<li>x`.repeat(30), `<table>` + `<tr><td>x`.repeat(30), `<p><b>x`.repeat(20), `<div></zz>`.repeat(30), `</p>`.repeat(10) + "<div>".repeat(5),
      `<form><form><div></form><div>`, `<form>` + "<div>".repeat(10) + `<form>`.repeat(5), `<select><option><option><optgroup><option>`, `<dl><dt><dd><dt><dd>`,
      `<h1><h2><p><h3>`, `<a><a><a>`, `<body><head><link><script>`, `<td><thead><th><td>`, `</br></br><div>`, `<br><br/></br>`,
    ];
    for (const c of cases) check(c);
  });

  for (const [label, maxLen, n, s0] of [
    ["short soups", 12, 6000, 7] as const,
    ["long soups", 80, 3000, 13] as const,
    ["very long soups", 400, 400, 29] as const,
  ]) {
    it(`randomized ${label} (${n}, fixed seed ${s0})`, { timeout: 120_000 }, () => {
      seed = s0;
      for (let i = 0; i < n; i++) check(soup(maxLen));
    });
  }

  // One-off large sweeps: TESTER_DEPTH_EXTRA=<count> npx vitest run tests/tester-depth-followups.test.ts
  it.runIf(!!process.env.TESTER_DEPTH_EXTRA)("extra randomized sweep (env TESTER_DEPTH_EXTRA)", { timeout: 1_800_000 }, () => {
    const total = Number(process.env.TESTER_DEPTH_EXTRA);
    for (let i = 0; i < total; i++) {
      seed = 1_000_003 + i;
      check(soup(1 + (i % 200)));
    }
  });

  it("deep soups: whenever the parser goes past 512, the bounded production call says so", { timeout: 120_000 }, () => {
    seed = 99;
    for (let i = 0; i < 60; i++) {
      const prefix = pick(["", "<svg>", "<math>", "<table>", "<ul>", "<form>"]);
      const unit = pick(["<div>", "<b>", "<x>", "<div><span>", "<p><b>", "<svg><g>", "<div/>", "<div></zz>", "<spanK>", "<li><div>", `<${pick(NAMES)}>`]);
      const html = prefix + unit.repeat(600) + soup(20);
      check(html);
    }
  });

  it("reports how often the scan is exact (informational)", () => {
    // Equality is what the coder claims; the safety requirement is only >=.
    expect(results.total).toBeGreaterThan(9000);
    console.log(`[tester] depth differential: ${results.total} inputs, ${results.equal} equal, ${results.over} overcount, 0 undercount`);
  });
});
