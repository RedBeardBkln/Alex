import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SANITIZER_ALLOWED_ATTRIBUTES, isStructurallySafe as fromHtmlModule, sanitizeEmailHtmlResult } from "@/lib/email-html";
import { EMAIL_ALLOWED_ATTRIBUTES, EMAIL_ALLOWED_TAGS, isRenderSafe, isStructurallySafe } from "@/lib/email/postcheck";
import { RenderPool, renderEmailBody } from "@/lib/email/render";

// Round 10 (security W1): the structural post-check lives in an import-free module, so the main
// thread can re-check worker output without loading the sanitizer.

describe("postcheck module", () => {
  it("has no imports at all", () => {
    const code = readFileSync(path.resolve(import.meta.dirname, "../src/lib/email/postcheck.ts"), "utf8");
    expect(code).not.toMatch(/^\s*import\b/m);
    expect(code).not.toMatch(/\brequire\(|\bimport\(/);
  });

  it("is the same function email-html.ts uses", () => {
    expect(fromHtmlModule).toBe(isStructurallySafe);
  });

  it("accepts sanitized shapes and rejects breakouts and unknown tags", () => {
    expect(isStructurallySafe('<p style="color:red">Hi <img alt="a" /></p><style>a{color:red}</style>')).toBe(true);
    expect(isStructurallySafe("<p>a &lt;script&gt;</p>")).toBe(true);
    expect(isStructurallySafe("<p>hi</p><script>alert(1)</script>")).toBe(false);
    expect(isStructurallySafe("<style>a{}</sty</style><img src=x onerror=alert(1)>")).toBe(false);
    expect(isStructurallySafe("<style>a{}")).toBe(false);
    expect(isStructurallySafe("<iframe src=x></iframe>")).toBe(false);
    expect(isStructurallySafe("<META http-equiv=refresh>")).toBe(false);
  });

  it("the allowlist includes style and the common email tags, and no active or loading tags", () => {
    for (const t of ["style", "table", "td", "img", "a", "p", "div", "span"]) expect(EMAIL_ALLOWED_TAGS).toContain(t);
    for (const t of ["script", "iframe", "object", "embed", "form", "input", "link", "meta", "base", "svg", "math"]) expect(EMAIL_ALLOWED_TAGS).not.toContain(t);
  });
});

// ---- Follow-up G1 (owner Q1): the render check -------------------------------------------------

describe("isRenderSafe: the allowlist copy", () => {
  it("EMAIL_ALLOWED_ATTRIBUTES equals the sanitizer's allowedAttributes", () => {
    expect(EMAIL_ALLOWED_ATTRIBUTES).toEqual(SANITIZER_ALLOWED_ATTRIBUTES);
  });
});

const both = ["default", "remote"] as const;

describe("isRenderSafe: accepts sanitizer-shaped output", () => {
  const good = [
    "",
    "plain text &amp; more &lt;b&gt;",
    '<p style="color:red;font-family:\'A B\'">Hi <b>x</b></p>',
    '<a href="https://e.example.org/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">x</a>',
    '<a href="mailto:a" target="_blank" rel="noopener noreferrer">m</a><a href="tel:1">t</a><a href="#frag">f</a><a href="relative/path">r</a>',
    '<a href="http://e.example.org/">h</a><a name="top"></a>',
    '<img src="data:image/png;base64,AAAA" alt="a" width="10" height="10" />',
    '<span class="alex-inline-image">[inline image: x]</span>',
    "<br /><hr /><table summary=\"s\" cellpadding=\"0\"><tbody><tr><td nowrap colspan=\"2\">x</td></tr></tbody></table>",
    '<style>a>b{color:red}@media (max-width:600px){.x{margin:0}}</style><div class="x" id="y" dir="ltr" lang="en">y</div>',
    '<font face="Arial" size="2" color="#fff">f</font><ol start="2" type="a"><li value="3">x</li></ol><ul type="disc"></ul>',
    '<p title="a &quot;q&quot; &lt;b&gt;">t</p>',
  ];
  for (const html of good) {
    it(JSON.stringify(html.slice(0, 60)), () => {
      for (const v of both) expect(isRenderSafe(html, v), v).toBe(true);
    });
  }

  it("remote images only in the remote variant", () => {
    const img = '<img src="https://e.example.org/a.png" srcset="https://e.example.org/a.png 1x, https://e.example.org/b.png 2x" />';
    expect(isRenderSafe(img, "remote")).toBe(true);
    expect(isRenderSafe(img, "default")).toBe(false);
  });
});

describe("isRenderSafe: rejects (per rule)", () => {
  const bad: [string, string][] = [
    ["event handler", '<img src="data:x" onerror="alert(1)" />'],
    ["ping", '<a href="https://e.example.org/" ping="https://t.example.org/">x</a>'],
    ["formaction", '<p formaction="https://e.example.org/">x</p>'],
    ["attribute allowed on another tag only", '<p href="https://e.example.org/">x</p>'],
    ["uppercase attribute", '<p ONCLICK="x">x</p>'],
    ["uppercase tag", "<P>x</P>"],
    ["javascript: href", '<a href="javascript:alert(1)">x</a>'],
    ["javascript: with control characters", `<a href="java${String.fromCharCode(9)}script:alert(1)">x</a>`],
    ["javascript: behind a numeric reference", '<a href="&#106;avascript:alert(1)">x</a>'],
    ["scheme colon behind a named reference", '<a href="javascript&colon;alert(1)">x</a>'],
    ["data: href", '<a href="data:text/html,x">x</a>'],
    ["protocol-relative href", '<a href="//e.example.org/">x</a>'],
    ["protocol-relative src", '<img src="//e.example.org/a.png" />'],
    ["vbscript: href", '<a href="VBScript:x">x</a>'],
    ["http image", '<img src="http://e.example.org/a.png" />'],
    ["unquoted value", "<p title=x>x</p>"],
    ["single-quoted value", "<p title='x'>x</p>"],
    ["@import in style text", "<style>@import 'x';</style>"],
    ["url() in style text", "<style>a{background:url(x)}</style>"],
    ["@font-face", "<style>@font-face{font-family:x}</style>"],
    ["backslash in style text", "<style>a{color:r\\65 d}</style>"],
    ["url() in a style attribute", '<p style="background:url(https://e.example.org/x)">x</p>'],
    ["URL() uppercase", '<p style="background:URL(x)">x</p>'],
    ["expression", '<p style="width:expression(1)">x</p>'],
    ["backslash in a style attribute via a reference", '<p style="color:r&#92;65d">x</p>'],
    ["double quote in style text", '<style>a{font-family:"x"}</style>'],
  ];
  for (const [name, html] of bad) {
    it(name, () => {
      for (const v of both) expect(isRenderSafe(html, v), v).toBe(false);
    });
  }

  it("srcset in the default variant, and non-https candidates in the remote variant", () => {
    expect(isRenderSafe('<img srcset="data:x 1x" />', "default")).toBe(false);
    expect(isRenderSafe('<img srcset="https://e.example.org/a.png 1x, http://e.example.org/b.png 2x" />', "remote")).toBe(false);
    expect(isRenderSafe('<img srcset="https://e.example.org/a.png 1x, data:x 2x" />', "remote")).toBe(false);
  });

  it("everything isStructurallySafe rejects", () => {
    for (const html of ["<p>hi</p><script>alert(1)</script>", "<style>a{}</sty</style><img src=x onerror=alert(1)>", "<style>a{}", "<iframe src=x></iframe>"]) {
      for (const v of both) expect(isRenderSafe(html, v), html).toBe(false);
    }
  });
});

describe("isRenderSafe: linear", () => {
  it("4 MiB of attributes, entities and CSS checks in well under a second", () => {
    const unit = '<p style="color:red;margin:0" title="a &amp; b &lt;c&gt;">x &amp; y</p><style>a>b{color:red}</style>';
    const html = unit.repeat(Math.floor((4 * 1024 * 1024) / unit.length));
    const t0 = performance.now();
    expect(isRenderSafe(html, "default")).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe("isRenderSafe: review round 2 (E1-E3), rejected in both variants", () => {
  const bad: [string, string][] = [
    // E1: CSS functions other than the colour functions (browsers fetch image-set candidates).
    ["image-set() in a style attribute", `<p style="background-image:image-set('https://e.example.org/a.png' 1x)">x</p>`],
    ["-webkit-image-set() in a style attribute", `<p style="background-image:-webkit-image-set('https://e.example.org/a.png' 1x)">x</p>`],
    ["image-set() in style text", "<style>a{background:image-set('https://e.example.org/a.png' 1x)}</style>"],
    ["image-set() in cursor", `<p style="cursor:image-set('https://e.example.org/c.png' 1x),auto">x</p>`],
    ["calc()", '<p style="width:calc(1px+2px)">x</p>'],
    ["var()", '<p style="color:var(--x)">x</p>'],
    ["attr() in style text", "<style>a{width:attr(x)}</style>"],
    ["uppercase function name", '<p style="color:RGB(1,2,3)">x</p>'],
    // E2: link target and rel exactly as the sanitizer forces them.
    ["target _top", '<a href="https://e.example.org/" target="_top" rel="noopener noreferrer">x</a>'],
    ["target _self", '<a href="https://e.example.org/" target="_self" rel="noopener noreferrer">x</a>'],
    ["rel opener", '<a href="https://e.example.org/" target="_blank" rel="opener">x</a>'],
    ["rel noopener only", '<a href="https://e.example.org/" target="_blank" rel="noopener">x</a>'],
    ["empty target", '<a href="https://e.example.org/" target rel="noopener noreferrer">x</a>'],
    // E3: image sources must have an allowed scheme.
    ["relative img src", '<img src="a.png" />'],
    ["root-relative img src", '<img src="/api/x" />'],
    ["fragment img src", '<img src="#x" />'],
    ["empty img src", "<img src />"],
    ["empty quoted img src", '<img src="" />'],
  ];
  for (const [name, html] of bad) {
    it(name, () => {
      for (const v of both) expect(isRenderSafe(html, v), v).toBe(false);
    });
  }

  it("still accepted: colour functions, @media parentheses, forced link attributes, relative href", () => {
    for (const html of [
      '<p style="color:rgb(1,2,3);background-color:rgba(1,2,3,0.5);border-color:hsl(1,2%,3%) hsla(1,2%,3%,0.5)">x</p>',
      "<style>@media (max-width:600px){a{color:rgb(1,2,3)}}</style>",
      '<a href="relative/path" target="_blank" rel="noopener noreferrer">x</a>',
      '<img src="data:image/png;base64,AAAA" alt="a" />',
    ]) {
      for (const v of both) expect(isRenderSafe(html, v), `${v}: ${html}`).toBe(true);
    }
    expect(isRenderSafe('<img src="https://e.example.org/a.png" />', "remote")).toBe(true);
  });
});

// ---- AC3: lying-worker cases end as text/postcheck ----------------------------------------------

describe("main thread: a well-formed worker reply that fails the render check is stored as text/postcheck", () => {
  const testWorker = path.resolve(import.meta.dirname, "helpers/test-render-worker.mjs");
  const pools: RenderPool[] = [];
  afterAll(async () => {
    for (const p of pools) await p.close();
  });
  const lie = async (html: string, remote: string | null) => {
    const p = new RenderPool({ workerPath: testWorker });
    pools.push(p);
    return renderEmailBody({ html: `__LIE__${JSON.stringify({ html, remote })}`, text: "fallback" }, { pool: p });
  };
  const cases: [string, string][] = [
    ["onerror", '<img src="data:x" onerror="alert(1)" />'],
    ["javascript: href", '<a href="javascript:alert(1)">x</a>'],
    ["@import in style text", "<style>@import 'https://e.example.org/x.css';</style>"],
    ["url() in style text", "<style>a{background:url(https://e.example.org/x)}</style>"],
    ["url() style attribute", '<p style="background:url(https://e.example.org/x)">x</p>'],
    ["ping", '<a href="https://e.example.org/" ping="https://t.example.org/">x</a>'],
  ];
  for (const [name, bad] of cases) {
    it(`${name}: default variant`, { timeout: 20_000 }, async () => {
      const r = await lie(`<p>ok</p>${bad}`, null);
      expect([r.renderKind, r.renderReason, r.renderedHtml, r.renderedHtmlRemote, r.renderedText]).toEqual(["text", "postcheck", null, null, "fallback"]);
    });
    it(`${name}: remote variant`, { timeout: 20_000 }, async () => {
      const r = await lie("<p>ok</p>", `<p>ok</p>${bad}`);
      expect([r.renderKind, r.renderReason]).toEqual(["text", "postcheck"]);
    });
  }

  it("a remote <img> in the default variant (allowed in the remote variant)", { timeout: 20_000 }, async () => {
    const img = '<img src="https://e.example.org/a.png" />';
    expect(await lie(`<p>${img}</p>`, null)).toMatchObject({ renderKind: "text", renderReason: "postcheck" });
    expect(await lie("<p>x</p>", `<p>${img}</p>`)).toMatchObject({ renderKind: "html", renderReason: null });
  });
});

// ---- AC3: zero false positives on real sanitizer output -----------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sanitizes in both variants and returns every ok output with its variant. */
function outputs(html: string): [string, "default" | "remote"][] {
  const out: [string, "default" | "remote"][] = [];
  const d = sanitizeEmailHtmlResult(html, { allowRemoteImages: false });
  if (d.ok) out.push([d.html, "default"]);
  const r = sanitizeEmailHtmlResult(html, { allowRemoteImages: true });
  if (r.ok) out.push([r.html, "remote"]);
  return out;
}

const ch = (code: number) => String.fromCharCode(code);

// The CSS token soup from tests/email-css.test.ts (18e), with the same seed.
const CSS_SOUP = [
  "a", "b", ".x", "#y", "*", ">", "+", "~", ",", ":", ";", "{", "}", "(", ")", "[", "]", " ", "\n", "\r", "\f", "\t",
  "color", "background", "margin", "font-family", "position", "red", "#fff", "1px", "2em", "50%", "0", "-1",
  "url(", "url(https://evil.example/x)", "url('data:x')", '"', "'", '"str"', "'s\n", "\\", "\\72", "\\0", "/*", "*/",
  "@media", "@import", "@font-face", "@", "<", "</style>", "!", "important", "rgb(1,2,3)", "calc(1px+2px)", "var(--x)",
  "expression(", "--x", "-webkit-", "mso-", "&", "|", "^", "$", "=", ch(0), ch(0xfffd), ch(0xe9), ch(0xd800),
];

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

describe("zero false positives: real sanitizer output always passes, in both variants", () => {
  it("the 10,000-case CSS token soup (18e corpus), as a style element and as a style attribute", { timeout: 300_000 }, () => {
    const rnd = mulberry32(20261118);
    let checked = 0;
    for (let n = 0; n < 10_000; n++) {
      const len = 1 + Math.floor(rnd() * 40);
      const parts: string[] = [];
      for (let k = 0; k < len; k++) parts.push(CSS_SOUP[Math.floor(rnd() * CSS_SOUP.length)]!);
      const s = parts.join("");
      for (const [out, v] of outputs(`<style>${s}</style><p style="${attr(s)}">x</p>`)) {
        checked += 1;
        expect(isRenderSafe(out, v), `${JSON.stringify(s)} -> ${JSON.stringify(out)}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  const TAGS = ["a", "img", "p", "div", "span", "table", "td", "font", "ol", "li", "style", "b", "script", "iframe", "svg", "form", "input", "noscript", "x-y", "o:p"];
  const NAMES = ["href", "src", "srcset", "style", "class", "title", "onerror", "onclick", "ping", "name", "target", "face", "start", "value", "data-x", "xmlns", "cite", "background", "ALT", "Width"];
  const VALUES = [
    "https://e.example.org/a.png", "http://e.example.org/", "javascript:alert(1)", "JaVaScRiPt:x", " java\tscript:x", "&#106;avascript:x", "data:image/png;base64,AA",
    "cid:abc", "mailto:a", "tel:1", "#x", "rel/path", "//e.example.org/", "\\\\e.example.org", "https://e.example.org/a.png 1x, http://e.example.org/b.png 2x",
    "https://e.example.org/a,b.png 2x", "color:red", "background:url(x)", "font-family:'A'", "a\"b", "a'b", "a<b>c", "a&b", "&amp;", "&lt;", "&quot;", "&colon;", "",
    "x\u0000y", "é", "expression(1)", "@import x",
  ];
  it("3,000 random documents with mixed tags, attributes and URL values", { timeout: 300_000 }, () => {
    const rnd = mulberry32(20261119);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    let checked = 0;
    for (let n = 0; n < 3_000; n++) {
      const parts: string[] = [];
      const len = 1 + Math.floor(rnd() * 12);
      for (let k = 0; k < len; k++) {
        const tag = pick(TAGS);
        const attrs: string[] = [];
        for (let a = Math.floor(rnd() * 4); a > 0; a--) {
          const q = pick(['"', "'", ""]);
          const value = pick(VALUES);
          attrs.push(` ${pick(NAMES)}=${q}${q === '"' ? value.replace(/"/g, "&quot;") : q === "'" ? value.replace(/'/g, "&#39;") : value.replace(/[\s>]/g, "")}${q}`);
        }
        parts.push(`<${tag}${attrs.join("")}>${pick(["x", "a &amp; b", "<", "", "&lt;script&gt;", "a{color:red}"])}${rnd() < 0.7 ? `</${tag}>` : ""}`);
      }
      for (const [out, v] of outputs(parts.join(""))) {
        checked += 1;
        expect(isRenderSafe(out, v), `${JSON.stringify(parts.join(""))} -> ${JSON.stringify(out)}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(3_000);
  });
});
