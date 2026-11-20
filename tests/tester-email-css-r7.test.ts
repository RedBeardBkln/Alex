import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_CSS_CHARS, MAX_CSS_PER_MESSAGE, sanitizeStylesheet } from "@/lib/email-css";
import { RENDER_LIMIT_MS } from "@/lib/email/render";
import { emailDocument, MAX_HTML_CHARS } from "@/lib/email-html";

// Tester rounds 7–9: AC 18j. Revision 4 (round 9) replaced the whole-thread view-time sanitize bound:
// sanitizing now happens once at ingest, in a worker with a hard 2 s limit per job; page views only
// read stored output (view-time bound: tester-email-html-r5 and the coder's email-page test).
// Caps: MAX_CSS_CHARS = MAX_CSS_PER_MESSAGE = 128 Ki; MAX_HTML_CHARS = 256 Ki (Revision 4).

const C = MAX_CSS_CHARS;
const fit = (unit: string, max: number) => unit.repeat(Math.floor(max / unit.length));
const SLACK_MS = 250;

type Job = { ms: number; kind: string; reason: string | null; len: number; dispatched: number };
const helper = path.resolve(import.meta.dirname, "helpers/tester-time-thread.mjs");
function freshProcessJobs(set: string): Job[] {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", helper, set], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`helper failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as Job[];
}

describe("AC 18j (Revision 4): ingest-time bound per job, fresh Node process, real bundled worker", () => {
  it("my heaviest 8 within-cap messages: every job ends within RENDER_LIMIT_MS + slack, as html or text/timeout", { timeout: 180_000 }, () => {
    const jobs = freshProcessJobs("heaviest8");
    expect(jobs).toHaveLength(8);
    for (const j of jobs) {
      expect(j.len).toBeLessThanOrEqual(MAX_HTML_CHARS);
      expect(j.ms, JSON.stringify(j)).toBeLessThan(RENDER_LIMIT_MS + SLACK_MS);
      expect(j.kind === "html" || (j.kind === "text" && j.reason === "timeout"), JSON.stringify(j)).toBe(true);
    }
  });

  it("W1 shapes (deep nesting within the cap, just over it, 1 MB over it, <b>/<x>/<div><span>): text in < 100 ms each, never dispatched", { timeout: 180_000 }, () => {
    const jobs = freshProcessJobs("w1");
    for (const j of jobs) {
      expect(j.kind, JSON.stringify(j)).toBe("text");
      expect(["too_deep", "too_large"]).toContain(j.reason);
      expect(j.dispatched, JSON.stringify(j)).toBe(0);
      expect(j.ms, JSON.stringify(j)).toBeLessThan(100);
    }
  });

  it("follow-up F1/H1: nesting formerly hidden from the depth scan (noscript, template, attribute-hidden comment) is now caught before the worker", { timeout: 180_000 }, () => {
    const jobs = freshProcessJobs("hidden");
    for (const j of jobs) {
      expect(j.dispatched, JSON.stringify(j)).toBe(0);
      expect([j.kind, j.reason], JSON.stringify(j)).toEqual(["text", "too_deep"]);
      expect(j.ms, JSON.stringify(j)).toBeLessThan(100);
    }
  });
});

describe("Round 8 caps: exactly 131,072 and +1 (owner Round 7)", () => {
  it("both caps are 128 Ki UTF-16 code units", () => {
    expect(MAX_CSS_CHARS).toBe(131_072);
    expect(MAX_CSS_PER_MESSAGE).toBe(131_072);
  });

  it("per block and per attribute: 131,072 is parsed and kept, 131,073 is dropped, the message stays safe HTML", () => {
    const block = (n: number) => "a{color:red}" + " ".repeat(n - 12);
    const attr = (n: number) => "color:red" + " ".repeat(n - 9);
    for (const opts of [{ allowRemoteImages: false }, { allowRemoteImages: true }]) {
      const okB = emailDocument(`<style>${block(131_072)}</style><p>t</p>`, opts);
      expect(okB).toContain("<style>a{color:red}</style>");
      const overB = emailDocument(`<style>${block(131_073)}</style><p>t</p>`, opts);
      expect(overB).not.toContain("a{color:red}");
      expect(overB).toContain("<p>t</p>");
      const okA = emailDocument(`<p style="${attr(131_072)}">t</p>`, opts);
      expect(okA).toContain('<p style="color:red">t</p>');
      const overA = emailDocument(`<p style="${attr(131_073)}">t</p>`, opts);
      expect(overA).toContain("<p>t</p>");
      expect(overA).not.toContain("color:red");
    }
  });

  it("per message: a block plus an attribute totalling exactly 131,072 both render; one unit more drops the later CSS only", () => {
    const attrText = (n: number) => "color:blue" + " ".repeat(n - 10);
    const blockText = (n: number) => "a{color:red}" + " ".repeat(n - 12);
    // sanitize-html charges style attributes as it parses, style elements afterwards (coder's note).
    const exact = emailDocument(`<p style="${attrText(65_536)}">t</p><style>${blockText(65_536)}</style>`);
    expect(exact).toContain('style="color:blue"');
    expect(exact).toContain("<style>a{color:red}</style>");
    const over = emailDocument(`<p style="${attrText(65_536)}">t</p><style>${blockText(65_537)}</style><p>after</p>`);
    expect(over).toContain('style="color:blue"');
    expect(over).not.toContain("a{color:red}");
    expect(over).toContain("<p>after</p>");
  });
});

