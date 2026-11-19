// Bundles the email render worker (plan Revision 4, R4.3) into one self-contained ESM file,
// .alex-build/render-worker.mjs, which src/lib/email/render.ts starts as a worker_threads Worker.
// Run by the prebuild, predev and pretest npm scripts and by the Vitest globalSetup.
// .alex-build/ is gitignored; Vercel's file tracing includes it via next.config.ts.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, ".alex-build", "render-worker.mjs");

await build({
  entryPoints: [path.join(root, "src/lib/email/render.worker.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20.19",
  // Bundled CommonJS dependencies (sanitize-html, postcss) call require() for Node builtins;
  // an ESM bundle has no require, so provide one (needed on Vercel, verified by the Round 9 probe).
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
  legalComments: "none",
});

console.log(`render worker bundled: ${path.relative(root, outfile)}`);
