import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LINK_TIMING_CASES } from "./helpers/link-timing-cases";

// phase-h1-link-hardening A5 / AC-10: the link scanner is linear, timed in a fresh process per case, size
// and mode (no shared JIT or heap state). By default only the H1 cases run; LINK_TIMING_ALL=1 runs every
// case, including those of the existing in-process guards.
// Bounds: t(1 Mi) < 2,000 ms and t(2 Mi) / max(t(1 Mi), 20) < 3.0. A ratio miss is re-measured at 4 Mi
// (t(4 Mi) / max(t(2 Mi), 20) < 3.0) before it fails.

const helper = path.resolve(import.meta.dirname, "helpers/time-links.mjs");
const Mi = 1024 * 1024;

function fresh(name: string, n: number, mode: "draft" | "self"): number {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", helper, name, String(n), mode], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return Number(r.stdout);
}

/** LINK_TIMING_LOG=<file> appends one line per measurement (vitest hides console output of passing tests). */
const log = (line: string) => {
  if (process.env.LINK_TIMING_LOG) appendFileSync(process.env.LINK_TIMING_LOG, `${line}\n`);
};
const names = Object.keys(LINK_TIMING_CASES).filter((k) => process.env.LINK_TIMING_ALL === "1" || k.startsWith("h1:"));

describe("H1: link scanner linear time (fresh process per case, n = 1 Mi and 2 Mi)", () => {
  it("every case builds about n units", () => {
    for (const [k, gen] of Object.entries(LINK_TIMING_CASES)) {
      const len = gen(Mi).length;
      expect(len, k).toBeGreaterThan(Mi * 0.9);
      expect(len, k).toBeLessThan(Mi * 1.1);
    }
  });
  for (const name of names) {
    for (const mode of ["draft", "self"] as const) {
      it(`${name} (${mode})`, { timeout: 300_000 }, () => {
        const t1 = fresh(name, Mi, mode);
        const t2 = fresh(name, 2 * Mi, mode);
        let trace = `${t1.toFixed(1)} -> ${t2.toFixed(1)} ms`;
        log(`${name} ${mode}: ${trace}`);
        expect(t1, `1 Mi: ${trace}`).toBeLessThan(2_000);
        if (t2 / Math.max(t1, 20) >= 3.0) {
          const t4 = fresh(name, 4 * Mi, mode);
          trace += ` -> ${t4.toFixed(1)} ms (4 Mi re-measure)`;
          log(`${name} ${mode}: ${trace}`);
          expect(t4 / Math.max(t2, 20), trace).toBeLessThan(3.0);
        }
      });
    }
  }
});
