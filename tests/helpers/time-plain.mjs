// Fresh-process timing for the plain-text scanner (AC 18m): node time-plain.mjs <fn> <shape> <n>
// fn: depth | depth-bounded | text. Prints the best-of-3 milliseconds for one generated input of about n code units.
import { pathToFileURL } from "node:url";
import path from "node:path";

const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../src/lib/email/plain-text.ts")).href);
const [fn, shape, nArg] = process.argv.slice(2);
const n = Number(nArg);
const fill = (unit) => unit.repeat(Math.max(1, Math.floor(n / unit.length)));
const distinct = (unit) => {
  const parts = [];
  for (let i = 0, len = 0; len < n; i++) {
    const t = unit(`t${i.toString(36)}`);
    parts.push(t);
    len += t.length;
  }
  return parts.join("");
};
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
  // Follow-up F1/H1 shapes for the parser-modelling depth scan.
  "div-selfclose": () => fill("<div/>"),
  "div-stray-close": () => fill("<div></zz>"),
  "p-flood": () => fill("<p>x"),
  "li-flood": () => `<ul>${fill("<li>x")}`,
  "tr-td-flood": () => `<table>${fill("<tr><td>x")}`,
  "open-stray-alternate": () => fill("<b></i><i></b>"),
  "distinct-names": () => distinct((t) => `<${t}></${t}>`),
  "distinct-names-nested": () => distinct((t) => `<${t}>`),
  "quoted-attr": () => fill('<b><div a="></b>">'),
  "comment-bang-flood": () => fill("<div><!-- --!>"),
};
const input = shapes[shape]();
// depth-bounded: as render.ts calls it, with stopAbove = MAX_HTML_DEPTH (512).
const run =
  fn === "depth" ? () => mod.htmlNestingDepth(input) : fn === "depth-bounded" ? () => mod.htmlNestingDepth(input, 512) : () => mod.htmlToPlainText(input);
run();
let best = Infinity;
for (let i = 0; i < 3; i++) {
  const s = performance.now();
  run();
  best = Math.min(best, performance.now() - s);
}
process.stdout.write(String(best));
