import { describe, expect, it, vi } from "vitest";
import { emailDocument, isStructurallySafe, sanitizeCss, sanitizeEmailHtml } from "@/lib/email-html";

// Tester round 4: attacks on the S1/S2 sanitizer fixes, checked with an independent model of the
// HTML tokenizer rules that matter here (not the implementation's own isStructurallySafe).

const off = { allowRemoteImages: false };
const on = { allowRemoteImages: true };
const r = String.raw;

const ALLOWED = new Set([
  "a", "abbr", "address", "article", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite",
  "code", "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark",
  "ol", "p", "pre", "q", "s", "samp", "section", "small", "span", "strike", "strong", "style", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "var", "wbr",
]);

/**
 * Browser-rule tokenizer (HTML spec, data state + "rawtext" for <style>): a tag opens at `<` followed
 * by an ASCII letter, `/`+letter, `!` or `?`; a <style> element's text ends at `</style` followed by
 * tab, LF, FF, CR, space, `/` or `>` (case-insensitive). Attribute values are skipped with quote
 * handling. Returns every tag name seen, plus the raw text of each style element.
 */
function browserTokens(html: string): { tags: string[]; styleTexts: string[]; markupDecls: number } {
  const tags: string[] = [];
  const styleTexts: string[] = [];
  let markupDecls = 0;
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] !== "<") {
      i++;
      continue;
    }
    const next = html[i + 1] ?? "";
    if (next === "!" || next === "?") {
      markupDecls++;
      const end = html.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = next === "/";
    const start = closing ? i + 2 : i + 1;
    if (!/[A-Za-z]/.test(html[start] ?? "")) {
      i++;
      continue;
    }
    let j = start;
    while (j < n && !/[\t\n\f\r />]/.test(html[j]!)) j++;
    const name = html.slice(start, j).toLowerCase();
    // skip attributes with quote awareness
    let q: string | null = null;
    while (j < n) {
      const c = html[j]!;
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
      j++;
    }
    tags.push(closing ? `/${name}` : name);
    i = j + 1;
    if (!closing && name === "style") {
      const re = /<\/style[\t\n\f\r />]/gi;
      re.lastIndex = i;
      const m = re.exec(html);
      const end = m ? m.index : n;
      styleTexts.push(html.slice(i, end));
      i = end;
    }
  }
  return { tags, styleTexts, markupDecls };
}

/** The output with each <style> element's raw text removed (browser rule), i.e. markup only. */
function markupOnly(out: string): string {
  let markup = "";
  let pos = 0;
  const open = /<style\b[^>]*>/gi;
  for (let m = open.exec(out); m; m = open.exec(out)) {
    const textStart = m.index + m[0].length;
    const close = /<\/style[\t\n\f\r />]/gi;
    close.lastIndex = textStart;
    const c = close.exec(out);
    markup += out.slice(pos, textStart);
    pos = c ? c.index : out.length;
    open.lastIndex = pos;
  }
  markup += out.slice(pos);
  return markup;
}

