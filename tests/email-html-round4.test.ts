import { describe, expect, it } from "vitest";
import sanitizeHtml from "sanitize-html";
import { emailDocument, isStructurallySafe, sanitizeCss, sanitizeEmailHtml } from "@/lib/email-html";

// Round 4: security review S1 (style breakout via filter deletions) and S2 (remote-mode url() scope).

const off = { allowRemoteImages: false };
const on = { allowRemoteImages: true };

const ALLOWED = new Set([
  "a", "abbr", "address", "article", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite",
  "code", "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark",
  "ol", "p", "pre", "q", "s", "samp", "section", "small", "span", "strike", "strong", "style", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "var", "wbr",
]);

/** Re-parses output with htmlparser2 (through sanitize-html with no filtering) and returns every tag name seen. */
function tagsIn(html: string): string[] {
  const seen: string[] = [];
  sanitizeHtml(html, { allowedTags: false, allowedAttributes: false, allowVulnerableTags: true, onOpenTag: (name) => seen.push(name) });
  return seen;
}

/** Text of every <style> element, as a browser would delimit it (up to the first </style). */
function styleTexts(html: string): string[] {
  const out: string[] = [];
  const re = /<style\b[^>]*>([\s\S]*?)(?=<\/style)/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(m[1]!);
  return out;
}

const CLOSERS = [String.raw`</sty\le>`, "</sty\u0000le>", "</sty@import x;le>", String.raw`</STY\LE >`, "</sty/**/le>", String.raw`</s\tyle>`];

const PAYLOADS = [
  '<meta http-equiv="refresh" content="0;url=https:&#x2f;&#x2f;e.example/opened?id=1">',
  '<img src="http:&#x2f;&#x2f;e.example/a.gif">',
  '<img src="https:&#x2f;&#x2f;e.example/b.gif">',
  '<img src="http:e.example/c.gif">',
  '<link rel="stylesheet" href="https://e.example/s.css">',
  '<link rel="prefetch" href="https://e.example/p">',
  '<link rel="dns-prefetch" href="//e.example">',
  '<iframe src="https://e.example/f"></iframe>',
  '<object data="https://e.example/o"></object>',
  '<form action="https://e.example/post"><input name="x"></form>',
  '<base href="https://e.example/">',
  '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
  "<script>alert(1)</script>",
];

