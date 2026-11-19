import { describe, expect, it } from "vitest";
import { EMAIL_IFRAME_SANDBOX, emailCsp, emailDocument, sanitizeCss, sanitizeEmailHtml } from "@/lib/email-html";

const off = { allowRemoteImages: false };
const on = { allowRemoteImages: true };

/** Every substring that would make a browser fetch from the network. */
function remoteRefs(html: string): string[] {
  return html.match(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"')<>]*/gi) ?? [];
}

describe("sanitizeEmailHtml: scripts and active content", () => {
  const corpus = [
    "<script>alert(1)</script>",
    "<SCRIPT SRC=//evil.example.com/x.js></SCRIPT>",
    '<img src="x" onerror="alert(1)">',
    '<body onload="alert(1)">hi</body>',
    '<div onclick="alert(1)" onmouseover="alert(2)">x</div>',
    '<svg onload="alert(1)"><script>alert(2)</script></svg>',
    '<iframe src="https://evil.example.com"></iframe>',
    '<object data="https://evil.example.com/x.swf"></object>',
    '<embed src="https://evil.example.com/x.swf">',
    '<form action="https://evil.example.com"><input name="p"><button>Go</button></form>',
    '<link rel="stylesheet" href="https://evil.example.com/x.css">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example.com">',
    '<base href="https://evil.example.com/">',
    "<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math>",
    "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\"></noscript>",
    "<textarea><script>alert(1)</script></textarea>",
  ];

  for (const input of corpus) {
    it(`neutralises ${input.slice(0, 50)}`, () => {
      const out = sanitizeEmailHtml(input, off).toLowerCase();
      expect(out).not.toMatch(/<script/);
      expect(out).not.toMatch(/\son[a-z]+\s*=/);
      expect(out).not.toMatch(/<(iframe|object|embed|form|input|button|link|meta|base|svg|math|textarea)\b/);
      expect(out).not.toContain("javascript:");
    });
  }

  it("removes javascript:, data: and vbscript: links but keeps http(s)/mailto", () => {
    const out = sanitizeEmailHtml(
      '<a href="javascript:alert(1)">a</a><a href=" JaVaScRiPt:alert(1)">b</a><a href="data:text/html,<script>alert(1)</script>">c</a><a href="vbscript:x">d</a><a href="https://example.com/ok">e</a><a href="mailto:a@example.com">f</a>',
      off,
    );
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out).not.toContain("data:text/html");
    expect(out).not.toContain("vbscript:");
    expect(out).toContain('href="https://example.com/ok"');
    expect(out).toContain('href="mailto:a@example.com"');
  });

  it("forces links to open in a new tab without opener or referrer", () => {
    const out = sanitizeEmailHtml('<a href="https://example.com" target="_self" rel="opener">x</a>', off);
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain("_self");
  });

  it("drops <title> and <head> text instead of showing it", () => {
    const out = sanitizeEmailHtml("<html><head><title>Secret title</title></head><body><p>Hello</p></body></html>", off);
    expect(out).not.toContain("Secret title");
    expect(out).toContain("<p>Hello</p>");
  });
});

