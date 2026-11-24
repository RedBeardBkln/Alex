import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as cur from "@/lib/approvals/warnings";
import * as base from "./helpers/links-baseline";

// phase-h1-link-hardening A4: the link rules compared with a frozen copy of main's warnings.ts
// (tests/helpers/links-baseline.ts) on three corpora: the tracked docs, the attack corpus
// (tests/fixtures/links-attack-corpus.txt) and seeded random tokens.
// - EXACT: every output is equal (used while refactoring).
// - SUPERSET: new rules may only add warnings. hostsIn (the known set) stays exactly equal, every
//   baseline display is still found, and every baseline-flagged display is still flagged for the same thread.
// Added displays and flags are printed per corpus.
const MODE = "SUPERSET" as "EXACT" | "SUPERSET";

const ROOT = path.resolve(import.meta.dirname, "..");
const K = "see https://bank.test/ and https://www.google.test/";
const KE = `${K} evil.test 203.0.113.9`;

function docLines(): string[] {
  const files = ["README.md", "CLAUDE.md"];
  for (const dir of ["docs", ".claude/agents", ".claude/commands"]) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) if (f.endsWith(".md")) files.push(path.join(dir, f));
  }
  return files.flatMap((f) => fs.readFileSync(path.join(ROOT, f), "utf8").split("\n"));
}

function attackLines(): string[] {
  return fs
    .readFileSync(path.join(ROOT, "tests/fixtures/links-attack-corpus.txt"), "utf8")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => (l.startsWith("json:") ? (JSON.parse(l.slice(5)) as string) : l));
}

/** mulberry32: a small deterministic PRNG (no dependency). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cp = (c: number) => String.fromCodePoint(c);
const PIECES = [
  ...":/@&=%?#.-_+".split(""),
  cp(92),
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  "http", "https", "ftp", "file", "smb", "ms-x", "search-ms", "onenote", "xn--p1ai",
  "bank.test", "evil.test", "203.0.113.9",
  "%2F", "%3A", "%40", "%25", "%2540", "%5C", "%3F", "%23", "%26", "%C3%A9", "%FF",
  cp(0xa0), cp(0xad), cp(0x200b), cp(0x201c), cp(0xab),
];

/**
 * Whole candidate shapes, so a token often holds a new-rule candidate (an `=//`/`//`/`_://` glue
 * userinfo, a `scheme:\\`, a reset before `\\`) before or after a main candidate. Single characters
 * almost never build these (tester round 1, D1).
 */
const BS = cp(92);
const SHAPE_PIECES = [
  "=//", "//", "_://", "://", "https://", "http:", "ftp://", "x://", "file:", "search:", "ms-x:", "u=", "e=",
  "x@", "y@", "=1@", "u:p=w@", "a@", "&e=", "&", "=", "@", "?", "#", "/", ":", ".", "a", "1",
  "ab:", "onenote:", "a.b:", "c:", BS, BS + BS, BS + "/", "/" + BS,
  "bank.test", "evil.test", "203.0.113.9", "x.pdf",
  "%2F", "%3A", "%40", "%2540", "%5C", "%26", "%3D", "%3F", "%20", "%09", "%0A", "%22",
  cp(0xa0), cp(0xad), cp(0x200b), cp(0x3164), cp(0x2003),
];

function randomTokens(seed: number, count: number, pieces = PIECES, maxLen = 80): string[] {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = 1 + Math.floor(rnd() * maxLen);
    const parts: string[] = [];
    for (let j = 0; j < len; j++) parts.push(pieces[Math.floor(rnd() * pieces.length)]!);
    out.push(parts.join(""));
  }
  return out;
}

type Stats = { strings: number; addedDisplays: string[]; addedFlags: string[]; mismatches: string[] };

function compareLinks(x: string, st: Stats): void {
  const bl = base.linksIn(x);
  const nl = cur.linksIn(x);
  const bh = [...base.hostsIn(x)].sort();
  const nh = [...cur.hostsIn(x)].sort();
  if (JSON.stringify(bh) !== JSON.stringify(nh)) st.mismatches.push(`hostsIn ${JSON.stringify(x)}: ${JSON.stringify(bh)} -> ${JSON.stringify(nh)}`);
  if (MODE === "EXACT") {
    if (JSON.stringify(bl) !== JSON.stringify(nl)) st.mismatches.push(`linksIn ${JSON.stringify(x)}: ${JSON.stringify(bl)} -> ${JSON.stringify(nl)}`);
  } else {
    const ns = new Set(nl);
    for (const d of bl) if (!ns.has(d)) st.mismatches.push(`linksIn lost ${JSON.stringify(d)} in ${JSON.stringify(x)}`);
  }
  const bs = new Set(bl);
  for (const d of nl) if (!bs.has(d)) st.addedDisplays.push(d);
}

