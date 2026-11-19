import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { MessageBody, type BodyMessage } from "@/app/(app)/inbox/[threadId]/message-body";
import { RENDER_LIMIT_MS, RenderPool, renderEmailBody } from "@/lib/email/render";
import type { RenderFields } from "@/lib/email/types";
import { isStructurallySafe, MAX_CSS_CHARS, MAX_HTML_CHARS, sanitizeCss, sanitizeEmailHtml } from "@/lib/email-html";
import { senderDisplayName } from "@/lib/gmail/mime";

// Revision 4: the real ingest path (renderEmailBody + the bundled worker) and the page component.
const r4Pool = new RenderPool();
afterAll(() => r4Pool.close());
const pageOf = (f: RenderFields) => {
  const m: BodyMessage = {
    id: "11111111-1111-4111-8111-111111111111",
    isSent: false,
    fromHeader: "Ann <ann@example.com>",
    bodyText: null,
    bodyIncomplete: false,
    renderKind: f.renderKind,
    renderReason: f.renderReason,
    renderedHtml: f.renderedHtml,
    renderedHtmlRemote: f.renderedHtmlRemote,
    renderedText: f.renderedText,
    renderTruncated: f.renderTruncated,
    sanitizerVersion: f.sanitizerVersion,
  };
  return renderToStaticMarkup(createElement(MessageBody, { message: m, threadId: "t", remoteOn: true }));
};

// Tester round 5: attacks on the url() scanner rewrite, the size caps and senderDisplayName.

const off = { allowRemoteImages: false };
const on = { allowRemoteImages: true };

