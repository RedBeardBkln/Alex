import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { RenderPool, renderEmailBody } from "@/lib/email/render";
import { EMAIL_ALLOWED_TAGS, isStructurallySafe as postcheckFn } from "@/lib/email/postcheck";
import { isStructurallySafe as htmlFn } from "@/lib/email-html";

// Tester round 10: the main-thread re-check of worker HTML (security W1) against a lying worker,
// in either variant; and the import-free, single-source properties of postcheck.ts.

const helper = path.resolve(import.meta.dirname, "helpers/tester-workers.mjs");
const pools: RenderPool[] = [];
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
  delete process.env.TESTER_WORKER_MODE;
  delete process.env.TESTER_WORKER_REPLY;
});

/** Renders through a fresh worker that replies ok with exactly this html/remote. */
async function withWorkerReply(html: unknown, remote: unknown) {
  process.env.TESTER_WORKER_MODE = "reply";
  process.env.TESTER_WORKER_REPLY = JSON.stringify({ html, remote });
  const pool = new RenderPool({ workerPath: helper, limitMs: 2000, readyTimeoutMs: 2000 });
  pools.push(pool);
  return renderEmailBody({ html: "<p>original</p>", text: "fallback text" }, { pool });
}

// Structural breakouts a stale or buggy worker could emit (each would let markup escape the allowlist).
const STRUCTURAL = [
  "<script>alert(1)</script>",
  "<SCRIPT SRC=x></SCRIPT>",
  "<iframe src=https://e.example.com></iframe>",
  '<meta http-equiv="refresh" content="0;url=https://e.example.com">',
  '<base href="https://e.example.com/">',
  '<link rel=stylesheet href="https://e.example.com/x.css">',
  "<svg><a href=x>y</a></svg>",
  "<math><mi>x</mi></math>",
  "<form action=https://e.example.com><input></form>",
  "<object data=x></object><embed src=x>",
  "<style>a{}</style><meta http-equiv=refresh content=0>",
  "<style>a{color:red}<img src=x></style>",
  "<style>a{}",
  "<style",
  "<!-- <img src=x onerror=alert(1)> -->",
  "<!DOCTYPE html><p>x</p>",
  "<textarea><img src=x></textarea>",
  "<noscript><img src=x></noscript>",
  "< script>alert(1)</script>",
  "<p title=\"<script>\">x</p>",
  "<style title=\">\"><script>alert(1)</script></style>",
];

describe("main-thread re-check rejects structural breakouts from the worker, in either variant", () => {
  for (const bad of STRUCTURAL) {
    it(`default variant: ${bad.slice(0, 50)}`, { timeout: 20_000 }, async () => {
      const r = await withWorkerReply(`<p>ok</p>${bad}`, null);
      expect([r.renderKind, r.renderReason, r.renderedHtml, r.renderedHtmlRemote]).toEqual(["text", "postcheck", null, null]);
      expect(r.renderedText).toBe("fallback text");
    });
    it(`remote variant only: ${bad.slice(0, 50)}`, { timeout: 20_000 }, async () => {
      const r = await withWorkerReply("<p>safe default</p>", `<p>ok</p>${bad}`);
      expect([r.renderKind, r.renderReason, r.renderedHtml, r.renderedHtmlRemote]).toEqual(["text", "postcheck", null, null]);
    });
  }

  it("a well-formed safe reply is still stored as html with both variants (positive control)", { timeout: 20_000 }, async () => {
    const r = await withWorkerReply('<p>ok <b>x</b></p><style>a{color:red}</style>', '<p>ok <img src="https://ok.example.org/a.png"></p>');
    expect([r.renderKind, r.renderReason]).toEqual(["html", null]);
    expect(r.renderedHtmlRemote).toContain("ok.example.org");
  });
});

describe("postcheck.ts: import-free, single source of truth, unchanged semantics", () => {
  it("has no import, require or dynamic import (comments stripped)", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "../src/lib/email/postcheck.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/\bimport\b|\brequire\s*\(|\bimport\s*\(/);
  });

  it("email-html.ts re-exports the same function, and the allowlist is the same 68 tags as rounds 1–9", () => {
    expect(htmlFn).toBe(postcheckFn);
    const round9 = [
      "a", "abbr", "address", "article", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite",
      "code", "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font",
      "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark",
      "ol", "p", "pre", "q", "s", "samp", "section", "small", "span", "strike", "strong", "style", "sub", "sup",
      "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "var", "wbr",
    ];
    expect([...EMAIL_ALLOWED_TAGS].sort()).toEqual([...round9].sort());
  });
});
