// `npm run dev` (phase-2a-followups N2): builds the email render worker bundle in esbuild watch
// mode, so editing a file it includes rebuilds .alex-build/render-worker.mjs, then starts
// `next dev`. Arguments are passed through to `next dev` (npm run dev -- --port 3001).
// The pool starts a fresh worker for each new worker thread, so a rebuilt bundle is used once the
// current worker is replaced (for example after a timeout or a dev-server restart).
import { spawn } from "node:child_process";
import path from "node:path";
import { context } from "esbuild";
import { outfile, root, workerBuildOptions } from "./render-worker-options.mjs";

let builds = 0;
let firstBuildDone;
const firstBuild = new Promise((resolve) => (firstBuildDone = resolve));

const ctx = await context({
  ...workerBuildOptions,
  plugins: [
    {
      name: "alex-log-rebuilds",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) {
            console.error(`render worker build failed (${result.errors.length} error(s)); HTML mail is stored as plain text until it builds`);
          } else {
            console.log(`render worker ${builds === 0 ? "bundled" : "rebundled"}: ${path.relative(root, outfile)}`);
          }
          builds += 1;
          firstBuildDone();
        });
      },
    },
  ],
});
await ctx.watch();
await firstBuild;

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev", ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  await ctx.dispose();
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
    void stop(0);
  });
}
child.on("exit", (code, signal) => void stop(code ?? (signal ? 1 : 0)));
child.on("error", (err) => {
  console.error("could not start next dev:", err.message);
  void stop(1);
});