// Sanitizer speed (both variants, in-process). Under Revision 4 this work runs in the worker at ingest,
// once per message; these stay as a stricter check that normal worst cases fit well inside the 2 s limit.
describe("sanitizer speed, both variants in-process, each message spending its whole 128 K CSS budget with real parsing", () => {
  function renderThread(msgs: string[]): number {
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(MAX_HTML_CHARS);
    emailDocument("<p>warm-up</p>");
    const t0 = performance.now();
    for (const m of msgs) {
      emailDocument(m, { allowRemoteImages: false });
      emailDocument(m, { allowRemoteImages: true });
    }
    return performance.now() - t0;
  }

  it("8 messages, each spending its full MAX_CSS_PER_MESSAGE budget on long value lists (V1 shapes), both modes, under 2 s", { timeout: 120_000 }, () => {
    expect(MAX_CSS_PER_MESSAGE).toBe(C);
    const blocks = [
      `a{font-family:${fit("x ", C - 30)}}`,
      `a{font-family:${fit("x,", C - 30)}y}`,
      `a{color:${fit("rgb(1,2,3) ", C - 30)}}`,
      `a{font:${fit("1px/2px ", C - 30)}}`,
      `a{color:${fit("hsl(10deg,20%,30%) ", C - 30)}}`,
    ];
    // Each block fits the cap and is really parsed (non-empty output), so the budget is spent on parsing.
    for (const b of blocks) {
      expect(b.length).toBeLessThanOrEqual(C);
      expect(sanitizeStylesheet(b).length).toBeGreaterThan(C / 8);
    }
    const ms = renderThread([
      ...blocks.map((b) => `<style>${b}</style>`),
      `<p style="font-family:${fit("x ", C - 30)}">a</p>`,
      `<p style="margin:${fit("1.25px ", C - 30)}">a</p>`,
      fit("<td style=\"padding:0 1px;color:#fff;font-family:'A',b\">x</td>", MAX_HTML_CHARS - 100),
    ]);
    expect(ms).toBeLessThan(2000);
  });

  it("8 mixed worst-case messages within the 256 KiB cap (style attributes, bad-string floods, media/selector-heavy, nesting 31, U1 attributes), both variants, under 2 s in total", { timeout: 120_000 }, () => {
    const ms = renderThread([
      fit('<b style="color:red;margin:0 auto">x</b>', MAX_HTML_CHARS - 100),
      `<style>${fit('a{x:"\n}', C - 20)}</style>`,
      `<style>${fit("a{background:url(data:x)}", C - 20)}</style>`,
      `<style>${fit("@media (max-width:600px){.a > .b + c:hover{color:rgb(1,2,3);margin:0 1px 2px 3px}}", C - 20)}</style>`,
      `<style>${fit("a{x:" + "(".repeat(30) + ")".repeat(30) + "}", C - 20)}</style>`,
      `<style>a{background:url(${" ".repeat(C - 40)}x</style>`,
      fit('<p style="background:url(&quot;data:,x&#10;);background:url(https://e.example.com/a);y:&quot;)">x</p>', MAX_HTML_CHARS - 100),
      ("<p>Hello <b>world</b> " + "lorem ipsum ".repeat(30) + "</p>").repeat(600),
    ]);
    expect(ms).toBeLessThan(2000);
  });
});
