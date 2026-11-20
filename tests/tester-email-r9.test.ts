import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { MessageBody, type BodyMessage } from "@/app/(app)/inbox/[threadId]/message-body";
import { htmlNestingDepth, htmlToPlainText, MAX_PLAINTEXT_INPUT, MAX_RENDERED_TEXT, renderPlainText } from "@/lib/email/plain-text";
import { defaultWorkerPath, MAX_HTML_DEPTH, MAX_RENDER_HTML_CHARS, RENDER_LIMIT_MS, RenderPool, renderEmailBody } from "@/lib/email/render";
import { MAX_HTML_CHARS } from "@/lib/email-html";
import { oracleDepth } from "./helpers/tester-oracle";

// Tester round 9 (plan Revision 4, "sanitize at ingest"): attacks on routing, the depth pre-scan,
// the worker limit, the plain-text scanner, the page path and the version gate.

const SLACK_MS = 250;
const div = (d: number) => "<div>".repeat(d) + "x" + "</div>".repeat(d);

/** A pool stand-in that records what reaches "the worker" and returns a fixed html result. */
function countingPool() {
  const seen: string[] = [];
  const pool = {
    dispatched: 0,
    run: async (html: string) => {
      pool.dispatched += 1;
      seen.push(html);
      return { ok: true as const, html: "<p>ok</p>", remote: null };
    },
  };
  return { pool: pool as unknown as RenderPool, seen, get count() { return pool.dispatched; } };
}

describe("routing boundaries (18l)", () => {
  it("MAX_HTML_CHARS is 262,144 in both modules; at the boundary dispatched, +1 too_large without dispatch", async () => {
    expect(MAX_HTML_CHARS).toBe(262_144);
    expect(MAX_RENDER_HTML_CHARS).toBe(262_144);
    const at = "<p>x</p>" + " ".repeat(262_144 - 8);
    const c = countingPool();
    expect((await renderEmailBody({ html: at, text: null }, { pool: c.pool })).renderKind).toBe("html");
    const over = await renderEmailBody({ html: at + " ", text: null }, { pool: c.pool });
    expect([over.renderKind, over.renderReason]).toEqual(["text", "too_large"]);
    expect(c.count).toBe(1);
  });

  // Follow-up task (F1/H1): the scan now models htmlparser2's stack exactly, so "non-counting" means
  // what the parser doesn't count: `/>` does NOT self-close in HTML and is no longer noise here; stray
  // closes are ignored rather than decremented. Every expectation is checked against the real parser.
  it("depth 512 is dispatched, 513 is too_deep with no dispatch, with parser-non-counting noise interleaved; scan == parser", async () => {
    const noise = [
      "<!-- <div><div><div> -->",
      "<!--><!---><!-- --!>",
      "<!DOCTYPE html>",
      "<?xml version='1.0'?>",
      "<![CDATA[ x ]]>", // (CDATA with tags inside is a bogus comment ending at the first ">", so tags after it DO count)
      "<br><hr><img src=x><input><wbr><meta charset=x><link rel=x><area><base><col><embed><param><source><track><basefont><keygen><br/>",
      "<script><div><div><div></script>",
      "<style>a{}<div><div></style>",
      "<title><div><div></title>",
      "<textarea><div><div></textarea>",
      "<xmp><div><div></xmp>",
      "<iframe><div><div></iframe>",
      "<noembed><div></noembed><noframes><div></noframes>",
      "< div>",
      "<1div>",
      "</>",
      "</zz></q></span>", // stray closes: ignored by the parser, so no effect
    ].join("");
    const nested = (d: number) => {
      const parts: string[] = [];
      for (let i = 0; i < d; i++) parts.push(`<div class="c${i}">${noise}`);
      return parts.join("") + "x" + "</div>".repeat(d);
    };
    // Raw-text elements (script, style, …) are themselves on the parser's stack while open, so noise
    // at the deepest level adds one: nested(d) has parser depth d + 1. Boundaries are taken from the parser.
    expect(oracleDepth(nested(10))).toBe(11);
    for (const html of [nested(511), div(512)]) {
      expect(oracleDepth(html)).toBe(512);
      expect(htmlNestingDepth(html)).toBe(512);
      const c = countingPool();
      expect((await renderEmailBody({ html, text: null }, { pool: c.pool })).renderKind).toBe("html");
      expect(c.count).toBe(1);
    }
    for (const html of [nested(512), div(513)]) {
      expect(oracleDepth(html)).toBe(513);
      expect(htmlNestingDepth(html)).toBe(513);
      const c = countingPool();
      const r = await renderEmailBody({ html, text: null }, { pool: c.pool });
      expect([r.renderKind, r.renderReason, c.count]).toEqual(["text", "too_deep", 0]);
    }
  });

  it("H1: `/>` and stray closes now count as the parser counts them (512 <div/> plus 1 is too_deep)", async () => {
    for (const html of ["<div/>".repeat(513), "<div></zz>".repeat(513), "<span/>".repeat(513)]) {
      expect(oracleDepth(html)).toBe(513);
      expect(htmlNestingDepth(html)).toBe(513);
      const c = countingPool();
      const r = await renderEmailBody({ html, text: null }, { pool: c.pool });
      expect([r.renderKind, r.renderReason, c.count]).toEqual(["text", "too_deep", 0]);
    }
  });

  it("closing tags never go below 0 (</x> floods can't pre-pay depth), and unclosed tags at EOF still count", async () => {
    expect(htmlNestingDepth("</div>".repeat(10_000) + "<div>".repeat(513))).toBe(513);
    expect(htmlNestingDepth("<div>".repeat(513))).toBe(513);
    expect(htmlNestingDepth("<div>".repeat(513) + "<div")).toBe(513); // unterminated tag name stops the scan
    expect(oracleDepth("<div>".repeat(513) + "<div")).toBe(513);
  });

  it("an unterminated raw-text element: the element itself counts (as in the parser), its content doesn't", () => {
    const html = "<script>" + "<div>".repeat(600);
    expect(oracleDepth(html)).toBe(1);
    expect(htmlNestingDepth(html)).toBe(1);
  });
});

