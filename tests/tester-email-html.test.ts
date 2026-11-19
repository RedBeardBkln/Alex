import { describe, expect, it } from "vitest";
import { emailDocument, sanitizeEmailHtml } from "@/lib/email-html";

// Tester-added bypass corpus for the email HTML sanitizer (plan section 8, AC 18).
const off = { allowRemoteImages: false };
const on = { allowRemoteImages: true };
const r = String.raw;

/** Any network-looking reference: scheme URLs, protocol-relative, backslash-relative, scheme-without-slashes. */
function networkRefs(html: string): string[] {
  // Link targets (<a href>) are navigations on click, not fetches; everything else counts.
  html = html.replace(/\shref="[^"]*"/gi, "");
  const found: string[] = [];
  for (const re of [
    /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/gi,
    /[\\/]{2}[a-z0-9.-]+\.example\.com/gi,
    /https?:[a-z0-9.-]+\.example\.com/gi,
  ]) {
    found.push(...(html.match(re) ?? []));
  }
  return found;
}

/** Markup outside <style> raw text (style contents are CSS text to the browser, never elements). */
function outsideStyle(html: string): string {
  return html.replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, "$1$2");
}

function assertInert(out: string) {
  const lower = out.toLowerCase();
  expect(lower).not.toMatch(/<script/);
  expect(outsideStyle(lower)).not.toMatch(/\son[a-z]+\s*=/);
  // A <style> may only appear in HTML context: no foreign (svg/math) or noscript/template wrapper survives.
  expect(lower).not.toMatch(/javascript:|vbscript:|data:text\/html/);
  expect(lower).not.toMatch(/<(iframe|frame|object|embed|form|input|button|link|meta|base|svg|math|video|audio|source|picture|template|noscript|xmp)\b/);
  expect(lower).not.toMatch(/formaction|xlink:href|ping=|poster=/);
}

const scriptCorpus = [
  r`<a href="jav&#x61;script:alert(1)">e1</a>`,
  r`<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">e2</a>`,
  "<a href=\"java\tscript:alert(1)\">e3</a>",
  r`<a href="java&#x09;script:alert(1)">e4</a>`,
  r`<a href="&#x6A;avascript&colon;alert(1)">e5</a>`,
  r`<a href="  javascript:alert(1)">e6</a>`,
  r`<A HREF="JaVaScRiPt:alert(1)">e7</A>`,
  r`<img src="&#0000106avascript:alert(1)">`,
  r`<svg><a xlink:href="javascript:alert(1)">x</a></svg>`,
  r`<button formaction="javascript:alert(1)">x</button>`,
  r`<form><button formaction="https://t.example.com">x</button></form>`,
  r`<style>a{} </style><img src=x onerror=alert(1)><style>`,
  r`<img src="https://ok.example.com/a.png" onload="alert(1)">`,
  r`<IMG SRC=x OnErRoR=alert(1)>`,
  r`<img src=x onerror  =  alert(1)>`,
  r`<div style="x:expression(alert(1))">x</div>`,
  r`<a href="data:text/html;base64,PHNjcmlwdD4=">d</a>`,
  r`<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  r`<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>`,
  r`<svg><style><img src=x onerror=alert(1)></style></svg>`,
  r`<noscript><img src=x onerror=alert(1)></noscript>`,
  r`<img src="cid:x" alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">`,
];