function compareFlags(draft: string, thread: string, label: string, st: Stats): void {
  const bf = base.linksNotInThread(draft, thread);
  const nf = cur.linksNotInThread(draft, thread);
  if (MODE === "EXACT") {
    if (JSON.stringify(bf) !== JSON.stringify(nf)) st.mismatches.push(`flags(${label}) ${JSON.stringify(draft)}: ${JSON.stringify(bf)} -> ${JSON.stringify(nf)}`);
  } else {
    const ns = new Set(nf);
    for (const d of bf) if (!ns.has(d)) st.mismatches.push(`flag lost (${label}) ${JSON.stringify(d)} in ${JSON.stringify(draft)}`);
  }
  const bs = new Set(bf);
  for (const d of nf) if (!bs.has(d)) st.addedFlags.push(`${label}: ${d}`);
}

function runCorpus(name: string, lines: string[]): Stats {
  const st: Stats = { strings: lines.length, addedDisplays: [], addedFlags: [], mismatches: [] };
  for (const x of lines) {
    compareLinks(x, st);
    compareFlags(x, x, "self", st);
    compareFlags(x, K, "K", st);
    compareFlags(x, KE, "KE", st);
  }
  report(name, st);
  return st;
}

/** A rough per-rule grouping of added flags, for the coder's Gate C report (the display alone decides it). */
function ruleOf(d: string): string {
  const BS = cp(92);
  if (/%[0-9a-f]{2}/i.test(d)) return "C3 (decoding)";
  if (/[a-z0-9+.-]{2,}:[\\/][\\/]/i.test(d) && d.includes(BS)) return "C4 (scheme + UNC)";
  if (d.includes(BS + BS) || d.includes(BS + "/") || d.includes("/" + BS)) return "C5 (lead-run reset)";
  if (d.includes("@") && (d.includes("&") || d.includes("="))) return "C2 (glue run)";
  return "other";
}

function report(name: string, st: Stats): void {
  const groups = new Map<string, number>();
  for (const f of st.addedFlags) {
    const r = ruleOf(f.slice(f.indexOf(": ") + 2));
    groups.set(r, (groups.get(r) ?? 0) + 1);
  }
  console.log(
    `[h1-differential ${MODE}] ${name}: ${st.strings} strings, ${st.addedDisplays.length} added displays, ${st.addedFlags.length} added flags ${JSON.stringify(Object.fromEntries(groups))}, ${st.mismatches.length} mismatches`,
  );
  if (process.env.H1_DIFF_VERBOSE) for (const f of st.addedFlags.slice(0, 200)) console.log(`  + ${JSON.stringify(f)}`);
}

describe(`H1 links differential against main 82c6255 (${MODE})`, () => {
  it("the baseline copy differs from main only in its import lines", () => {
    const text = fs.readFileSync(path.join(ROOT, "tests/helpers/links-baseline.ts"), "utf8");
    expect(text).toContain('import { replySubject } from "@/lib/gmail/compose";');
    expect(text).toContain('import { findInvisible, hasBidiControl } from "@/lib/approvals/text";');
    // Without the 5 header lines and with the original relative import, it is byte-identical to main
    // (the sha256 of `git show 82c6255:src/lib/approvals/warnings.ts`).
    const lines = text.split("\n").slice(5);
    lines[1] = 'import { findInvisible, hasBidiControl } from "./text";';
    expect(createHash("sha256").update(lines.join("\n")).digest("hex")).toBe("a278c0566789cbab55ea348c0e249c86236ff0226bb9cc33d338147969a783cd");
  });

  it("no src file imports the baseline or anything under tests/", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) {
          const t = fs.readFileSync(p, "utf8");
          if (t.includes("links-baseline") || /from\s+["'][^"']*tests\//.test(t)) hits.push(p);
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(hits).toEqual([]);
  });

  it("docs corpus", { timeout: 120_000 }, () => {
    const st = runCorpus("docs", docLines());
    expect(st.strings).toBeGreaterThan(500);
    expect(st.mismatches.slice(0, 20)).toEqual([]);
  });

  it("attack corpus", { timeout: 120_000 }, () => {
    const lines = attackLines();
    expect(lines.length).toBeGreaterThan(1_000);
    const st = runCorpus("attack", lines);
    expect(st.mismatches.slice(0, 20)).toEqual([]);
  });

  it("seeded random tokens and (draft, haystack) pairs", { timeout: 300_000 }, () => {
    const toks = randomTokens(0x4831, 20_000);
    const st = runCorpus("random", toks);
    const rnd = mulberry32(0x4832);
    const pick = () => toks[Math.floor(rnd() * toks.length)]!;
    const pairs: Stats = { strings: 2_000, addedDisplays: [], addedFlags: [], mismatches: [] };
    for (let i = 0; i < 2_000; i++) {
      const draft = rnd() < 0.5 ? pick() : `${pick()} ${pick()}`;
      const hay = rnd() < 0.5 ? pick() : `${pick()} ${pick()} ${pick()}`;
      compareFlags(draft, hay, "pair", pairs);
    }
    report("random pairs", pairs);
    expect(st.mismatches.slice(0, 20)).toEqual([]);
    expect(pairs.mismatches.slice(0, 20)).toEqual([]);
  });

  it("seeded random tokens of whole candidate shapes", { timeout: 300_000 }, () => {
    const st = runCorpus("shapes", randomTokens(0x4833, 30_000, SHAPE_PIECES, 12));
    expect(st.mismatches.slice(0, 20)).toEqual([]);
  });
});