describe("depth pre-scan vs htmlparser2: the round-9 miscounts are fixed (follow-up F1/H1)", () => {
  // Round 9 found UNDERCOUNTS (noscript, template, an attribute-hidden comment) that reached the worker,
  // and an OVERCOUNT (unclosed <p>) that sent legacy mail to text. The scan now matches the parser.
  const pool = new RenderPool();
  afterAll(() => pool.close());

  const fill = (wrapperOpen: string, wrapperClose: string) => {
    const room = MAX_HTML_CHARS - wrapperOpen.length - wrapperClose.length - 20;
    const d = Math.floor(room / 11);
    return wrapperOpen + "<div>".repeat(d) + "x" + "</div>".repeat(d) + wrapperClose;
  };
  const formerUndercounts: [string, string][] = [
    ["noscript", fill("<noscript>", "</noscript>")],
    ["template", fill("<template>", "</template>")],
    ["attribute-hidden comment", fill('<p title="><!--">', "<!-- -->")],
  ];

  for (const [name, html] of formerUndercounts) {
    it(`${name}: scan equals the parser (~23.8K) and the message goes to too_deep in < 100 ms, never reaching the worker`, { timeout: 30_000 }, async () => {
      expect(html.length).toBeLessThanOrEqual(MAX_HTML_CHARS);
      const real = oracleDepth(html);
      expect(real).toBeGreaterThan(20_000);
      expect(htmlNestingDepth(html)).toBe(real);
      const c = countingPool();
      const t0 = performance.now();
      const r = await renderEmailBody({ html, text: null }, { pool: c.pool });
      expect(performance.now() - t0).toBeLessThan(100);
      expect([r.renderKind, r.renderReason, c.count]).toEqual(["text", "too_deep", 0]);
    });
  }

  it("F1 fixed (fidelity): legacy mail with 600 unclosed <p> (parser depth ~3) now renders as html on the real worker", { timeout: 30_000 }, async () => {
    const legacy = "<html><body>" + "<p>A paragraph of an old-style newsletter.".repeat(600) + "</body></html>";
    expect(htmlNestingDepth(legacy)).toBe(oracleDepth(legacy));
    expect(htmlNestingDepth(legacy)).toBeLessThanOrEqual(3);
    const r = await renderEmailBody({ html: legacy, text: null }, { pool });
    expect([r.renderKind, r.renderReason]).toEqual(["html", null]);
    expect(r.renderedHtml).toContain("A paragraph of an old-style newsletter.");
  });
});

