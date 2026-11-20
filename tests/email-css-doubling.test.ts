import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Round 7 (V1): doubling tests for one long declaration value list, each size timed in a fresh
// Node process (tests/helpers/time-css.mjs loads src/lib/email-css.ts with type stripping), so
// JIT state and heap growth from earlier sizes can't skew the ratio. AC 18j: ≈2.5× per doubling.

const helper = path.resolve(import.meta.dirname, "helpers/time-css.mjs");

function timeInFreshProcess(shape: string, n: number): number {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", helper, shape, String(n)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`helper failed: ${r.stderr}`);
  return Number(r.stdout);
}

/** Best of two fresh-process measurements, floored at 2 ms so tiny timings don't dominate the ratio. */
const measure = (shape: string, n: number) => Math.max(2, Math.min(timeInFreshProcess(shape, n), timeInFreshProcess(shape, n)));

// Sizes keep 4n inside MAX_CSS_CHARS (128 Ki code units, owner Round 7); over the cap the CSS
// is dropped without work, which would make the ratio meaningless.
const shapes: [string, number][] = [
  ["font-family-list", 16_000], // a{font-family:x x x …}, 4n = 128,015 code units
  ["comma-list", 16_000], // a{font-family:x,x,x,…}
  ["colour-list", 2_000], // a{text-shadow:1px 1px #fff,…}, 4n = 104,000+
  ["attribute-list", 8_000], // style="margin:1px 1px …", 4n = 128,007
];

describe("AC 18j whole-thread bound, as restated by the owner (Round 7)", () => {
  const threadHelper = path.resolve(import.meta.dirname, "helpers/time-thread.mjs");
  for (const mode of ["off", "on"]) {
    it(`8 worst-case messages within the caps, one mode (${mode}), fresh process: under 2 s`, { timeout: 120_000 }, () => {
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", threadHelper, mode], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(r.status, r.stderr).toBe(0);
      const ms = Number(r.stdout);
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeLessThan(2000);
    });
  }
});

describe("V1: one long declaration value list is linear (fresh process per size)", () => {
  for (const [shape, n] of shapes) {
    it(`${shape}: n, 2n, 4n`, { timeout: 120_000 }, () => {
      const t1 = measure(shape, n);
      const t2 = measure(shape, 2 * n);
      const t4 = measure(shape, 4 * n);
      const trace = `${shape}: ${t1} -> ${t2} -> ${t4} ms`;
      // AC 18j: about 2.5x per doubling, so 4n/n stays under 2.5² = 6.25. A single step may
      // reach 3x from GC noise at these small (~15 ms) sizes; quadratic growth would be ~16x.
      expect(t4 / t1, trace).toBeLessThan(6.25);
      expect(t2 / t1, trace).toBeLessThan(3);
      expect(t4 / t2, trace).toBeLessThan(3);
      expect(t4).toBeLessThan(500);
    });
  }
});