describe("S1: style text can never close its element", () => {
  for (const closer of CLOSERS) {
    for (const payload of PAYLOADS) {
      for (const mode of [off, on]) {
        it(`${JSON.stringify(closer)} + ${payload.slice(0, 40)} (${mode.allowRemoteImages ? "remote on" : "default"})`, () => {
          const out = sanitizeEmailHtml(`<style>a{color:red}${closer}${payload}</style><p>after</p>`, mode);
          expect(isStructurallySafe(out)).toBe(true);
          for (const t of tagsIn(out)) expect(ALLOWED.has(t), `tag ${t} in ${out}`).toBe(true);
          for (const text of styleTexts(out)) expect(text).not.toContain("<");
          // The payload may remain only as inert text inside the style element, with no scheme left.
          expect(out.toLowerCase()).not.toMatch(/(https?|ftp)\s*(:|&#0*58;?|&#x0*3a;?|&colon;)/);
          expect(out.toLowerCase()).not.toMatch(/<(meta|img src="http|link|iframe|object|form|input|base|svg|script)/);
          expect(out.toLowerCase()).not.toContain("javascript:");
        });
      }
    }
  }

  it("Revision 3: breakout closers never produce a closing tag; the CSS is regenerated, not edited", () => {
    for (const closer of [String.raw`</sty\le>`, "</sty\u0000le>", "</sty@import x;le>", "a/**/b"]) {
      const out = sanitizeCss(closer, off);
      expect(out).not.toContain("<");
      expect(out).not.toMatch(/\/style/i);
    }
  });

  it("no < ever appears in style text, in style elements or style attributes", () => {
    const out = sanitizeEmailHtml('<style>a::after{content:"<b>"} b{color:red}</style><p style="font-family:&quot;<x&quot;;color:blue">x</p>', off);
    for (const text of styleTexts(out)) expect(text).not.toContain("<");
    expect(out).toContain("<style>b{color:red}</style>"); // ::after rule dropped, plain rule kept
    expect(out).toContain('style="color:blue"'); // unsafe string dropped, colour kept
    expect(isStructurallySafe(out)).toBe(true);
  });

  it("the structural check rejects a style element containing <, or a non-allowlisted tag", () => {
    expect(isStructurallySafe("<style>a{}</style><p>x</p>")).toBe(true);
    expect(isStructurallySafe("<style>a{}<x</style>")).toBe(false);
    expect(isStructurallySafe("<style>a{}")).toBe(false);
    expect(isStructurallySafe("<p>x</p><meta http-equiv=refresh>")).toBe(false);
    expect(isStructurallySafe("<p>a &lt;meta&gt;</p>")).toBe(true);
  });

  it("entity-encoded and slash-less URLs can't get a remote image through any check", () => {
    const html = [
      '<img src="https:&#x2f;&#x2f;e.example/a.gif">',
      '<img src="https:e.example/b.gif">',
      '<img src="&#104;ttps://e.example/c.gif">',
      '<td background="https:&#x2f;&#x2f;e.example/d.gif">x</td>',
      '<div style="background:url(https:&#x2f;&#x2f;e.example/e.gif)">x</div>',
      "<style>.a{background:url(https:&#x2f;&#x2f;e.example/f.gif)} .b{background:url(https:e.example/g.gif)}</style>",
    ].join("");
    const def = sanitizeEmailHtml(html, off);
    expect(def).not.toMatch(/e\.example\/[a-g]\.gif/);
    const tog = sanitizeEmailHtml(html, on);
    // With the toggle, <img src> values are entity-decoded (by the parser and the browser alike), so a and c are
    // genuine absolute https URLs and may stay. https:host (b) may not; neither may the background attribute (d)
    // or any CSS url() (e, f, g), in either mode (Revision 3).
    expect(tog).not.toMatch(/e\.example\/[bdefg]\.gif/);
    expect(tog).toContain('src="https://e.example/a.gif"');
    expect(tog).not.toContain("https:&#x2f;&#x2f;e.example/f.gif)");
    expect(isStructurallySafe(tog)).toBe(true);
  });

  it("emailDocument stays a single document with the CSP and no injected markup", () => {
    const doc = emailDocument(`<style>a{}</sty\\le><meta http-equiv="refresh" content="0;url=https://e.example/"></style>`, off);
    expect(doc.match(/<meta http-equiv/gi)).toHaveLength(1);
    expect(doc).not.toContain("e.example");
  });
});

describe("Revision 3 (supersedes S2): no CSS url() survives in either mode", () => {
  const blocked = [
    "@font-face{font-family:x;src:url(https://f.example/f.woff)}",
    "@font-face{font-family:x;src:url('https://f.example/f.woff') format('woff')}",
    "@namespace url(https://n.example/ns);",
    "@namespace svg url(https://n.example/svg);",
    ".a{-moz-binding:url(https://b.example/x.xml#b)}",
    ".a{cursor:url(https://c.example/c.cur),auto}",
    ".a{filter:url(https://f.example/f.svg#x)}",
    ".a{mask:url(https://m.example/m.svg)}",
    ".a{mask-image:url(https://m.example/m.png)}",
    ".a{content:url(https://k.example/k.png)}",
    ".a{behavior:url(https://h.example/x.htc)}",
    ".a{cursor/*;background:*/:url(https://c.example/comment-trick.cur)}",
    '.a{cursor:"x;background:" url(https://c.example/string-trick.cur)}',
    ".a{x:1}url(https://u.example/stray.png)",
  ];
  for (const css of blocked) {
    it(`blocks ${css.slice(0, 60)}`, () => {
      expect(sanitizeEmailHtml(`<style>${css}</style>`, on)).not.toMatch(/https:\/\/[a-z]\.example/);
      expect(sanitizeEmailHtml(`<div style="${css.replace(/^\.a\{|\}$/g, "").replace(/"/g, "'")}">x</div>`, on)).not.toMatch(/https:\/\/[a-z]\.example/);
    });
  }

  const formerlyKept = [
    ".a{background:url(https://ok.example/a.png)}",
    ".a{background-image:url('https://ok.example/b.png')}",
    ".a{list-style-image:url(https://ok.example/c.png)}",
    ".a{list-style:square url(https://ok.example/d.png)}",
    ".a{border-image:url(https://ok.example/e.png) 30 round}",
    ".a{border-image-source:url(https://ok.example/f.png)}",
    "@media screen{.a{background:url(https://ok.example/g.png)}}",
    ".a{background:url(data:image/png;base64,AAAA)}",
  ];
  for (const css of formerlyKept) {
    it(`drops ${css.slice(0, 60)} in both modes`, () => {
      for (const mode of [off, on]) {
        const out = sanitizeEmailHtml(`<style>${css}</style>`, mode);
        expect(out).not.toContain("url(");
        expect(out).not.toContain("ok.example");
      }
    });
  }

  it("a mixed background shorthand keeps only its colour (Q-R3-4)", () => {
    expect(sanitizeEmailHtml('<div style="background:#fff url(https://ok.example/x.png) no-repeat">x</div>', on)).toContain('style="background-color:#fff"');
    expect(sanitizeCss(".a{background:url(data:x) red}", off)).toBe(".a{background-color:red}");
  });
});