describe("worker robustness with misbehaving workers", () => {
  const helper = path.resolve(import.meta.dirname, "helpers/tester-workers.mjs");
  const pools: RenderPool[] = [];
  afterEach(async () => {
    for (const p of pools.splice(0)) await p.close();
    delete process.env.TESTER_WORKER_MODE;
  });
  const poolFor = (mode: string, limitMs = 500) => {
    process.env.TESTER_WORKER_MODE = mode;
    const p = new RenderPool({ workerPath: helper, limitMs, readyTimeoutMs: 2000 });
    pools.push(p);
    return p;
  };

  it("OOM (resourceLimits) becomes crash, and the next job runs on a fresh worker", { timeout: 30_000 }, async () => {
    const p = poolFor("oom", 10_000);
    const t0 = performance.now();
    const r = await renderEmailBody({ html: "<p>x</p>", text: "fallback text" }, { pool: p });
    expect([r.renderKind, r.renderReason, r.renderedText]).toEqual(["text", "crash", "fallback text"]);
    expect(performance.now() - t0).toBeLessThan(10_000);
    process.env.TESTER_WORKER_MODE = "ok";
    expect((await renderEmailBody({ html: "<p>y</p>", text: null }, { pool: p })).renderKind).toBe("html");
  });

  it("a worker stuck in catastrophic regex backtracking is terminated within the limit", { timeout: 30_000 }, async () => {
    const p = poolFor("regex", 400);
    const t0 = performance.now();
    const r = await renderEmailBody({ html: "<p>x</p>", text: null }, { pool: p });
    const ms = performance.now() - t0;
    expect([r.renderKind, r.renderReason]).toEqual(["text", "timeout"]);
    expect(ms).toBeLessThan(400 + SLACK_MS + 200);
  });

  it("a reply with the wrong id is ignored (timeout); a non-string html is a crash, never stored as html", { timeout: 30_000 }, async () => {
    const a = await renderEmailBody({ html: "<p>x</p>", text: null }, { pool: poolFor("wrong-id", 300) });
    expect([a.renderKind, a.renderReason, a.renderedHtml]).toEqual(["text", "timeout", null]);
    const b = await renderEmailBody({ html: "<p>x</p>", text: null }, { pool: poolFor("bad-shape", 300) });
    expect([b.renderKind, b.renderReason, b.renderedHtml]).toEqual(["text", "crash", null]);
  });

  it("an unknown failure reason from the worker is coerced to crash (no arbitrary strings stored)", { timeout: 30_000 }, async () => {
    const r = await renderEmailBody({ html: "<p>x</p>", text: null }, { pool: poolFor("bad-reason", 300) });
    expect([r.renderKind, r.renderReason]).toEqual(["text", "crash"]);
  });

  it("a worker that exits while handling a job gives crash, bounded, and the next job respawns", { timeout: 30_000 }, async () => {
    const p = poolFor("exit-on-job", 2000);
    const t0 = performance.now();
    const r = await renderEmailBody({ html: "<p>x</p>", text: null }, { pool: p });
    expect([r.renderKind, r.renderReason]).toEqual(["text", "crash"]);
    expect(performance.now() - t0).toBeLessThan(1000);
    process.env.TESTER_WORKER_MODE = "ok";
    expect((await renderEmailBody({ html: "<p>y</p>", text: null }, { pool: p })).renderKind).toBe("html");
  });

  it("a worker that dies while idle is replaced: jobs before and after its death both succeed", { timeout: 30_000 }, async () => {
    const p = poolFor("exit-idle", 2000);
    expect((await renderEmailBody({ html: "<p>1</p>", text: null }, { pool: p })).renderKind).toBe("html");
    await new Promise((r) => setTimeout(r, 400)); // the idle worker has exited by now
    const t0 = performance.now();
    expect((await renderEmailBody({ html: "<p>2</p>", text: null }, { pool: p })).renderKind).toBe("html");
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("an asynchronous throw inside the worker is crash, and recovery follows", { timeout: 30_000 }, async () => {
    const p = poolFor("throw-async", 2000);
    const r = await renderEmailBody({ html: "<p>x</p>", text: null }, { pool: p });
    expect([r.renderKind, r.renderReason]).toEqual(["text", "crash"]);
    process.env.TESTER_WORKER_MODE = "ok";
    expect((await renderEmailBody({ html: "<p>y</p>", text: null }, { pool: p })).renderKind).toBe("html");
  });

  it("postcheck from the worker gives text/postcheck with escaped-by-React plain text (replaces the old textOnly wiring test)", { timeout: 30_000 }, async () => {
    const r = await renderEmailBody({ html: "<p>Hello <b>there</b></p><script>x()</script><img src=x onerror=alert(1)>", text: null }, { pool: poolFor("postcheck", 1000) });
    expect([r.renderKind, r.renderReason, r.renderedHtml, r.renderedHtmlRemote]).toEqual(["text", "postcheck", null, null]);
    expect(r.renderedText).toBe("Hello there");
  });

  it("ten jobs queued at once against a timing-out worker finish in order, each bounded", { timeout: 60_000 }, async () => {
    const p = poolFor("regex", 200);
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => renderEmailBody({ html: `<p>${i}</p>`, text: null }, { pool: p })));
    const ms = performance.now() - t0;
    expect(results.every((r) => r.renderReason === "timeout")).toBe(true);
    // FIFO, one at a time: ~10 x (limit + respawn). Bounded, linear in the number of jobs.
    expect(ms).toBeLessThan(10 * (200 + 400));
  });

  it("the real bundle exists and renders both variants (positive control)", { timeout: 30_000 }, async () => {
    const p = new RenderPool({ workerPath: defaultWorkerPath() });
    pools.push(p);
    const r = await renderEmailBody({ html: '<p>Hi</p><img src="https://ok.example.org/a.png">', text: null }, { pool: p });
    expect(r.renderKind).toBe("html");
    expect(r.renderedHtml).not.toContain("ok.example.org");
    expect(r.renderedHtmlRemote).toContain('src="https://ok.example.org/a.png"');
  });
});

