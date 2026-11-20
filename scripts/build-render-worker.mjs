// Bundles the email render worker (plan Revision 4, R4.3) into one self-contained ESM file,
// .alex-build/render-worker.mjs, which src/lib/email/render.ts starts as a worker_threads Worker.
// Run by the prebuild and pretest npm scripts and by the Vitest globalSetup; `npm run dev`
// (scripts/dev.mjs) builds it in watch mode instead.
// .alex-build/ is gitignored; Vercel's file tracing includes it via next.config.ts.
import { build } from "esbuild";
import path from "node:path";
import { outfile, root, workerBuildOptions } from "./render-worker-options.mjs";

await build(workerBuildOptions);

console.log(`render worker bundled: ${path.relative(root, outfile)}`);