function assertSafe(out: string, label: string) {
  const t = browserTokens(out);
  const bad = t.tags.map((x) => x.replace(/^\//, "")).filter((x) => !ALLOWED.has(x));
  expect(bad, `${label}\n${out}`).toEqual([]);
  expect(t.markupDecls, label).toBe(0);
  for (const s of t.styleTexts) expect(s.includes("<"), `${label}: '<' in style text`).toBe(false);
  // Event-handler attribute *names* only: quoted attribute values are blanked first (they are inert text).
  expect(markupOnly(out).toLowerCase().replace(/"[^"]*"|'[^']*'/g, '""'), label).not.toMatch(/\son[a-z]+\s*=/);
  expect(isStructurallySafe(out), `${label}: own check`).toBe(true);
}

/**
 * No fetch-capable reference to the attacker host: attribute values (src, srcset, background, href,
 * data, action, content) or CSS url(). Plain CSS text inside a <style> is inert. With the remote
 * toggle, an https <img src> is allowed (that is the toggle's purpose).
 */
function noFetchRefs(out: string, remote: boolean, label: string) {
  const markup = markupOnly(out);
  const attrs = [...markup.matchAll(/\s(src|srcset|background|href|data|action|content|poster)="([^"]*)"/gi)];
  for (const [whole, name, value] of attrs) {
    if (!/e\.example\.com/.test(value!)) continue;
    const allowed = remote && name!.toLowerCase() === "src" && /^https:\/\//i.test(value!);
    expect(allowed, `${label}: ${whole}`).toBe(true);
  }
  expect(out, label).not.toMatch(/url\s*\([^)]*e\.example\.com/i);
}

const CLOSERS = [
  r`</sty\le>`,
  "</sty\u0000le>",
  "</sty@import x;le>",
  r`</STY\LE >`,
  // tester variants
  "</STYLE >",
  "</style/>",
  "</style/",
  "</style\t>",
  "</style\n>",
  "</StYlE>",
  "</sty&#108;e>",
  r`</sty\6c e>`,
  "</sty/* x */le>",
  "</sty/*le>",
  "</sty@IMPORT 'x';le>",
  '</sty@import url("x")le>',
  "</styhttp://x.example.com/le>",
  "</styhttps:&#x2f;&#x2f;le>",
  "</styjavascript:le>",
  "</styurl(x)le>",
  "</styexpression(le>",
  "<</style>>",
  r`<\/style>`,
  r`\3c /style>`,
  "</sty\u0000\u0000le\u0000>",
  r`</s\t\y\l\e>`,
  "</\u0000style>",
  "</ style>",
];

const INJECT = [
  '<meta http-equiv="refresh" content="0;url=https:&#x2f;&#x2f;e.example.com/opened">',
  '<img src="http:&#x2f;&#x2f;e.example.com/a.gif">',
  '<img src="https:&#x2f;&#x2f;e.example.com/b.gif">',
  '<img src="http:e.example.com/c.gif">',
  '<link rel="stylesheet" href="https://e.example.com/s.css">',
  '<link rel="dns-prefetch" href="//e.example.com">',
  '<iframe src="https://e.example.com/f"></iframe>',
  '<object data="https://e.example.com/o"></object>',
  '<form action="https://e.example.com/f"><input name="p"></form>',
  '<base href="https://e.example.com/">',
  '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<!--<img src=https://e.example.com/c.gif>-->",
];

describe("S1: style-element breakout attempts (security-review payloads plus tester variants)", () => {
  for (const closer of CLOSERS) {
    for (const opts of [off, on]) {
      it(`${JSON.stringify(closer)} ${opts.allowRemoteImages ? "remote" : "default"}`, () => {
        for (const inj of INJECT) {
          const input = `<style>a{color:red}${closer}${inj}</style><p>after</p>`;
          const out = sanitizeEmailHtml(input, opts);
          assertSafe(out, JSON.stringify(input));
          noFetchRefs(out, opts.allowRemoteImages, input);
        }
      });
    }
  }

  it("nested svg/math/table/select/noscript/template <style> wrappers", () => {
    const wrappers = [
      ["<svg>", "</svg>"],
      ["<math>", "</math>"],
      ["<svg><foreignObject>", "</foreignObject></svg>"],
      ["<math><mtext><table><mglyph>", "</mglyph></table></mtext></math>"],
      ["<table>", "</table>"],
      ["<select>", "</select>"],
      ["<noscript>", "</noscript>"],
      ["<template>", "</template>"],
      ["<textarea>", "</textarea>"],
      ["<title>", "</title>"],
      ["<xmp>", "</xmp>"],
      ["<iframe>", "</iframe>"],
      ["<noembed>", "</noembed>"],
    ];
    for (const [a, b] of wrappers) {
      for (const inj of INJECT) {
        for (const closer of ["</style>", r`</sty\le>`]) {
          const input = `${a}<style>x{}${closer}${inj}</style>${b}`;
          for (const opts of [off, on]) {
            const out = sanitizeEmailHtml(input, opts);
            assertSafe(out, input);
            noFetchRefs(out, opts.allowRemoteImages, input);
          }
        }
      }
    }
  });

  it("'<' smuggled into style text via entities, CSS escapes, attribute styles and removals next to '<' or '/'", () => {
    const inputs = [
      "<style>&lt;/style&gt;<img src=x onerror=1></style>",
      r`<style>\3c /style\3e <img src=x onerror=1></style>`,
      r`<style>\</style>`,
      r`<style><\/style><img src=x onerror=1></style>`,
      "<style><@import x;/style><img src=x onerror=1></style>",
      "<style>@import x;</style><img src=x onerror=1>",
      '<div style="x:&lt;/style&gt;&lt;img src=x onerror=1&gt;">t</div>',
      '<div style="x:</style><img src=x onerror=1>">t</div>',
      r`<div style="x:\3c /style>">t</div>`,
      "<style>/*</style>*/<img src=x onerror=1></style>",
      "<style>a{content:'</style><img src=x onerror=1>'}</style>",
      '<style>a{content:"\\"</style><img src=x onerror=1>"}</style>',
    ];
    for (const input of inputs) {
      for (const opts of [off, on]) assertSafe(sanitizeEmailHtml(input, opts), input);
    }
  });

  it("sanitizeCss output never contains '<' and never forms '</style' (randomised fragments)", () => {
    const parts = ["<", "/", "s", "t", "y", "l", "e", ">", "\\", "\u0000", "/*", "*/", "@import x;", "url(", ")", "http://", " ", "S", "T", "Y", "L", "E", ":", "&#x2f;"];
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    for (let k = 0; k < 3000; k++) {
      let css = "";
      for (let j = 0; j < 30; j++) css += parts[Math.floor(rand() * parts.length)];
      for (const opts of [off, on]) {
        const out = sanitizeCss(css, opts);
        expect(out.includes("<"), JSON.stringify(css)).toBe(false);
        const doc = sanitizeEmailHtml(`<style>${css}</style><p>x</p>`, opts);
        assertSafe(doc, JSON.stringify(css));
      }
    }
  });
});

describe("structural post-check forces the plain-text fallback", () => {
  it("isStructurallySafe rejects breakouts and unknown markup", () => {
    for (const s of [
      "<style>a{}</style><meta http-equiv=refresh content=0>",
      "<style>a<b</style>",
      "<style>a{}",
      "<style",
      "<svg></svg>",
      "<!-- x -->",
      "<p><iframe></iframe></p>",
      "</script>",
    ]) {
      expect(isStructurallySafe(s), s).toBe(false);
    }
    expect(isStructurallySafe("<p>hi</p><style>a{}</style><img src=\"data:x\">")).toBe(true);
  });

  // Revision 4 (R4.9): textOnly is gone. A post-check failure must now be reported as a failure result
  // (renderEmailBody then stores Alex's linear plain text: see tester-email-r9 "postcheck from the
  // worker"), and the breakout must never come out of the sanitizer.
  it("when the check fails, sanitizeEmailHtmlResult reports postcheck and nothing of the breakout is returned (mocked sanitize-html)", async () => {
    vi.resetModules();
    vi.doMock("sanitize-html", async (importOriginal) => {
      const real = ((await importOriginal()) as { default: (h: string, o?: unknown) => string }).default;
      let calls = 0;
      const fake = (h: string, o?: unknown) => {
        calls++;
        // First call is the main sanitize pass: simulate a sanitizer bug that emits a breakout.
        if (calls === 1) return '<style>a{}</style><meta http-equiv="refresh" content="0"><img src="https://e.example.com/x">';
        return real(h, o);
      };
      return { default: Object.assign(fake, real) };
    });
    const mod = await import("@/lib/email-html");
    const result = mod.sanitizeEmailHtmlResult("<p>Hello <b>there</b></p><script>x</script>", off);
    vi.doUnmock("sanitize-html");
    vi.resetModules();
    expect(result).toEqual({ ok: false, reason: "postcheck" });
  });

  it("the string wrapper returns '' on a post-check failure (never the breakout)", async () => {
    vi.resetModules();
    vi.doMock("sanitize-html", async (importOriginal) => {
      const real = ((await importOriginal()) as { default: (h: string, o?: unknown) => string }).default;
      let calls = 0;
      const fake = (h: string, o?: unknown) => {
        calls++;
        if (calls === 1) return '<style>a{}</style><meta http-equiv="refresh" content="0"><img src="https://e.example.com/x">';
        return real(h, o);
      };
      return { default: Object.assign(fake, real) };
    });
    const mod = await import("@/lib/email-html");
    const out = mod.sanitizeEmailHtml("<p>Hello <b>there</b></p><script>x</script>", off);
    vi.doUnmock("sanitize-html");
    vi.resetModules();
    expect(out).toBe("");
    expect(browserTokens(out).tags).toEqual([]);
  });
});

describe("S2: remote mode keeps https url() only for image-bearing properties", () => {
  const U = "https://ok.example.org/x.png";
  const blocked = [
    `@font-face{font-family:f;src:url(${U})}`,
    `@font-face{font-family:f;src:local(a),url(${U}) format("woff")}`,
    `@namespace url(${U});`,
    `@namespace svg url(${U});`,
    `a{-moz-binding:url(${U})}`,
    `a{cursor:url(${U}),auto}`,
    `a{filter:url(${U}#f)}`,
    `a{mask:url(${U})}`,
    `a{mask-image:url(${U})}`,
    `a{-webkit-mask-image:url(${U})}`,
    `a{content:url(${U})}`,
    `a{behavior:url(${U})}`,
    `a{offset-path:url(${U})}`,
    `a{clip-path:url(${U})}`,
    `a{shape-outside:url(${U})}`,
    `a{--x:url(${U});background:var(--x)}`,
    `a{cursor/*;background:*/:url(${U})}`,
    `a{cursor:"x" url(${U})}`,
    `a{background :1;cursor:url(${U})}`,
    `@media screen{a{cursor:url(${U})}}`,
    `@supports (cursor:url(${U})){a{}}`,
    `a{BACKGROUND-ATTACHMENT:fixed;cursor:url(${U})}`,
    `a{list-style-type:x;mask:url(${U})}`,
  ];
  for (const css of blocked) {
    it(`blocked in both modes: ${css}`, () => {
      for (const opts of [off, on]) {
        expect(sanitizeEmailHtml(`<style>${css}</style>`, opts), css).not.toContain("ok.example.org");
        const attr = css.replace(/^[^{]*\{/, "").replace(/\}+$/, "");
        expect(sanitizeEmailHtml(`<div style='${attr}'>x</div>`, opts), attr).not.toContain("ok.example.org");
      }
    });
  }

  it("Revision 3: image properties never keep a url() in either mode, and CSS output is identical between modes", () => {
    for (const p of ["background", "background-image", "list-style", "list-style-image", "border-image", "border-image-source", "-webkit-border-image", "BACKGROUND", " background "]) {
      const css = `a{${p}:url(${U})}`;
      const outOn = sanitizeEmailHtml(`<style>${css}</style>`, on);
      const outOff = sanitizeEmailHtml(`<style>${css}</style>`, off);
      expect(outOn, css).not.toContain("ok.example.org");
      expect(outOff, css).not.toContain("ok.example.org");
      expect(outOn, css).toBe(outOff);
    }
  });

  it("Revision 3: the meta CSP has no font-src; only img-src differs between modes", () => {
    expect(emailDocument("<p>x</p>", off)).toContain(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`);
    expect(emailDocument("<p>x</p>", on)).toContain(`content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'"`);
    for (const opts of [off, on]) expect(emailDocument("<p>x</p>", opts)).not.toContain("font-src");
  });
});

describe("timing: hostile but small inputs must sanitize quickly (thread view renders on the server)", () => {
  const time = (html: string, opts = off) => {
    const s = performance.now();
    sanitizeEmailHtml(html, opts);
    return performance.now() - s;
  };

  it("an unterminated url( followed by 3,000 spaces (3 KB) takes under 500 ms", { timeout: 120_000 }, () => {
    expect(time(`<style>a{background:url(${" ".repeat(3000)}x</style>`)).toBeLessThan(500);
  });

  it("the same in a style attribute takes under 500 ms", { timeout: 120_000 }, () => {
    expect(time(`<div style="background:url(${" ".repeat(3000)}x">t</div>`)).toBeLessThan(500);
  });

  it("11,000 url(data:x) with no separators (121 KB, under the 128 K CSS cap so it is really parsed) takes under 1 s", { timeout: 120_000 }, () => {
    const css = `a{background:${"url(data:x)".repeat(11000)}}`;
    expect(css.length).toBeLessThanOrEqual(128 * 1024);
    expect(time(`<style>${css}</style>`)).toBeLessThan(1000);
  });

  it("a realistic 0.5 MB newsletter takes under 1 s", { timeout: 120_000 }, () => {
    const big = ('<p style="color:red;background:url(https://x.example.com/a.png)">Hello <b>world</b> ' + "lorem ipsum ".repeat(20) + "</p>").repeat(2000);
    expect(time(big)).toBeLessThan(1000);
  });
});
