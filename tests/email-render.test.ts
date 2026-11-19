import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_HTML_CHARS } from "@/lib/email-html";
import { MAX_HTML_DEPTH, MAX_RENDER_HTML_CHARS, RENDER_LIMIT_MS, RenderPool, defaultRenderPool, renderEmailBody } from "@/lib/email/render";
import { SANITIZER_VERSION } from "@/lib/email/version";

// Plan Revision 4: AC 18j (ingest-time bound), 18l (routing), R4.3 (worker pool). The real worker
// bundle (.alex-build/render-worker.mjs) is built by tests/global-setup.ts.

const helpers = path.resolve(import.meta.dirname, "helpers");
const testWorker = path.join(helpers, "test-render-worker.mjs");
const pools: RenderPool[] = [];
const pool = (opts: ConstructorParameters<typeof RenderPool>[0]) => {
  const p = new RenderPool(opts);
  pools.push(p);
  return p;
};
afterAll(async () => {
  for (const p of pools) await p.close();
  await defaultRenderPool().close();
});

const nested = (depth: number, tag = "div") => `${`<${tag}>`.repeat(depth)}x${`</${tag}>`.repeat(depth)}`;

describe("caps line up", () => {
  it("the router's size cap equals the sanitizer's MAX_HTML_CHARS (256 Ki)", () => {
    expect(MAX_RENDER_HTML_CHARS).toBe(262_144);
    expect(MAX_HTML_CHARS).toBe(MAX_RENDER_HTML_CHARS);
    expect(RENDER_LIMIT_MS).toBe(2_000);
    expect(MAX_HTML_DEPTH).toBe(512);
  });
});

describe("18j: every job finishes or is terminated within the limit", () => {
  it("a worker that busy-loops forever is terminated: text/timeout within 2,250 ms; the next job succeeds on a respawned worker; the main thread keeps running", { timeout: 20_000 }, async () => {
    const p = pool({ workerPath: testWorker });
    expect((await p.run("<p>warm</p>")).ok).toBe(true); // spawn outside the measured window
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    const t0 = performance.now();
    const r = await renderEmailBody({ html: "<p>__BUSY__</p>", text: null }, { pool: p });
    const elapsed = performance.now() - t0;
    clearInterval(timer);
    expect(r).toMatchObject({ renderKind: "text", renderReason: "timeout", sanitizerVersion: SANITIZER_VERSION, renderedHtml: null });
    expect(elapsed).toBeGreaterThanOrEqual(RENDER_LIMIT_MS - 5);
    expect(elapsed).toBeLessThan(RENDER_LIMIT_MS + 250);
    expect(ticks).toBeGreaterThanOrEqual(100);
    const next = await renderEmailBody({ html: "<p>fine</p>", text: null }, { pool: p });
    expect(next).toMatchObject({ renderKind: "html", renderedHtml: "<p>ok</p>", renderReason: null });
  });

  it("a genuinely slow sanitize on the real worker is cut off at the limit and stored as plain text", { timeout: 20_000 }, async () => {
    const p = pool({ limitMs: 100 });
    expect((await p.run("<p>warm</p>")).ok).toBe(true);
    // Legitimate but heavy: just under both caps, nested only 400 deep, lots of styled cells.
    const cell = '<td style="padding:0 1px;color:#fff;font-family:\'A\',b">x</td>';
    const html = `${nested(400, "span")}${cell.repeat(Math.floor((MAX_HTML_CHARS - 6_000) / cell.length))}`;
    expect(html.length).toBeLessThanOrEqual(MAX_HTML_CHARS);
    const t0 = performance.now();
    const r = await renderEmailBody({ html, text: "Plain body" }, { pool: p });
    const elapsed = performance.now() - t0;
    expect(r).toMatchObject({ renderKind: "text", renderReason: "timeout", renderedText: "Plain body" });
    expect(elapsed).toBeLessThan(100 + 250);
  });
});

