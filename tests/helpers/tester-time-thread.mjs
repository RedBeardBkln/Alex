// Tester fresh-process timing, plan Revision 4 (AC 18j restated by R4: ingest-time bound per job).
// Renders a set of within-cap worst-case messages with renderEmailBody and the REAL bundled worker,
// as hydrate does at ingest. Usage: node --experimental-strip-types tester-time-thread.mjs <set>
// Prints JSON: [{ ms, kind, reason, len }] per message (after one warm-up job that spawns the worker).
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

register(pathToFileURL(path.resolve(import.meta.dirname, "ts-resolve-hook.mjs")).href);
const { RenderPool, renderEmailBody, MAX_RENDER_HTML_CHARS } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../src/lib/email/render.ts")).href);
const { MAX_CSS_CHARS } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../src/lib/email-css.ts")).href);

const C = MAX_CSS_CHARS;
const H = MAX_RENDER_HTML_CHARS - 200;
const fit = (unit, max) => unit.repeat(Math.max(1, Math.floor(max / unit.length)));
const nested = (max) => {
  const d = Math.floor(max / 11);
  return "<div>".repeat(d) + "x" + "</div>".repeat(d);
};

const sets = {
  // The heaviest within-cap shapes from rounds 7–8, resized to the 256 KiB HTML cap.
  heaviest8: [
    fit('<b style="color:red">x</b>', H),
    fit("<style>.a{color:red}</style>", H),
    "<table>" + fit("<tr><td>a</td><td>b</td><td>c</td></tr>", H - 20) + "</table>",
    `<style>a{font-family:${fit("x ", C / 2 - 30)}}</style>` + fit('<b style="margin:1px 2px 3px 4px;color:#abc">x</b>', H - C / 2),
    fit("<td style=\"padding:0 1px;color:#fff;font-family:'A',b\">x</td>", H),
    `<style>a{font-family:${fit("x,", C - 30)}y}</style>`,
    `<style>a{font-family:${fit("x ", C - 30)}}</style>`,
    `<style>a{margin:${fit("1 ", C - 30)}}</style>`,
  ],
  // W1 shapes (round 8): deep nesting within the cap, and just over it.
  w1: [
    nested(H),
    "<div>".repeat(Math.ceil((MAX_RENDER_HTML_CHARS + 10) / 5)),
    "<div>".repeat(Math.ceil((1024 * 1024 + 10) / 5)),
    fit("<b>", H),
    fit("<x>", H),
    fit("<div><span>", H),
  ],
  // Deep nesting hidden from the depth scan (undercounts found in round 9): must still be bounded.
  hidden: [
    "<noscript>" + nested(H - 30) + "</noscript>",
    "<template>" + nested(H - 30) + "</template>",
    '<p title="><!--">' + nested(H - 40) + "<!-- -->",
  ],
};

const msgs = sets[process.argv[2]];
if (!msgs) throw new Error("unknown set");
const pool = new RenderPool();
await renderEmailBody({ html: "<p>warm-up</p>", text: null }, { pool });
const out = [];
for (const html of msgs) {
  const before = pool.dispatched;
  const t0 = performance.now();
  const r = await renderEmailBody({ html, text: null }, { pool });
  out.push({ ms: performance.now() - t0, kind: r.renderKind, reason: r.renderReason, len: html.length, dispatched: pool.dispatched - before });
}
await pool.close();
process.stdout.write(JSON.stringify(out));