describe("plain-text scanner on hostile input (18m)", () => {
  it("output is text: markup and decoded entities stay text, and the page shows them escaped", () => {
    const hostile = [
      "&lt;script&gt;alert(1)&lt;/script&gt;",
      "&#60;img src=x onerror=alert(1)&#62;",
      "&#x3C;iframe src=javascript:alert(1)&#x3E;",
      "<scr<script>ipt>alert(1)</script>",
      "<<img src=x onerror=alert(1)>>",
      "</pre><script>alert(1)</script>",
      "<a href=\"javascript:alert(1)\">click</a>",
      "<svg><script>alert(1)</script></svg>",
      "&#0; &#xD800; &#1114112; &#99999999999; &amp;amp;",
      "<!-- unterminated",
    ].join("\n");
    const { text } = htmlToPlainText(hostile);
    const markup = renderToStaticMarkup(
      createElement(MessageBody, {
        message: { ...msg, renderKind: "text", renderReason: "postcheck", renderedText: text, sanitizerVersion: 1 },
        threadId: "t",
        remoteOn: false,
      }),
    );
    // Whatever the scanner produced, the page shows it as escaped text inside <pre>, never as markup.
    expect(markup).not.toMatch(/<script|<img|<iframe|<svg|<a href/i);
    expect(markup).toContain("&lt;script&gt;");
    expect(markup.match(/<pre[^>]*>/g)?.length).toBe(1);
    expect(markup).not.toContain("</pre><script");
    expect(text).toContain("�"); // invalid references
  });

  it("caps: MAX_PLAINTEXT_INPUT and MAX_RENDERED_TEXT set truncated; body_text over the cap is truncated too", () => {
    expect(htmlToPlainText("a".repeat(MAX_PLAINTEXT_INPUT + 1)).truncated).toBe(true);
    const out = htmlToPlainText("ab ".repeat(MAX_RENDERED_TEXT));
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(MAX_RENDERED_TEXT);
    const t = renderPlainText("<p>x</p>", "t".repeat(MAX_RENDERED_TEXT + 1));
    expect([t.truncated, t.text.length]).toEqual([true, MAX_RENDERED_TEXT]);
    expect(htmlToPlainText("a".repeat(MAX_RENDERED_TEXT)).truncated).toBe(false);
  });

  it("4 MiB of each hostile shape scans in under 150 ms in-process (fresh-process doubling is in the report)", { timeout: 60_000 }, () => {
    const M = MAX_PLAINTEXT_INPUT;
    const fit = (u: string) => u.repeat(Math.floor(M / u.length));
    const shapes = [
      fit("<a "), fit("<a b='>'"), fit("</"), fit("<!"), fit("<!--"), fit("<?"), fit("&#"), fit("&#x"), fit("&#12345678"), fit("&am"), fit("&"),
      "<script>" + fit("<"), fit("<script></script>"), fit("<scriptx>"), fit("<" + "a".repeat(40)), fit("<br/>"), fit("<p>\n\n\n"), fit("\r\n\r\n\r\n"),
      fit("<x y=\"1\" z='2' w=3>"), fit("<noscript>"), fit("<textarea>a</textarea>"),
    ];
    for (const s of shapes) {
      const t0 = performance.now();
      htmlToPlainText(s);
      htmlNestingDepth(s);
      expect(performance.now() - t0, s.slice(0, 20)).toBeLessThan(150 * 2); // both functions
    }
  });
});

