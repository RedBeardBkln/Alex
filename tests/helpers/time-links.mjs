// Fresh-process timing for the link scanner (phase-h1-link-hardening A5):
//   node --experimental-transform-types --no-warnings time-links.mjs <case> <n> <draft|self>
// draft: linksNotInThread(s, "see https://bank.test/"); self: linksNotInThread(s, s).
// Prints the best-of-3 milliseconds (after one untimed run) for the input of about n units.
// --experimental-transform-types (not strip-types): warnings.ts imports gmail/compose.ts, which has a
// TypeScript parameter property. The resolve hook maps the `@/` alias to src/.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

register(pathToFileURL(path.resolve(import.meta.dirname, "ts-resolve-hook.mjs")).href);
const { linksNotInThread } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../src/lib/approvals/warnings.ts")).href);
const { LINK_TIMING_CASES } = await import(pathToFileURL(path.resolve(import.meta.dirname, "link-timing-cases.ts")).href);

const [name, nArg, mode] = process.argv.slice(2);
const gen = LINK_TIMING_CASES[name];
if (!gen) throw new Error(`unknown case ${name}`);
if (mode !== "draft" && mode !== "self") throw new Error(`unknown mode ${mode}`);
const s = gen(Number(nArg));
const run = mode === "draft" ? () => linksNotInThread(s, "see https://bank.test/") : () => linksNotInThread(s, s);
run();
let best = Infinity;
for (let i = 0; i < 3; i++) {
  const t0 = performance.now();
  run();
  best = Math.min(best, performance.now() - t0);
}
process.stdout.write(String(best));