const remoteCorpus = [
  r`<svg><image href="https://t.example.com/x.png"/></svg>`,
  r`<base href="https://t.example.com/">`,
  r`<meta http-equiv="refresh" content="0;url=https://t.example.com">`,
  r`<link rel=stylesheet href="https://t.example.com/a.css">`,
  r`<input type="image" src="https://t.example.com/a.png">`,
  r`<img src="\\t.example.com/a.png">`,
  r`<img src="/\t.example.com/a.png">`,
  "<img src=\"/\t/t.example.com/tab.png\">",
  r`<img src="http:t.example.com/a.png">`,
  r`<img src="https:t.example.com/a.png">`,
  r`<img src=" https://t.example.com/a.png">`,
  r`<img src="HTTPS://t.example.com/a.png">`,
  r`<img src="h&#116;tps://t.example.com/a.png">`,
  r`<img srcset="data:image/png;base64,AA 1x, https://t.example.com/ss.png 2x">`,
  r`<img src="x" style="background:url(https://t.example.com/s.png)">`,
  r`<a href="https://ok.example.org" style="background:url(https://t.example.com/s.png)">x</a>`,
  r`<div style="background:url( &quot; https://t.example.com/q.png &quot; )">x</div>`,
  r`<div style="background:url(  'https://t.example.com/q.png'  )">x</div>`,
  r`<div style="background:url(/**/https://t.example.com/c.png)">x</div>`,
  r`<div style="background:url(/**/&quot;https://t.example.com/c.png&quot;)">x</div>`,
  r`<div style="background:u&#114;l(https://t.example.com/e.png)">x</div>`,
  r`<div style="background:\75 \72 \6c (https://t.example.com/e.png)">x</div>`,
  r`<div style="background:url(https://t.example.com/a.png" >x</div>`,
  r`<div style="behavior:url(https://t.example.com/x.htc)">x</div>`,
  r`<style>.a{background:url(  "https://t.example.com/s1.png"  )}</style>`,
  r`<style>.a{background:url(/**/"https://t.example.com/s2.png")}</style>`,
  r`<style>@IMPORT "https://t.example.com/i.css";</style>`,
  r`<style>@\69mport "https://t.example.com/i2.css";</style>`,
  r`<style>@im\port url(https://t.example.com/i3.css);</style>`,
  r`<style>@import/**/"https://t.example.com/i4.css";</style>`,
  r`<style>.x{content:url(https://t.example.com/c.png)}</style>`,
  r`<style>.x{cursor:url(https://t.example.com/c.cur),auto}</style>`,
  r`<style>.x{border-image:url(https://t.example.com/b.png) 30}</style>`,
  r`<style>.x{background:image-set(url(https://t.example.com/is.png) 1x)}</style>`,
  r`<style>.x{-webkit-mask:url(https://t.example.com/m.svg)}</style>`,
  r`<style>@font-face{font-family:f;src:url(https://t.example.com/f.woff) format("woff")}</style>`,
  r`<style></style><style>.x{background:url(https://t.example.com/2nd.png)}</style>`,
  r`<p><style>.x{background:url(https://t.example.com/nested.png)}</style></p>`,
  r`<svg><style>.x{background:url(https://t.example.com/svgstyle.png)}</style></svg>`,
  r`<style><!--</style><img src="https://t.example.com/cm.png">--></style>`,
  r`<math><style><img src="https://t.example.com/math.png"></style></math>`,
  r`<noscript><img src="https://t.example.com/ns.png"></noscript>`,
  r`<template><img src="https://t.example.com/tpl.png"></template>`,
  r`<table background="//t.example.com/bg.png"><tr><td>x</td></tr></table>`,
  r`<td background=" https://t.example.com/bg.png">x</td>`,
  r`<td background="http:t.example.com/bg.png">x</td>`,
  r`<body background="https://t.example.com/body.png">x</body>`,
  r`<video poster="https://t.example.com/p.png"></video>`,
  r`<audio src="https://t.example.com/a.mp3"></audio>`,
  r`<picture><source srcset="https://t.example.com/p.png"><img></picture>`,
  r`<a href="https://ok.example.org" ping="https://t.example.com/ping">x</a>`,
  r`<object data="https://t.example.com/o"></object>`,
  r`<embed src="https://t.example.com/e">`,
  r`<iframe src="https://t.example.com/f"></iframe>`,
];

describe("sanitizer bypass corpus: nothing executable survives (either mode)", () => {
  for (const input of [...scriptCorpus, ...remoteCorpus]) {
    it(`inert: ${input.slice(0, 70)}`, () => {
      assertInert(sanitizeEmailHtml(input, off));
      assertInert(sanitizeEmailHtml(input, on));
    });
  }
});

