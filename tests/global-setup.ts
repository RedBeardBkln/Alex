import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Builds the render-worker bundle (.alex-build/render-worker.mjs) before any test file runs, so
 * tests started directly with `npx vitest` find it too (`npm test` also builds it via pretest).
 */
export default function setup(): void {
  const script = path.resolve(import.meta.dirname, "../scripts/build-render-worker.mjs");
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`render worker build failed:\n${r.stderr}`);
}
