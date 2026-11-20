// Fresh-process timing for AC 18j's whole-thread bound (owner Round 7): 8 worst-case messages within
// the caps, rendered with emailDocument in ONE mode. Usage: node time-thread.mjs <off|on>
// Prints the elapsed milliseconds for the 8 renders (after one tiny warm-up render).
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

register(pathToFileURL(path.resolve(import.meta.dirname, "ts-resolve-hook.mjs")).href);
const { emailDocument, MAX_HTML_CHARS } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../src/lib/email-html.ts")).href);
const { MAX_CSS_CHARS } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../src/lib/email-css.ts")).href);

const C = MAX_CSS_CHARS;
const fit = (unit, max) => unit.repeat(Math.floor(max / unit.length));

// The heaviest within-cap shape: each message spends its whole CSS budget on one long value list
// (the V1 shapes), plus one message of maximal HTML made of many small style attributes.
const messages = [
  `<style>a{font-family:${fit("x ", C - 30)}}</style>`,
  `<style>a{font-family:${fit("x,", C - 30)}y}</style>`,
  `<style>a{color:${fit("rgb(1,2,3) ", C - 30)}}</style>`,
  `<p style="font-family:${fit("x ", C - 30)}">a</p>`,
  `<p style="margin:${fit("1.25px ", C - 30)}">a</p>`,
  `<style>a{font:${fit("1px/2px ", C - 30)}}</style>`,
  `<style>a{color:${fit("hsl(10deg,20%,30%) ", C - 30)}}</style>`,
  fit("<td style=\"padding:0 1px;color:#fff;font-family:'A',b\">x</td>", MAX_HTML_CHARS - 100),
];
for (const m of messages) if (m.length > MAX_HTML_CHARS) throw new Error("message over MAX_HTML_CHARS");

const opts = { allowRemoteImages: process.argv[2] === "on" };
emailDocument("<p>warm-up</p>", opts);
const t0 = performance.now();
for (const m of messages) emailDocument(m, opts);
process.stdout.write(String(performance.now() - t0));