describe("18l: routing", () => {
  it("no HTML body: none", async () => {
    for (const html of [null, "", "   \n"]) {
      expect(await renderEmailBody({ html, text: "t" })).toMatchObject({ renderKind: "none", renderReason: null, sanitizerVersion: SANITIZER_VERSION });
    }
  });

  it("MAX_HTML_CHARS: at the cap renders as html, one more is text/too_large (no job dispatched)", async () => {
    const p = pool({ workerPath: testWorker });
    const at = "<p>".padEnd(MAX_HTML_CHARS, "a");
    expect(at.length).toBe(MAX_HTML_CHARS);
    expect((await renderEmailBody({ html: at, text: null }, { pool: p })).renderKind).toBe("html");
    const before = p.dispatched;
    const over = await renderEmailBody({ html: `${at}a`, text: null }, { pool: p });
    expect(over).toMatchObject({ renderKind: "text", renderReason: "too_large" });
    expect(p.dispatched).toBe(before);
  });

  it("depth 512 goes to the worker; 513 is text/too_deep without any job", async () => {
    const p = pool({ workerPath: testWorker });
    expect((await renderEmailBody({ html: nested(MAX_HTML_DEPTH), text: null }, { pool: p })).renderKind).toBe("html");
    expect(p.dispatched).toBe(1);
    const r = await renderEmailBody({ html: nested(MAX_HTML_DEPTH + 1), text: null }, { pool: p });
    expect(r).toMatchObject({ renderKind: "text", renderReason: "too_deep", renderedText: "x" });
    expect(p.dispatched).toBe(1);
  });

  it("void elements, self-closing tags, comments and raw-text contents don't count toward depth", async () => {
    const p = pool({ workerPath: testWorker });
    const noise = `${"<br><img src=x><hr/><x-y/>".repeat(600)}<!--${"<div>".repeat(600)}--><style>${"<div>".repeat(600)}</style><script>${"<p>".repeat(600)}</script>`;
    const r = await renderEmailBody({ html: `${noise}${nested(MAX_HTML_DEPTH)}`, text: null }, { pool: p });
    expect(r.renderKind).toBe("html");
  });

  it("an injected structural post-check failure gives text/postcheck", async () => {
    const r = await renderEmailBody({ html: "<p>__POSTCHECK__</p>", text: "fallback" }, { pool: pool({ workerPath: testWorker }) });
    expect(r).toMatchObject({ renderKind: "text", renderReason: "postcheck", renderedText: "fallback", sanitizerVersion: SANITIZER_VERSION });
  });

  it("Round 10 (W1): a well-formed worker reply with unsafe HTML is re-checked on the main thread and stored as text/postcheck", async () => {
    const p = pool({ workerPath: testWorker });
    const unsafe = await renderEmailBody({ html: "<p>__UNSAFE__</p>", text: "fallback" }, { pool: p });
    expect(unsafe).toMatchObject({ renderKind: "text", renderReason: "postcheck", renderedHtml: null, renderedHtmlRemote: null, renderedText: "fallback" });
    const unsafeRemote = await renderEmailBody({ html: "<p>__UNSAFE_REMOTE__</p>", text: null }, { pool: p });
    expect(unsafeRemote).toMatchObject({ renderKind: "text", renderReason: "postcheck", renderedHtml: null, renderedHtmlRemote: null });
    // A safe reply still goes through.
    expect((await renderEmailBody({ html: "<p>__REMOTE__</p>", text: null }, { pool: p })).renderKind).toBe("html");
  });

  it("a worker crash (exit or uncaught throw) gives text/crash, and the pool recovers", async () => {
    const p = pool({ workerPath: testWorker });
    expect(await renderEmailBody({ html: "<p>__CRASH__</p>", text: null }, { pool: p })).toMatchObject({ renderKind: "text", renderReason: "crash" });
    expect(await renderEmailBody({ html: "<p>__THROW__</p>", text: null }, { pool: p })).toMatchObject({ renderKind: "text", renderReason: "crash" });
    expect((await renderEmailBody({ html: "<p>ok</p>", text: null }, { pool: p })).renderKind).toBe("html");
  });

  it("a missing bundle gives text/worker_unavailable with sanitizer_version NULL", async () => {
    const r = await renderEmailBody({ html: "<p>Hello</p>", text: null }, { pool: pool({ workerPath: path.join(helpers, "does-not-exist.mjs") }) });
    expect(r).toMatchObject({ renderKind: "text", renderReason: "worker_unavailable", sanitizerVersion: null, renderedText: "Hello" });
  });

  it("a worker that never reports ready is unavailable after the ready timeout", { timeout: 10_000 }, async () => {
    const p = pool({ workerPath: path.join(helpers, "silent-worker.mjs"), readyTimeoutMs: 300 });
    const t0 = performance.now();
    const r = await renderEmailBody({ html: "<p>Hello</p>", text: null }, { pool: p });
    expect(r.renderReason).toBe("worker_unavailable");
    expect(performance.now() - t0).toBeLessThan(2_000);
    // Not retried immediately: the next message falls back at once.
    const t1 = performance.now();
    expect((await renderEmailBody({ html: "<p>Again</p>", text: null }, { pool: p })).renderReason).toBe("worker_unavailable");
    expect(performance.now() - t1).toBeLessThan(100);
  });

  it("the real worker: both variants, remote NULL when identical", async () => {
    const withImage = await renderEmailBody({ html: '<p style="color:red">Hi <img src="https://i.example/a.png" alt="a"></p>', text: null });
    expect(withImage.renderKind).toBe("html");
    expect(withImage.renderedHtml).toBe('<p style="color:red">Hi <img alt="a" /></p>');
    expect(withImage.renderedHtmlRemote).toBe('<p style="color:red">Hi <img src="https://i.example/a.png" alt="a" /></p>');
    const noImage = await renderEmailBody({ html: "<p>Hi <script>x</script></p>", text: null });
    expect(noImage).toMatchObject({ renderKind: "html", renderedHtml: "<p>Hi </p>", renderedHtmlRemote: null });
  });

  it("jobs queue FIFO on the single worker", async () => {
    const p = pool({ workerPath: testWorker });
    const results = await Promise.all([1, 2, 3, 4].map((i) => p.run(`<p>${i}${i === 2 ? "__REMOTE__" : ""}</p>`)));
    expect(results.map((r) => (r.ok ? r.remote : "fail"))).toEqual([null, "<p>ok remote</p>", null, null]);
  });
});

