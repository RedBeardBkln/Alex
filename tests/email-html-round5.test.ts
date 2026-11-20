import { describe, expect, it } from "vitest";
import { isStructurallySafe, MAX_CSS_CHARS, MAX_HTML_CHARS, sanitizeCss, sanitizeEmailHtml, sanitizeEmailHtmlResult } from "@/lib/email-html";
import { decodeEncodedWords, parseMessage, senderDisplayName, snippetText } from "@/lib/gmail/mime";

// Round 5: T1 (ReDoS in url()), T2 (quadratic property lookup), size caps, and an audit of other
// regexes that run on attacker-controlled input. Thresholds are generous so they don't flake on
// slow machines; before the fix the first cases took tens of seconds.

const off = { allowRemoteImages: false };
const on = { allowRemoteImages: true };

function ms(fn: () => unknown): number {
  const s = performance.now();
  fn();
  return performance.now() - s;
}

const SPACES = " ".repeat(100_000);

describe("T1/T2: url() handling is linear on hostile CSS", () => {
  const hostile: Record<string, string> = {
    "unterminated url( + 100k spaces": `a{background:url(${SPACES}x`,
    "unterminated url( + 100k tabs": `a{background:url(${"\t".repeat(100_000)}x`,
    "url( + spaces + quote, never closed": `a{background:url(${" ".repeat(50_000)}"${" ".repeat(50_000)}`,
    "20k unterminated url(\" sharing one far closing quote + spaces": `a{b:${'url("'.repeat(20_000)}"${" ".repeat(50_000)}x`,
    "20k unterminated url( (bare)": `a{b:${"url(".repeat(20_000)}`,
    "20k url( + spaces, no ')'": `a{b:${"url(     ".repeat(20_000)}`,
    "30k url(data:x) in one declaration": `a{background:${"url(data:x)".repeat(30_000)}}`,
    "30k url(https:...) in one declaration (toggle)": `a{background:${"url(https://i.example/a.png)".repeat(10_000)}}`,
    "'url' + spaces repeated without '('": `a{b:${"url          ".repeat(20_000)}}`,
    "long property name before url()": `a{${"x".repeat(200_000)}:url(https://i.example/a.png)}`,
    "long whitespace before property": `a{${SPACES}background:url(https://i.example/a.png)}`,
    "many declarations each with url()": `a{${"background:url(https://i.example/a.png);".repeat(5_000)}}`,
    "@import without ;": `${"@import ".repeat(20_000)}`,
    "unterminated comments": `${"/*".repeat(50_000)}`,
    "scheme text + long zero runs": `a{b:javascript:&#${"0".repeat(100_000)}`,
    "image( + spaces repeated": `a{b:${"image     ".repeat(20_000)}}`,
    "slashes": `a{b:${"/".repeat(200_000)}}`,
  };
  for (const [name, css] of Object.entries(hostile)) {
    it(`${name} (${Math.round(css.length / 1024)} KB) in both modes, style element and attribute`, { timeout: 60_000 }, () => {
      for (const mode of [off, on]) {
        expect(ms(() => sanitizeCss(css, mode))).toBeLessThan(1500);
        expect(ms(() => sanitizeEmailHtml(`<style>${css}</style>`, mode))).toBeLessThan(1500);
        const attr = css.replace(/"/g, "'");
        expect(ms(() => sanitizeEmailHtml(`<div style="${attr}">t</div>`, mode))).toBeLessThan(2500);
      }
    });
  }

  it("doubling the input roughly doubles the time (no super-linear growth)", { timeout: 60_000 }, () => {
    const build = (k: number) => `a{background:${'url("'.repeat(k)}"${" ".repeat(k)}x ${"url(data:x)".repeat(k)}}`;
    sanitizeCss(build(1000), off); // warm-up
    const t1 = Math.max(ms(() => sanitizeCss(build(20_000), off)), 1);
    const t2 = ms(() => sanitizeCss(build(40_000), off));
    expect(t2 / t1).toBeLessThan(6);
  });

  it("many url()s are all dropped, and a declaration made only of url()s disappears (Revision 3)", () => {
    const css = `a{cursor:${"url(data:x) ".repeat(1000)}url(https://c.example/c.cur)} b{background:${"url(data:x) ".repeat(1000)}url(https://ok.example/b.png);color:red}`;
    for (const mode of [off, on]) expect(sanitizeCss(css, mode)).toBe("b{color:red}");
  });

  it("malformed url( is still blocked and never kept", () => {
    expect(sanitizeCss("a{background:url(https://x.example/a.png", on)).not.toMatch(/url\s*\(/i);
    expect(sanitizeCss('a{background:url("https://x.example/a.png)', on)).not.toMatch(/url\s*\(/i);
    expect(sanitizeCss('a{background:url("https://ok.example/a.png" x)}', on)).not.toContain("ok.example");
  });

  it("control bytes in the input never reach the output", () => {
    const out = sanitizeCss("a{background:url(data:x)} b{content:\x010\x01;color:red}", off);
    expect(out).toBe("b{color:red}");
  });

  it("Unicode characters that change length when lowercased don't misalign the style or structure checks", () => {
    const html = `<p>${"İ".repeat(50)}</p><style>a{color:red}</style>${"İ".repeat(50)}<p>x</p>`;
    const out = sanitizeEmailHtml(html, off);
    expect(isStructurallySafe(out)).toBe(true);
    expect(out).toContain("<style>a{color:red}</style>");
    expect(isStructurallySafe(`${"İ".repeat(10)}<style>a{}</style><meta http-equiv=refresh>`)).toBe(false);
  });
});

describe("size caps", () => {
  it("CSS longer than MAX_CSS_CHARS is dropped, not filtered", () => {
    const big = `a{color:red}${" ".repeat(MAX_CSS_CHARS)}`;
    expect(sanitizeCss(big, off)).toBe("");
    // One over-cap CSS part per message: two would exceed MAX_HTML_CHARS (256 Ki) since Revision 4.
    expect(sanitizeEmailHtml(`<style>${big}</style><p>x</p>`, off)).toBe("<style></style><p>x</p>");
    expect(sanitizeEmailHtml(`<p style="${big}">x</p>`, off)).toBe("<p>x</p>");
  });

  it("Revision 4: HTML longer than MAX_HTML_CHARS is refused quickly (the caller stores plain text)", { timeout: 60_000 }, () => {
    expect(MAX_HTML_CHARS).toBe(262_144);
    const html = `<p>Hello <b>world</b></p><style>a{background:url(${" ".repeat(3000)}x</style>${"<i>lorem</i> ".repeat(Math.ceil(MAX_HTML_CHARS / 10))}`;
    expect(html.length).toBeGreaterThan(MAX_HTML_CHARS);
    let r: ReturnType<typeof sanitizeEmailHtmlResult> | undefined;
    expect(ms(() => (r = sanitizeEmailHtmlResult(html, off)))).toBeLessThan(50);
    expect(r).toEqual({ ok: false, reason: "too_large" });
    expect(sanitizeEmailHtml(html, off)).toBe("");
    expect(isStructurallySafe(sanitizeEmailHtml(html, off))).toBe(true);
  });

  it("a realistic newsletter under the cap still renders as HTML", () => {
    const html = ('<p style="color:red">Hello <b>world</b></p>').repeat(2000);
    expect(sanitizeEmailHtml(html, off)).toContain("<b>world</b>");
  });
});

describe("regex audit: other attacker-controlled inputs stay fast", () => {
  it("srcset with huge whitespace runs (was a quadratic split)", { timeout: 60_000 }, () => {
    const html = `<img srcset="a${" ".repeat(100_000)}b, https://i.example/a.png 2x">`;
    expect(ms(() => sanitizeEmailHtml(html, on))).toBeLessThan(1500);
    expect(sanitizeEmailHtml(html, on)).toContain("https://i.example/a.png 2x");
  });

  it("From header display name (was a quadratic regex)", { timeout: 60_000 }, () => {
    expect(ms(() => senderDisplayName(`a${" ".repeat(100_000)}`))).toBeLessThan(200);
    expect(ms(() => senderDisplayName(`"${" ".repeat(100_000)}<x`))).toBeLessThan(200);
    expect(senderDisplayName('"Ann Example" <ann@example.com>')).toBe("Ann Example");
    expect(senderDisplayName("Ann <ann@example.com>")).toBe("Ann");
    expect(senderDisplayName("<ann@example.com>")).toBe("<ann@example.com>");
    expect(senderDisplayName("ann@example.com")).toBe("ann@example.com");
    expect(senderDisplayName(null)).toBe("(unknown sender)");
  });

  it("MIME header helpers on long hostile headers", { timeout: 60_000 }, () => {
    const longSemis = `text/plain${"; ".repeat(50_000)}charset=utf-8`;
    const longSpaces = `text/plain;${" ".repeat(100_000)}x`;
    const words = "=?utf-8?q?".repeat(20_000);
    const spacedWords = `${"=?utf-8?b?QQ==?=".repeat(2)}${" ".repeat(100_000)}`;
    for (const value of [longSemis, longSpaces]) {
      const t = ms(() =>
        parseMessage({
          id: "m",
          threadId: "t",
          payload: { mimeType: "text/plain", headers: [{ name: "Content-Type", value }, { name: "Subject", value: words }], body: { data: "eA" } },
        }),
      );
      expect(t).toBeLessThan(1500);
    }
    expect(ms(() => decodeEncodedWords(words))).toBeLessThan(1500);
    expect(ms(() => decodeEncodedWords(spacedWords))).toBeLessThan(1500);
    expect(ms(() => snippetText(`&#${"1".repeat(100_000)}`))).toBeLessThan(500);
    expect(ms(() => snippetText("&".repeat(100_000)))).toBeLessThan(500);
  });
});
