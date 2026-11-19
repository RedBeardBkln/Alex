import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PLAINTEXT_INPUT, MAX_RENDERED_TEXT, htmlNestingDepth, htmlToPlainText, renderPlainText } from "@/lib/email/plain-text";

// Plan Revision 4: AC 18l (depth scan), 18m (linear plain-text paths).

describe("htmlNestingDepth", () => {
  it("counts open elements and closes, never below zero", () => {
    expect(htmlNestingDepth("")).toBe(0);
    expect(htmlNestingDepth("plain text")).toBe(0);
    expect(htmlNestingDepth("<div><p>a</p><p>b</p></div>")).toBe(2);
    expect(htmlNestingDepth("</div></div><div><div><div>")).toBe(3);
    expect(htmlNestingDepth("<DIV><Span>x</SPAN></div>")).toBe(2);
    expect(htmlNestingDepth(`${"<td>".repeat(10)}`)).toBe(10); // unclosed optional end tags count (R21)
  });

  it("doesn't count void elements, self-closing tags, comments, <!…>, <?…> or raw-text contents", () => {
    const noise = '<!doctype html><?xml x?><br><img src="a"><hr/><x-y/><input><meta charset=utf-8><!-- <div><div> -->';
    expect(htmlNestingDepth(`${noise}<div>x</div>`)).toBe(1);
    for (const raw of ["script", "style", "title", "textarea", "xmp", "noscript", "template", "noembed", "noframes", "iframe"]) {
      expect(htmlNestingDepth(`<${raw}><div><div><div></${raw.toUpperCase()}><p>x</p>`), raw).toBe(1);
    }
  });

  it("an unterminated comment, raw-text element or tag ends the scan", () => {
    expect(htmlNestingDepth(`<div><!--${"<div>".repeat(100)}`)).toBe(1);
    expect(htmlNestingDepth(`<div><script>${"<div>".repeat(100)}`)).toBe(1);
    expect(htmlNestingDepth(`<div><p class="x`)).toBe(1);
  });

  it("'<' not followed by a letter or '/' is text", () => {
    expect(htmlNestingDepth("a < b <3 <<div>x")).toBe(1);
  });

  it("stopAbove returns early once exceeded", () => {
    expect(htmlNestingDepth("<b>".repeat(10_000), 512)).toBe(513);
  });
});

describe("htmlToPlainText", () => {
  it("skips tags, comments and raw-text contents; block elements become newlines", () => {
    const html =
      '<html><head><title>T</title><style>p{color:red}</style></head><body><h1>Title</h1><p>One <b>bold</b> word.</p><!-- hidden --><div>Two<br>Three</div><script>alert(1)</script><ul><li>a</li><li>b</li></ul><table><tr><td>c1</td><td>c2</td></tr></table><blockquote>q</blockquote></body></html>';
    expect(htmlToPlainText(html)).toEqual({ text: "Title\n\nOne bold word.\n\nTwo\nThree\n\na\n\nb\n\nc1c2\n\nq", truncated: false });
  });

  it("decodes named entities and numeric references; invalid, surrogate and over-long ones become U+FFFD", () => {
    const { text } = htmlToPlainText(
      "&amp; &lt; &gt; &quot; &#39; &apos; [&nbsp;] &#65;&#x42;&#X43;&#100 &#0; &#xD800; &#x110000; &#123456789; &#; &unknown; &",
    );
    expect(text).toBe("& < > \" ' ' [ ] ABCd � � � � &#; &unknown; &");
  });

  it("raw-text elements that never close drop the rest; an unterminated tag drops the rest", () => {
    expect(htmlToPlainText("before<script>var a = '<p>x</p>'").text).toBe("before");
    expect(htmlToPlainText('before<p class="x').text).toBe("before");
    expect(htmlToPlainText("before<!-- comment").text).toBe("before");
  });

  it("collapses runs of 3+ newlines to 2 and normalizes CRLF", () => {
    expect(htmlToPlainText("a<br><br><br><br>b\r\n\r\n\r\nc").text).toBe("a\n\nb\n\nc");
  });

  it("caps input at MAX_PLAINTEXT_INPUT and output at MAX_RENDERED_TEXT, setting truncated", () => {
    expect(htmlToPlainText("x".repeat(MAX_RENDERED_TEXT))).toEqual({ text: "x".repeat(MAX_RENDERED_TEXT), truncated: false });
    const out = htmlToPlainText("x".repeat(MAX_RENDERED_TEXT + 1));
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(MAX_RENDERED_TEXT);
    const big = htmlToPlainText(`${"<b></b>".repeat(Math.ceil(MAX_PLAINTEXT_INPUT / 7))}tail`); // "tail" is past the input cap
    expect(big).toEqual({ text: "", truncated: true });
  });

  it("output is text: markup characters come through only as characters", () => {
    expect(htmlToPlainText("&lt;script&gt;alert(1)&lt;/script&gt;").text).toBe("<script>alert(1)</script>");
  });
});

describe("renderPlainText", () => {
  it("prefers a non-blank text body; otherwise converts the HTML", () => {
    expect(renderPlainText("<p>html</p>", "text body")).toEqual({ text: "text body", truncated: false });
    expect(renderPlainText("<p>html</p>", "  \n")).toEqual({ text: "html", truncated: false });
    expect(renderPlainText(null, null)).toEqual({ text: "", truncated: false });
    expect(renderPlainText(null, "y".repeat(MAX_RENDERED_TEXT + 5))).toMatchObject({ truncated: true });
  });
});

// ---- 18m: linear time, fresh process per size ------------------------------------------------

const helper = path.resolve(import.meta.dirname, "helpers/time-plain.mjs");
function fresh(fn: string, shape: string, n: number): number {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", helper, fn, shape, String(n)], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return Number(r.stdout);
}
const measure = (fn: string, shape: string, n: number) => Math.max(2, Math.min(fresh(fn, shape, n), fresh(fn, shape, n)));

const SHAPES = [
  "nested-div", "nested-b", "unclosed-x", "div-span", "lt-flood", "comment-flood", "unterminated-raw", "entity-flood",
  "long-tag-names", "attribute-soup", "text-and-tags",
];

describe("18m: htmlNestingDepth and htmlToPlainText scale linearly (n = 1, 2, 4 Mi; fresh processes)", () => {
  for (const shape of SHAPES) {
    for (const fn of ["depth", "text"]) {
      it(`${fn}: ${shape}`, { timeout: 120_000 }, () => {
        const n = 1024 * 1024;
        const t1 = measure(fn, shape, n);
        const t2 = measure(fn, shape, 2 * n);
        const t4 = measure(fn, shape, 4 * n);
        const trace = `${t1} -> ${t2} -> ${t4} ms`;
        expect(t4 / t1, trace).toBeLessThan(6.25); // about 2.5x per doubling
        expect(t2 / t1, trace).toBeLessThan(3);
        expect(t4 / t2, trace).toBeLessThan(3);
        expect(t4, `4 MiB: ${trace}`).toBeLessThan(150);
      });
    }
  }
});