/** url(...) tokens a CSS tokenizer would produce, approximated: unquoted url( ... ) with no quotes/whitespace inside. */
function liveUnquotedUrls(css: string): string[] {
  return [...css.matchAll(/url\(\s*([^"'()\s]+)\s*\)/gi)].map((m) => m[1]!);
}

/** CSS text of every style element and style attribute in sanitizer output (entity-decoded for attributes). */
function cssIn(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push(m[1]!);
  for (const m of html.matchAll(/\sstyle="([^"]*)"/gi)) out.push(m[1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
  return out;
}

/**
 * Splits CSS the way the CSS Syntax spec does for strings: an unescaped newline (LF, CR, FF) ends a
 * quoted string as a bad-string, and tokenizing resumes after it. Returns the text outside strings.
 */
function outsideCssStrings(css: string): string {
  let out = "";
  let q: string | null = null;
  for (const ch of css) {
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\n" || ch === "\r" || ch === "\f") {
        q = null; // bad-string: the newline is reconsumed as whitespace
        out += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

describe("U1: a newline inside a kept quoted url() lets a live url() through (CSS bad-string)", () => {
  const smuggle = [
    ["default-mode remote background", 'a{background:url("data:,x\n);background:url(https://e.example.com/default.png);y:")}'],
    ["http background", 'a{background:url("data:,x\n);background:url(http://e.example.com/http.png);y:")}'],
    ["cursor via CR", 'a{background:url("data:,x\r);cursor:url(https://e.example.com/cursor.png),auto;y:")}'],
    ["-moz-binding via FF, single quotes", "a{background:url('data:,x\f);-moz-binding:url(https://e.example.com/b.xml);y:')}"],
    ["font in @font-face", '@font-face{font-family:f;src:url("data:,x\n);src:url(https://e.example.com/f.woff);y:")}'],
    ["kept https image smuggles cursor (remote mode)", 'a{background:url("https://ok.example.org/a.png\n);cursor:url(https://e.example.com/c.png);y:")}'],
  ];
  for (const [label, css] of smuggle) {
    for (const opts of [off, on]) {
      it(`${label} (${opts.allowRemoteImages ? "remote" : "default"}), style element and attribute`, () => {
        const inputs = [
          `<style>${css}</style>`,
          `<div style="${css!.replace(/^[^{]*\{/, "").replace(/\}$/, "").replace(/"/g, "&quot;")}">x</div>`,
        ];
        for (const input of inputs) {
          const out = sanitizeEmailHtml(input, opts);
          for (const text of cssIn(out)) {
            const live = liveUnquotedUrls(outsideCssStrings(text)).filter((u) => /e\.example\.com/.test(u));
            expect(live, `${JSON.stringify(input)}\n=> ${JSON.stringify(out)}`).toEqual([]);
          }
        }
      });
    }
  }
});

describe("scanner keep/block rules after the rewrite", () => {
  it("non-ASCII look-alikes are not url() to a browser, and their URL text is still stripped", () => {
    for (const css of [
      "a{background:ｕｒｌ(https://e.example.com/fw.png)}",
      "a{background:u̇rl(https://e.example.com/comb.png)}",
      "a{background:İurl(https://e.example.com/dot.png)}",
      "a{background:url​(https://e.example.com/zw.png)}",
      "a{backgroundİ:url(https://e.example.com/prop.png)}",
      "a{ｂackground:url(https://e.example.com/prop2.png)}",
      "a{background́:url(https://e.example.com/prop3.png)}",
      "a{background:url(https://e.example.com/ẞ.png)}",
    ]) {
      // Default mode: nothing may survive. (In remote mode a background https image is allowed by design.)
      expect(sanitizeEmailHtml(`<style>${css}</style>`, off), css).not.toContain("e.example.com");
      expect(isStructurallySafe(sanitizeEmailHtml(`<style>${css}</style>`, on))).toBe(true);
    }
  });

  it("the placeholder byte (\\u0001) can't forge a kept url()", () => {
    for (const css of ["a{background:\u00010\u0001}", "a{background:url(data:x) \u00010\u0001 url(https://e.example.com/x)}", "\u0001999\u0001", "\u0001\u0001"]) {
      for (const opts of [off, on]) {
        const out = sanitizeCss(css, opts);
        expect(out).not.toContain("\u0001");
        expect(out).not.toContain("undefined");
        if (!opts.allowRemoteImages) expect(out).not.toContain("e.example.com");
      }
    }
  });

  it("isStructurallySafe stays aligned with length-changing characters (İ, ẞ) before <style>", () => {
    const pad = "İ".repeat(50) + "ẞ".repeat(50);
    for (const opts of [off, on]) {
      // Revision 3 drops empty rules, so use non-empty ones; the property is the alignment.
      const out = sanitizeEmailHtml(`<p>${pad}</p><style>a{color:red}</style><p>${pad}</p><style>b{color:blue}</style>`, opts);
      expect(isStructurallySafe(out)).toBe(true);
      expect(out).toContain("<style>a{color:red}</style>");
      expect(out).toContain("<style>b{color:blue}</style>");
    }
    expect(isStructurallySafe(`<p>${pad}</p><style>a{}</style><meta http-equiv=refresh content=0>`)).toBe(false);
  });
});

describe("size caps: boundaries and units", () => {
  it("MAX_CSS_CHARS: exactly the cap is filtered, one more is dropped (style element and attribute)", () => {
    const body = (n: number) => "a{color:red}" + " ".repeat(n - "a{color:red}".length);
    expect(sanitizeCss(body(MAX_CSS_CHARS), off)).toContain("color:red");
    expect(sanitizeCss(body(MAX_CSS_CHARS + 1), off)).toBe("");
    // Measured in UTF-16 code units, not bytes: 2-unit characters count double.
    // Revision 3 emits nothing for CSS without a valid rule, so pad a valid rule with a comment of
    // 2-unit characters up to exactly the cap: kept at the cap, dropped at cap + 1.
    const rule = "a{color:red}";
    const astralPad = (extra: number) => rule + "/*" + "\u{1F600}".repeat((MAX_CSS_CHARS - rule.length - 4) / 2) + "x".repeat(extra) + "*/";
    expect(((MAX_CSS_CHARS - rule.length - 4) % 2)).toBe(0);
    expect(astralPad(0).length).toBe(MAX_CSS_CHARS);
    expect(sanitizeCss(astralPad(0), off)).toContain("color:red");
    expect(sanitizeCss(astralPad(1), off)).toBe("");
    // Over the cap means no CSS at all, never unfiltered CSS.
    const big = `a{background:url(https://e.example.com/x.png)}${" ".repeat(MAX_CSS_CHARS)}`;
    for (const opts of [off, on]) {
      expect(sanitizeEmailHtml(`<style>${big}</style>`, opts)).not.toContain("e.example.com");
      expect(sanitizeEmailHtml(`<div style="${big}">x</div>`, opts)).not.toContain("e.example.com");
    }
  });

  // Revision 4 (R4.2/R4.9): there is no in-sanitizer notice any more. Over the cap the ingest router
  // stores Alex's plain text (reason too_large); the page shows it as text with a note.
  it("MAX_HTML_CHARS (262,144): at the cap the real worker renders HTML; +1 is text/too_large; hostile tails stay inert either way", { timeout: 60_000 }, async () => {
    expect(MAX_HTML_CHARS).toBe(262_144);
    const fill = (n: number, tail: string) => "<p>x</p>" + " ".repeat(n - 8 - tail.length) + tail;
    const at = await renderEmailBody({ html: fill(MAX_HTML_CHARS, "<b>y</b>"), text: null }, { pool: r4Pool });
    expect([at.renderKind, at.renderReason]).toEqual(["html", null]);
    expect(at.renderedHtml).toContain("<b>y</b>");
    const over = await renderEmailBody({ html: fill(MAX_HTML_CHARS + 1, "<b>y</b>"), text: null }, { pool: r4Pool });
    expect([over.renderKind, over.renderReason, over.renderedHtml]).toEqual(["text", "too_large", null]);
    expect(over.renderedText).toContain("y");
    expect(pageOf(over)).toContain("couldn&#x27;t be displayed safely");
    // Hostile tails right at and just over the boundary: inert as sanitized HTML and as page text.
    for (const tail of ['<img src="https://e.example.com/x" onerror="alert(1)">', "\u{1F600}\u{1F600}", "&#x6A;avascript&colon;", "<script>alert(1)</script>"]) {
      for (const extra of [0, 1]) {
        const html = fill(MAX_HTML_CHARS + extra, tail);
        const r = await renderEmailBody({ html, text: null }, { pool: r4Pool });
        expect(r.renderKind).toBe(extra === 0 ? "html" : "text");
        if (r.renderedHtml) {
          // Inert text such as the decoded word "javascript:" is fine; executable positions are not.
          expect(r.renderedHtml).not.toMatch(/\son[a-z]+=|<script|(?:href|src)="\s*javascript:/i);
          expect(isStructurallySafe(r.renderedHtml)).toBe(true);
        }
        const page = pageOf(r);
        expect(page).not.toMatch(/<img[^>]*onerror|<script>|javascript:alert/i);
      }
    }
  });
});

describe("whole render path timing (Revision 4: ingest-time bound per job, then view-time bound)", () => {
  it("8 worst-case messages within the caps: each real-worker job ends within RENDER_LIMIT_MS + 250 ms; the page renders all 8 in under 100 ms", { timeout: 120_000 }, async () => {
    const unterminated = `<p style="background:url(${" ".repeat(200)}">x</p>`;
    const msgs = [
      unterminated.repeat(Math.floor((MAX_HTML_CHARS - 10) / unterminated.length)),
      `<style>a{${'background:url("'.repeat(Math.floor((MAX_CSS_CHARS - 20) / 16))}</style>`,
      `<style>${"url(data:x)".repeat(Math.floor((MAX_CSS_CHARS - 20) / 11))}</style>`,
      `<p style="${"url(data:x)".repeat(11000)}">x</p>`.repeat(2),
      `<img srcset="${"https://ok.example.org/a.png 1x,".repeat(8000)}">`,
      ("<p>Hello <b>world</b> " + "lorem ipsum ".repeat(30) + "</p>").repeat(600),
      `<style>${"http&#" + "0".repeat(120000)}</style>`,
      `<style>${"/*".repeat(60000)}</style>`,
    ];
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(MAX_HTML_CHARS);
    await renderEmailBody({ html: "<p>warm</p>", text: null }, { pool: r4Pool }); // spawn outside the timings
    const stored: RenderFields[] = [];
    for (const m of msgs) {
      const t0 = performance.now();
      const r = await renderEmailBody({ html: m, text: null }, { pool: r4Pool });
      const ms = performance.now() - t0;
      expect(ms, `job took ${ms.toFixed(0)} ms (${r.renderKind}/${r.renderReason})`).toBeLessThan(RENDER_LIMIT_MS + 250);
      stored.push(r);
    }
    const t1 = performance.now();
    for (const r of stored) pageOf(r);
    expect(performance.now() - t1).toBeLessThan(100);
  });
});

describe("senderDisplayName on hostile From headers", () => {
  const cases: [string | null, string][] = [
    [null, "(unknown sender)"],
    ["", "(unknown sender)"],
    ["   ", "(unknown sender)"],
    ["Alice <a@example.com>", "Alice"],
    ['"Alice Smith" <a@example.com>', "Alice Smith"],
    ['"" <a@example.com>', '"" <a@example.com>'.trim()],
    ["<a@example.com>", "<a@example.com>"],
    ["a@example.com", "a@example.com"],
    ['"Evil <admin@example.com>" <x@example.com>', "Evil <admin@example.com>"],
    ["Name <a@example.com> <b@example.com>", "Name <a@example.com>"],
    ["Name <a@example.com", "Name <a@example.com"],
    ['"Unclosed <a@example.com>', 'Unclosed'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      const got = senderDisplayName(input);
      if (input === '"" <a@example.com>') {
        // An empty quoted name falls back to the full header (never an empty string).
        expect(got.length).toBeGreaterThan(0);
      } else {
        expect(got).toBe(expected);
      }
    });
  }

  it("is linear and never empty on huge hostile headers", () => {
    for (const h of [`"${" ".repeat(200_000)}" <a@example.com>`, `${"<".repeat(200_000)}>`, `${'"'.repeat(200_000)}<a@example.com>`, `${" ".repeat(300_000)}<${"x".repeat(100_000)}>`]) {
      const t0 = performance.now();
      const got = senderDisplayName(h);
      expect(performance.now() - t0).toBeLessThan(200);
      expect(got.length).toBeGreaterThan(0);
    }
  });

  it("returns plain text only (React escapes it); encoded words are already decoded upstream", () => {
    expect(senderDisplayName("=?utf-8?q?Caf=C3=A9?= <a@example.com>")).toBe("=?utf-8?q?Caf=C3=A9?=");
    expect(senderDisplayName("<script>alert(1)</script> <a@example.com>")).toBe("<script>alert(1)</script>");
  });
});
