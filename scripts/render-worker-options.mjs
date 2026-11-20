// esbuild options for the email render worker bundle (plan Revision 4, R4.3), shared by
// scripts/build-render-worker.mjs (one-off build) and scripts/dev.mjs (watch mode).
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const outfile = path.join(root, ".alex-build", "render-worker.mjs");

/** @type {import("esbuild").BuildOptions} */
export const workerBuildOptions = {
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
};