describe("sanitizer bypass corpus: no remote reference survives by default", () => {
  for (const input of remoteCorpus) {
    it(`blocked: ${input.slice(0, 70)}`, () => {
      const out = sanitizeEmailHtml(input, off);
      expect(networkRefs(out)).toEqual([]);
      expect(out.toLowerCase()).not.toMatch(/url\s*\(\s*['"]?\s*(?:https?:)?[\\/]/);
      expect(out.toLowerCase()).not.toMatch(/@import/);
    });
  }

  it("the full srcdoc document for the corpus has no remote reference outside the CSP", () => {
    const doc = emailDocument(remoteCorpus.join("\n"), off);
    const withoutCsp = doc.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
    expect(networkRefs(withoutCsp)).toEqual([]);
  });
});

describe("remote toggle re-enables only https images", () => {
  it("http, protocol-relative and backslash-relative images stay blocked when on", () => {
    for (const input of [
      r`<img src="http://t.example.com/a.png">`,
      r`<img src="//t.example.com/a.png">`,
      r`<img src="\\t.example.com/a.png">`,
      r`<img src="http:t.example.com/a.png">`,
      r`<td background="http://t.example.com/bg.png">x</td>`,
      r`<td background="//t.example.com/bg.png">x</td>`,
      r`<div style="background:url(http://t.example.com/a.png)">x</div>`,
      r`<div style="background:url(//t.example.com/a.png)">x</div>`,
      r`<style>.y{background:url(http://t.example.com/h.png)}</style>`,
      r`<style>@import url(https://t.example.com/x.css);</style>`,
    ]) {
      const out = sanitizeEmailHtml(input, on);
      expect(out, input).not.toMatch(/t\.example\.com/);
    }
  });

  it("srcset keeps only https candidates when on", () => {
    const out = sanitizeEmailHtml(
      r`<img srcset="http://t.example.com/h.png 1x, //t.example.com/pr.png 2x, https://ok.example.org/k.png 3x">`,
      on,
    );
    expect(out).toContain("https://ok.example.org/k.png 3x");
    expect(out).not.toContain("t.example.com");
  });

  it("Revision 3: with the toggle only <img> https comes back; background attribute and CSS url() stay gone", () => {
    const html = r`<img src="https://ok.example.org/a.png"><td background="https://ok.example.org/bg.png">x</td><style>.x{background:url(https://ok.example.org/s.png)}</style>`;
    const outOn = sanitizeEmailHtml(html, on);
    expect(outOn).toContain('src="https://ok.example.org/a.png"');
    for (const out of [outOn, sanitizeEmailHtml(html, off)]) {
      expect(out).not.toContain("background=");
      expect(out).not.toContain("bg.png");
      expect(out).not.toMatch(/url\(/i);
      expect(out).not.toContain("s.png");
    }
  });

  it("image-set never survives, in either mode", () => {
    for (const opts of [off, on]) {
      const out = sanitizeEmailHtml(r`<style>.x{background:image-set(url(https://ok.example.org/i.png) 1x)}</style>`, opts);
      expect(out).not.toMatch(/image-set|url\(|ok\.example\.org/i);
    }
  });
});

describe("image sources: only data: by default, plus absolute https: with the toggle (round-2 D4 fix)", () => {
  // Sources that are never allowed in either mode: relative (would resolve against the app's own
  // origin in a srcdoc iframe), protocol-relative, backslash-relative, http, other schemes.
  const neverAllowed = [
    "/api/health",
    "api/health",
    "./x.png",
    "../x.png",
    "?logout=1",
    "#frag",
    "x.png",
    "//t.example.com/a.png",
    "\\\\t.example.com/a.png",
    "/\\t.example.com/a.png",
    "http://t.example.com/a.png",
    "http:t.example.com/a.png",
    "https:t.example.com/a.png",
    "https:/t.example.com/a.png",
    "ftp://t.example.com/a.png",
    "blob:https://t.example.com/uuid",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "about:blank",
  ];
  const stripped = (html: string, needle: string) => expect(html, needle).not.toContain(needle);

  for (const url of neverAllowed) {
    it(`never allowed in either mode: ${url}`, () => {
      for (const opts of [off, on]) {
        stripped(sanitizeEmailHtml(`<img src="${url}">`, opts), url);
        stripped(sanitizeEmailHtml(`<img srcset="${url} 1x">`, opts), url);
        stripped(sanitizeEmailHtml(`<table background="${url}"><tr><td background="${url}">x</td></tr></table>`, opts), url);
        stripped(sanitizeEmailHtml(`<div style="background:url(${url})">x</div>`, opts), url);
        stripped(sanitizeEmailHtml(`<div style="background-image:url('${url}')">x</div>`, opts), url);
        stripped(sanitizeEmailHtml(`<style>.x{background:url("${url}")}</style>`, opts), url);
      }
    });
  }

  it("absolute https is removed by default from src, srcset, background and CSS url()", () => {
    const u = "https://t.example.com/a.png";
    stripped(sanitizeEmailHtml(`<img src="${u}">`, off), u);
    stripped(sanitizeEmailHtml(`<img srcset="${u} 1x, ${u} 2x">`, off), u);
    stripped(sanitizeEmailHtml(`<td background="${u}">x</td>`, off), u);
    stripped(sanitizeEmailHtml(`<div style="background:url(${u})">x</div>`, off), u);
    stripped(sanitizeEmailHtml(`<style>.x{background:url(${u})}</style>`, off), u);
  });

  it("Revision 3: absolute https comes back with the toggle in <img src/srcset> only; background and CSS url() never", () => {
    const u = "https://ok.example.org/a.png";
    expect(sanitizeEmailHtml(`<img src="${u}">`, on)).toContain(`src="${u}"`);
    expect(sanitizeEmailHtml(`<img srcset="${u} 2x">`, on)).toContain(`${u} 2x`);
    for (const opts of [off, on]) {
      stripped(sanitizeEmailHtml(`<td background="${u}">x</td>`, opts), u);
      stripped(sanitizeEmailHtml(`<div style="background:url(${u})">x</div>`, opts), u);
      stripped(sanitizeEmailHtml(`<style>.x{background:url(${u})}</style>`, opts), u);
    }
  });

  it("srcset with the toggle keeps only https candidates, dropping relative and http ones", () => {
    const out = sanitizeEmailHtml(`<img srcset="/rel.png 1x, http://t.example.com/h.png 2x, https://ok.example.org/k.png 3x">`, on);
    expect(out).toContain("https://ok.example.org/k.png 3x");
    expect(out).not.toContain("/rel.png");
    expect(out).not.toContain("t.example.com");
  });

  it("Revision 3: data: images are kept in <img src> in both modes; background attribute and CSS url(data:) are dropped; srcset dropped by default", () => {
    const d = "data:image/png;base64,iVBORw0KGgo=";
    for (const opts of [off, on]) {
      expect(sanitizeEmailHtml(`<img src="${d}">`, opts)).toContain(`src="${d}"`);
      expect(sanitizeEmailHtml(`<td background="${d}">x</td>`, opts)).not.toContain("background=");
      const out = sanitizeEmailHtml(`<div style="background:url(${d})">x</div>`, opts);
      expect(out).not.toMatch(/url\(|data:/i);
    }
    expect(sanitizeEmailHtml(`<img srcset="${d} 1x">`, off)).not.toContain("srcset");
  });

  it("a kept data: url() can't smuggle a remote url() next to it", () => {
    for (const opts of [off, on]) {
      const out = sanitizeEmailHtml(
        `<div style="background:url(data:image/png;base64,AA),url(http://t.example.com/a.png)">x</div><style>.x{background:url("data:image/png;base64,AA")https://t.example.com/b.png)}</style>`,
        opts,
      );
      expect(out).not.toContain("t.example.com");
    }
  });
});