describe("sanitizeEmailHtml: remote content blocked by default", () => {
  const remoteCorpus = [
    '<img src="https://tracker.example.com/pixel.gif">',
    '<img src="http://tracker.example.com/pixel.gif">',
    '<img src="//tracker.example.com/pixel.gif">',
    '<img srcset="https://tracker.example.com/a.png 1x, https://tracker.example.com/b.png 2x">',
    '<table background="https://tracker.example.com/bg.png"><tr><td background="http://tracker.example.com/bg2.png">x</td></tr></table>',
    '<div style="background:url(https://tracker.example.com/bg.png)">x</div>',
    "<div style=\"background-image: url('https://tracker.example.com/bg.png')\">x</div>",
    '<div style="background-image: URL( "https://tracker.example.com/bg.png" )">x</div>',
    '<div style="background: image-set(&quot;https://tracker.example.com/x.png&quot; 1x)">x</div>',
    '<div style="background:u\\72l(https://tracker.example.com/esc.png)">x</div>',
    "<style>@import url(https://tracker.example.com/x.css); body{color:red}</style>",
    "<style>@import 'https://tracker.example.com/y.css';</style>",
    "<style>.a{background:url(https://tracker.example.com/s.png)} @font-face{font-family:x;src:url(https://tracker.example.com/f.woff)}</style>",
    "<style>.b{background:-webkit-image-set('https://tracker.example.com/i.png' 1x)}</style>",
    "<style>.c{background:\\75rl(https://tracker.example.com/escaped.png)}</style>",
  ];

  for (const input of remoteCorpus) {
    it(`no remote reference survives: ${input.slice(0, 60)}`, () => {
      const out = sanitizeEmailHtml(input, off);
      expect(remoteRefs(out)).toEqual([]);
      expect(out.toLowerCase()).not.toMatch(/url\s*\(\s*['"]?\s*(https?:)?\/\//);
    });
  }

  it("keeps ordinary styling", () => {
    const out = sanitizeEmailHtml('<p style="color: red; font-weight: bold">x</p><style>p { margin: 0 }</style>', off);
    expect(out).toContain('style="color:red;font-weight:bold"');
    expect(out).toContain("<style>p{margin:0}</style>"); // regenerated in canonical form (Revision 3)
  });

  it("keeps data: images and replaces cid: images with a placeholder", () => {
    const out = sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"><img src="cid:logo@x" alt="Logo">', off);
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(out).not.toContain("cid:");
    expect(out).toContain("[inline image: Logo]");
  });
});

describe("sanitizeEmailHtml: remote images toggle", () => {
  it("keeps https <img> src and srcset when allowed; background attribute and CSS url() stay blocked (Revision 3)", () => {
    const out = sanitizeEmailHtml(
      '<img src="https://img.example.com/a.png"><img srcset="https://img.example.com/b.png 2x"><td background="https://img.example.com/bg.png">x</td><div style="background:url(https://img.example.com/c.png)">y</div>',
      on,
    );
    expect(out).toContain('src="https://img.example.com/a.png"');
    expect(out).toContain("https://img.example.com/b.png");
    expect(out).not.toContain("bg.png");
    expect(out).not.toContain("c.png");
    expect(out).not.toContain("url(");
  });

  it("still blocks plain http and protocol-relative images, @import and scripts when allowed", () => {
    const out = sanitizeEmailHtml(
      '<img src="http://img.example.com/a.png"><img src="//img.example.com/b.png"><style>@import url(https://img.example.com/x.css);</style><script>alert(1)</script>',
      on,
    );
    expect(out).not.toContain("http://img.example.com");
    expect(out).not.toContain("//img.example.com/b.png");
    expect(out).not.toContain("x.css");
    expect(out).not.toContain("<script");
  });

  it("CSS output doesn't depend on the mode: no url() survives, even https with the toggle (Revision 3)", () => {
    for (const css of ["a{background:url(http://x.example.com/a.png)}", "a{background:url('https://x.example.com/a.png')}"]) {
      expect(sanitizeCss(css, on)).toBe("");
      expect(sanitizeCss(css, on)).toBe(sanitizeCss(css, off));
    }
  });
});

describe("image source rule (round 2, D4): data: only by default, plus absolute https: with the toggle", () => {
  const sources = ["/api/health", "api/health", "./x.png", "../x.png", "?q=1", "#frag", "//img.example.com/a.png", "http://img.example.com/a.png", "ftp://img.example.com/a.png", "blob:https://x/1", "cid:x"];

  for (const src of sources) {
    it(`drops img src=${src} in both modes`, () => {
      for (const mode of [off, on]) {
        const out = sanitizeEmailHtml(`<img src="${src}" alt="a">`, mode);
        expect(out).not.toContain(`src="${src}"`);
      }
    });
  }

  it("keeps data: in <img src> (https only with the toggle); data: in background or CSS url() is dropped (Revision 3)", () => {
    const html =
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><img src="https://img.example.com/a.png"><td background="data:image/gif;base64,R0lGOD">x</td><div style="background:url(data:image/gif;base64,R0lGOD)">y</div>';
    const def = sanitizeEmailHtml(html, off);
    expect(def).toContain('src="data:image/gif;base64,R0lGODlhAQABAAAAACw="');
    expect(def).not.toContain("img.example.com");
    expect(def).not.toContain("background=");
    expect(def).not.toContain("url(");
    expect(sanitizeEmailHtml(html, on)).toContain('src="https://img.example.com/a.png"');
  });

  it("relative and non-https background, CSS url() and srcset candidates are removed", () => {
    const html =
      '<td background="/bg.png">x</td><div style="background:url(/api/health)">y</div><style>.a{background:url(api/x)}</style><img srcset="/a.png 1x, https://img.example.com/b.png 2x, http://img.example.com/c.png 3x">';
    const def = sanitizeEmailHtml(html, off);
    expect(def).not.toMatch(/\/bg\.png|\/api\/health|api\/x|srcset/);
    const tog = sanitizeEmailHtml(html, on);
    expect(tog).not.toMatch(/\/bg\.png|\/api\/health|api\/x|\/a\.png|c\.png/);
    expect(tog).toContain('srcset="https://img.example.com/b.png 2x"');
  });
});

describe("emailDocument and iframe policy", () => {
  it("wraps the sanitized body in a document with a restrictive CSP and base target", () => {
    const doc = emailDocument('<p>Hello</p><img src="https://t.example.com/p.gif">', off);
    expect(doc).toContain(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`);
    expect(doc).not.toContain("font-src");
    expect(doc).toContain('<base target="_blank">');
    expect(doc).toContain("<p>Hello</p>");
    expect(doc).not.toContain("t.example.com");
  });

  it("widens img-src only for the toggled message", () => {
    expect(emailCsp(on)).toBe("default-src 'none'; img-src https: data:; style-src 'unsafe-inline'");
    expect(emailCsp(off)).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  });

  it("the sandbox never allows scripts or same-origin", () => {
    expect(EMAIL_IFRAME_SANDBOX).not.toMatch(/allow-scripts/);
    expect(EMAIL_IFRAME_SANDBOX).not.toMatch(/allow-same-origin/);
    expect(EMAIL_IFRAME_SANDBOX).not.toMatch(/allow-forms/);
    expect(EMAIL_IFRAME_SANDBOX).not.toMatch(/allow-top-navigation/);
  });
});
