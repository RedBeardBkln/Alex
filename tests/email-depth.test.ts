import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { HTMLPARSER2_TABLES, htmlNestingDepth } from "@/lib/email/plain-text";

// Follow-up F1/H1 (phase-2a-followups AC1, AC2): the depth pre-scan models htmlparser2's open-element
// stack. The installed htmlparser2 is used here only as a test oracle, driven as sanitize-html 2.18.2
// drives it: HTML mode, decodeEntities: true, after its `<![CDATA[` -> `<!&#91;CDATA[` rewrite.

const KELVIN = String.fromCharCode(0x212a); // KELVIN SIGN: lowercases to ASCII "k"
const I_ACUTE = String.fromCharCode(0xed);
const CAP_I_ACUTE = String.fromCharCode(0xcd);

/** htmlparser2's actual maximum stack depth on `raw`, as sanitize-html parses it. */
function parserDepth(raw: string): number {
  const html = raw.replaceAll("<![CDATA[", "<!&#91;CDATA[");
  let max = 0;
  const parser = new Parser(
    {
      onopentagname() {
        max = Math.max(max, (parser as unknown as { stack: string[] }).stack.length);
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return max;
}

// ---- The transcribed tables equal the installed parser's ---------------------------------------

describe("tables transcribed from htmlparser2 12.0.0", () => {
  const src = readFileSync(path.resolve(import.meta.dirname, "../node_modules/htmlparser2/dist/Parser.js"), "utf8");
  const tok = readFileSync(path.resolve(import.meta.dirname, "../node_modules/htmlparser2/dist/Tokenizer.js"), "utf8");
  const block = (code: string, start: string) => code.slice(code.indexOf(start), code.indexOf("]);", code.indexOf(start)));

  it("voidElements", () => {
    const names = [...block(src, "const voidElements = new Set([").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(10);
    expect([...HTMLPARSER2_TABLES.HP2_VOID].sort()).toEqual(names.sort());
  });

  it("svgTagNameAdjustments", () => {
    const pairs = [...block(src, "const svgTagNameAdjustments = new Map([").matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((m) => [m[1], m[2]]);
    expect(pairs.length).toBeGreaterThan(30);
    expect([...HTMLPARSER2_TABLES.HP2_SVG_ADJUST].sort()).toEqual(pairs.sort());
  });

  it("htmlIntegrationElements", () => {
    const names = [...block(src, "const htmlIntegrationElements = new Set([").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(5);
    expect([...HTMLPARSER2_TABLES.HP2_INTEGRATION].sort()).toEqual(names.sort());
  });

  it("special (raw-text) end sequences", () => {
    // Every end sequence except CDATA and comments. StyleEnd, TextareaEnd and NoframesEnd are reached as
    // branches of ScriptEnd, TitleEnd and NoembedEnd in specialStartSequences.
    const start = tok.indexOf("const Sequences = {");
    const seq = tok.slice(start, tok.indexOf("};", start));
    const keys = [...seq.matchAll(/^ {4}(\w+?)(?:End)?:/gm)]
      .map((m) => m[1]!.toLowerCase())
      .filter((k) => !["empty", "cdata", "comment", "doctype"].includes(k));
    expect([...HTMLPARSER2_TABLES.HP2_SPECIAL].sort()).toEqual([...new Set(keys)].sort());
  });

  it("openImpliesClose, checked against the parser for every key and member", () => {
    for (const [opener, closes] of HTMLPARSER2_TABLES.HP2_IMPLIES_CLOSE) {
      for (const member of closes) {
        // <x><member><opener>: the opener pops <member> (only from the top).
        const html = `<x><${member}><${opener}>`;
        expect(htmlNestingDepth(html), html).toBe(parserDepth(html));
      }
    }
    // And non-members aren't popped.
    for (const html of ["<x><b><p>", "<x><span><div>", "<x><td><table>", "<x><li><ul>"]) expect(htmlNestingDepth(html), html).toBe(parserDepth(html));
  });
});

// ---- Named shapes -----------------------------------------------------------------------------

describe("named shapes (AC1)", () => {
  const N = 2000;
  const shapes: Record<string, string> = {
    "F1 <p>x": "<p>x".repeat(N),
    "F1 <ul><li>x": `<ul>${"<li>x".repeat(N)}`,
    "F1 <table><tr><td>x": `<table>${"<tr><td>x".repeat(N)}`,
    "<p><b>x (real depth)": "<p><b>x".repeat(N),
    "W1 nested <div>": "<div>".repeat(N),
    "W1 nested <b>": "<b>".repeat(N),
    "W1 unclosed <x>": "<x>".repeat(N),
    "W1 <div><span>": "<div><span>".repeat(N),
    "H1 <div/>": "<div/>".repeat(N),
    "H1 <div></zz> (stray closes)": "<div></zz>".repeat(N),
    "quoted > hiding a close": '<b><div a="></b>">'.repeat(N),
    "bogus </ comment hiding a close": "<div></ </div>>".repeat(N),
    "--!> ends a comment": "<div><!-- --!><div>".repeat(N),
    "noscript and template are parsed": `<noscript>${"<div>".repeat(N)}<template>${"<b>".repeat(N)}`,
    "script/style/title contents are not": `<script>${"<div>".repeat(N)}</script><style>${"<div>".repeat(N)}</style><title>${"<div>".repeat(N)}</title>`,
    "second form ignored": "<form>".repeat(N),
    "stray </p> opens and closes": "</p>".repeat(N),
    "<image> is void": "<image>".repeat(N),
    "unterminated attribute": '<div><div><div class="x',
    "name running to EOF": "<div><div><divvvv",
    "mixed case": "<DiV><SPAN><Div>".repeat(N),
    "<!--> and <!---> are empty comments": "<!--><div><!---><div>".repeat(N),
    "svg self-closing": `<svg>${"<g/>".repeat(N)}${"<g>".repeat(N)}`,
    "svg case adjustment": `<svg>${"<clippath></clipPath>".repeat(N)}`,
    "foreignObject integration point": `<svg><foreignObject>${"<div/>".repeat(N)}</foreignobject>${"<g/>".repeat(N)}`,
    "raw text not raw inside svg": `<svg><style>${"<g>".repeat(N)}`,
    "<image> inside svg is not img": `<svg>${"<image>".repeat(N)}`,
  };
  for (const [name, html] of Object.entries(shapes)) {
    it(name, () => expect(htmlNestingDepth(html)).toBe(parserDepth(html)));
  }

  it("F1 shapes stay at depth ≤ 3, also at 10k repeats", () => {
    for (const html of ["<p>x".repeat(10_000), `<ul>${"<li>x".repeat(10_000)}`, `<table>${"<tr><td>x".repeat(10_000)}`]) {
      expect(htmlNestingDepth(html)).toBeLessThanOrEqual(3);
    }
  });

  it("every W1 shape and both H1 shapes exceed 512", () => {
    for (const html of ["<div>", "<b>", "<x>", "<div><span>", "<div/>", "<div></zz>"].map((u) => u.repeat(600))) {
      expect(htmlNestingDepth(html)).toBeGreaterThan(512);
    }
  });

  it("long and non-ASCII names compare exactly as in the parser", () => {
    const long = "n".repeat(40);
    for (const html of [
      `<${long}><b></${long}>`.repeat(N),
      `<d${I_ACUTE}v><b></D${CAP_I_ACUTE}V>`.repeat(N),
      `<lin${KELVIN}>`.repeat(N), // KELVIN SIGN lowercases to "k": this is the void <link>
      `<p/><lin${KELVIN}><div><pre></p>`.repeat(N), // a marker for it would block <div>'s implied close of <p>
    ]) {
      expect(htmlNestingDepth(html), html.slice(0, 40)).toBe(parserDepth(html));
    }
  });

  it("CDATA is a bogus comment ending at the first > (sanitize-html's rewrite)", () => {
    for (const html of ["<b><![CDATA[ > </b> ]]><i>".repeat(N), "<b><![CDATA[ </b> ]]><i>".repeat(N), "<svg><![CDATA[ > </svg> ]]><g>".repeat(N)]) {
      expect(htmlNestingDepth(html), html.slice(0, 40)).toBe(parserDepth(html));
    }
  });
});

// ---- Randomized differential (AC1: ≥ 5,000 soups, fixed seed) ---------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALLOW = ["a", "b", "div", "span", "p", "table", "tbody", "tr", "td", "th", "ul", "ol", "li", "h1", "h3", "font", "center", "blockquote", "pre", "section", "dl", "dd", "dt"];
const IMPLIES = ["tr", "th", "td", "body", "a", "li", "p", "h2", "select", "input", "output", "button", "datalist", "textarea", "option", "optgroup", "dd", "dt", "address", "form", "hr", "rt", "rp", "tbody", "tfoot", "thead", "head", "link", "script"];
const VOIDS = ["br", "img", "hr", "input", "meta", "wbr", "basefont", "keygen", "image"];
const UNKNOWN = ["x", "zz", "my-el", "o:p", "v:shape", "div$", "b2"];
const RAW = ["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript", "template", "plaintext"];
const FOREIGN = [
  "<svg>", "<math>", "<svg><g/>", "<clipPath>", "</clippath>", "<CLIPPATH/>", "</svg>", "</math>", "<svg/>", "<foreignObject>",
  "</foreignobject>", "<mi>", "</mi>", "<desc>", "<title>", "<annotation-xml>", "<image>", "<image/>", "<script/>", "<![CDATA[ </b> ]]>",
];
const UNUSUAL = [`<${"n".repeat(40)}>`, `</${"n".repeat(40)}>`, `<blo${KELVIN}quote>`, `<lin${KELVIN}>`, `<d${I_ACUTE}v>`, `</d${I_ACUTE}v>`, `<D${CAP_I_ACUTE}V>`];

type Soup = { html: string; unusual: boolean };

function soup(rnd: () => number): Soup {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const mixCase = (s: string) => (rnd() < 0.2 ? s.replace(/[a-z]/g, (ch) => (rnd() < 0.5 ? ch.toUpperCase() : ch)) : s);
  let unusual = false;
  const parts: string[] = [];
  const len = 1 + Math.floor(rnd() * 40);
  for (let k = 0; k < len; k++) {
    const r = rnd();
    const name = mixCase(pick(r < 0.4 ? ALLOW : r < 0.7 ? IMPLIES : r < 0.8 ? VOIDS : r < 0.9 ? UNKNOWN : RAW));
    switch (Math.floor(rnd() * 16)) {
      case 0: case 1: case 2: case 3: parts.push(`<${name}>`); break;
      case 4: case 5: parts.push(`</${name}>`); break;
      case 6: parts.push(`<${name}/>`); break;
      case 7: parts.push(`<${name} a="1 > </b>" b='<div>' c=d>`); break;
      case 8: parts.push(pick(["x", " ", "text & more", "<", "< b", "a<3", "&lt;div&gt;"])); break;
      case 9: parts.push(pick(["<!-- c -->", "<!-->", "<!--->", "<!-- --!>", "<!-- a", "<!doctype html>", "<!x>", "<?php ?>", "</ x>", "</>", "<![CDATA[ <div> ]]>", "<![cdata[ <b> ]]>"])); break;
      case 10: parts.push(`<${name}>${pick(["<div>", "</div>", "x", `</${name}x>`])}</${name}>`); break;
      case 11: parts.push(rnd() < 0.4 ? pick(FOREIGN) : "<p>"); break;
      case 12:
        if (rnd() < 0.3) {
          parts.push(pick(UNUSUAL));
          unusual = true;
        } else parts.push("</p>");
        break;
      case 13: parts.push(`<${name} class="a"/>`); break;
      case 14: parts.push(`<${name}`); break; // may merge with the next token into one tag
      default: parts.push(`</${name}`);
    }
  }
  return { html: parts.join(""), unusual };
}

describe("randomized differential against the installed htmlparser2 (AC1)", () => {
  it("6,000 soups: equal to the parser's depth (so never below it)", () => {
    const rnd = mulberry32(20261119);
    let unusualCases = 0;
    for (let n = 0; n < 6_000; n++) {
      const { html, unusual } = soup(rnd);
      if (unusual) unusualCases += 1;
      expect(htmlNestingDepth(html), JSON.stringify(html)).toBe(parserDepth(html));
    }
    expect(unusualCases).toBeGreaterThan(300); // long and non-ASCII names are well represented
  });
});

// ---- AC2: linear time, fresh process per size ---------------------------------------------------

const helper = path.resolve(import.meta.dirname, "helpers/time-plain.mjs");
function fresh(fn: string, shape: string, n: number): number {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", helper, fn, shape, String(n)], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return Number(r.stdout);
}
const measure = (fn: string, shape: string, n: number) => Math.max(2, Math.min(fresh(fn, shape, n), fresh(fn, shape, n)));

describe("AC2: htmlNestingDepth is linear (n = 1, 2, 4 Mi; fresh processes)", () => {
  // Unbounded (stopAbove = Infinity), except "distinct-names-nested": with ~600k distinct names open at
  // once, the unbounded run is dominated by garbage collection of one entry per name. render.ts always
  // calls with stopAbove = MAX_HTML_DEPTH (512), which ends that shape after 513 opens ("depth-bounded").
  const shapes: [string, string][] = [
    ...["nested-div", "nested-b", "unclosed-x", "div-span", "div-selfclose", "div-stray-close", "p-flood", "li-flood", "tr-td-flood",
      "open-stray-alternate", "distinct-names", "quoted-attr", "comment-bang-flood", "lt-flood"].map((s): [string, string] => ["depth", s]),
    ["depth-bounded", "distinct-names-nested"],
  ];
  for (const [fn, shape] of shapes) {
    it(`${fn}: ${shape}`, { timeout: 120_000 }, () => {
      const n = 1024 * 1024;
      const t1 = measure(fn, shape, n);
      const t2 = measure(fn, shape, 2 * n);
      const t4 = measure(fn, shape, 4 * n);
      const trace = `${t1} -> ${t2} -> ${t4} ms`;
      expect(t4 / t1, trace).toBeLessThan(6.25);
      expect(t2 / t1, trace).toBeLessThan(3);
      expect(t4 / t2, trace).toBeLessThan(3);
      expect(t4, `4 MiB: ${trace}`).toBeLessThan(150);
    });
  }
});
