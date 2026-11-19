// Fresh-process timing for the plain-text scanner (AC 18m): node time-plain.mjs <fn> <shape> <n>
// fn: depth | text. Prints the best-of-3 milliseconds for one generated input of about n code units.
import { pathToFileURL } from "node:url";
import path from "node:path";

const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../src/lib/email/plain-text.ts")).href);
const [fn, shape, nArg] = process.argv.slice(2);
const n = Number(nArg);
const fill = (unit) => unit.repeat(Math.max(1, Math.floor(n / unit.length)));
const shapes = {
  "nested-div": () => fill("<div>"),
  "nested-b": () => fill("<b>"),
  "unclosed-x": () => fill("<x>"),
  "div-span": () => fill("<div><span>"),
  "lt-flood": () => fill("<"),
  "comment-flood": () => fill("<!--"),
  "unterminated-raw": () => fill("<script>a"),
  "entity-flood": () => fill("&#99999999999"),
  "long-tag-names": () => fill(`<${"a".repeat(200)} `),
  "attribute-soup": () => fill('<p a="1" b=\'2\' c=3 d '),
  "text-and-tags": () => fill("<p>Hello &amp; welcome</p><br>"),
};
const input = shapes[shape]();
const run = fn === "depth" ? () => mod.htmlNestingDepth(input) : () => mod.htmlToPlainText(input);
run();
let best = Infinity;
for (let i = 0; i < 3; i++) {
  const s = performance.now();
  run();
  best = Math.min(best, performance.now() - s);
}
process.stdout.write(String(best));