const msg: BodyMessage = {
  id: "11111111-1111-4111-8111-111111111111",
  isSent: false,
  fromHeader: "Ann <ann@example.com>",
  bodyText: null,
  bodyIncomplete: false,
  renderKind: null,
  renderReason: null,
  renderedHtml: null,
  renderedHtmlRemote: null,
  renderedText: null,
  renderTruncated: false,
  sanitizerVersion: null,
};

describe("version gate on the page (18o) with MIN_DISPLAYABLE_SANITIZER_VERSION bumped", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/email/version");
    vi.resetModules();
  });

  it("stored html below MIN is not displayed: body_text or 'being prepared'; text renderings still show", async () => {
    vi.resetModules();
    vi.doMock("@/lib/email/version", async (orig) => ({ ...(await orig<object>()), MIN_DISPLAYABLE_SANITIZER_VERSION: 2, SANITIZER_VERSION: 2 }));
    const { MessageBody: MB } = await import("@/app/(app)/inbox/[threadId]/message-body");
    const render = (m: Partial<BodyMessage>) => renderToStaticMarkup(createElement(MB, { message: { ...msg, ...m }, threadId: "t", remoteOn: true }));
    const stale = { renderKind: "html" as const, renderedHtml: "<p>OLDHTML</p>", renderedHtmlRemote: "<p>OLDREMOTE</p>", sanitizerVersion: 1 };
    expect(render({ ...stale, bodyText: "plain body" })).not.toMatch(/OLDHTML|OLDREMOTE|iframe/);
    expect(render({ ...stale, bodyText: "plain body" })).toContain("plain body");
    expect(render(stale)).toContain("being prepared for display");
    expect(render({ ...stale, sanitizerVersion: 2 })).toContain("iframe");
    expect(render({ renderKind: "text", renderReason: "timeout", renderedText: "TXT", sanitizerVersion: 1 })).toContain("TXT");
    expect(render({ renderKind: "html", renderedHtml: "<p>X</p>", sanitizerVersion: null })).not.toContain("iframe");
  });
});