describe("W1 shapes go to text on the main thread in under 100 ms, without a worker job", () => {
  const p = pool({ workerPath: testWorker });
  const shapes: Record<string, { html: string; reason: string }> = {
    "nested <div> at 95K depth (over the size cap)": { html: nested(95_000), reason: "too_large" },
    "nested <div> within 256 KiB (about 23K deep)": { html: nested(Math.floor((MAX_HTML_CHARS - 1) / 11)), reason: "too_deep" },
    "<b> nesting": { html: nested(20_000, "b"), reason: "too_deep" },
    "unclosed unknown <x>": { html: "<x>".repeat(80_000), reason: "too_deep" },
    "<div><span> mix": { html: "<div><span>".repeat(20_000), reason: "too_deep" },
    "old textOnly shape: deep nesting plus text": { html: `${"<div>a ".repeat(30_000)}`, reason: "too_deep" },
  };
  for (const [name, { html, reason }] of Object.entries(shapes)) {
    it(name, async () => {
      const before = p.dispatched;
      const t0 = performance.now();
      const r = await renderEmailBody({ html, text: null }, { pool: p });
      expect(performance.now() - t0).toBeLessThan(100);
      expect(r).toMatchObject({ renderKind: "text", renderReason: reason });
      expect(p.dispatched).toBe(before);
    });
  }
});
