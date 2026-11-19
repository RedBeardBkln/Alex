// Child-process timing helper for doubling tests: node time-css.mjs <shape> <n>
// Prints the best-of-3 milliseconds for sanitizeStylesheet on one generated input.
import { pathToFileURL } from "node:url";
import path from "node:path";

const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../src/lib/email-css.ts")).href);
const [shape, nArg] = process.argv.slice(2);
const n = Number(nArg);
const shapes = {
  "font-family-list": (k) => `a{font-family:${"x ".repeat(k)}}`,
  "comma-list": (k) => `a{font-family:${"x,".repeat(k)}y}`,
  "colour-list": (k) => `a{text-shadow:${"1px 1px #fff,".repeat(k)}0 0 #000}`,
  "attribute-list": (k) => `margin:${"1px ".repeat(k)}`,
};
const make = shapes[shape];
const input = make(n);
const run = shape === "attribute-list" ? () => mod.sanitizeStyleAttribute(input) : () => mod.sanitizeStylesheet(input);
run(); // warm-up
let best = Infinity;
for (let i = 0; i < 3; i++) {
  const s = performance.now();
  run();
  best = Math.min(best, performance.now() - s);
}
process.stdout.write(String(best));
