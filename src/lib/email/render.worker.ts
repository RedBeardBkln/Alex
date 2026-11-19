/**
 * Render worker entry (plan Revision 4, R4.3). Bundled by scripts/build-render-worker.mjs into
 * .alex-build/render-worker.mjs and run in a worker_threads Worker by src/lib/email/render.ts,
 * which terminates it if a job runs past RENDER_LIMIT_MS.
 *
 * Protocol: posts {type:"ready"} once loaded; for each job {id, html} posts
 * {id, ok:true, html, remote} (remote is null when identical to the default variant) or
 * {id, ok:false, reason}.
 */
import { parentPort } from "node:worker_threads";
import { sanitizeEmailHtmlResult } from "../email-html";

type Job = { id: number; html: string };

const port = parentPort;
if (!port) throw new Error("render.worker must run in a worker thread");

port.on("message", (job: Job) => {
  try {
    const plain = sanitizeEmailHtmlResult(job.html, { allowRemoteImages: false });
    if (!plain.ok) {
      port.postMessage({ id: job.id, ok: false, reason: plain.reason });
      return;
    }
    const remote = sanitizeEmailHtmlResult(job.html, { allowRemoteImages: true });
    if (!remote.ok) {
      port.postMessage({ id: job.id, ok: false, reason: remote.reason });
      return;
    }
    port.postMessage({ id: job.id, ok: true, html: plain.html, remote: remote.html === plain.html ? null : remote.html });
  } catch {
    port.postMessage({ id: job.id, ok: false, reason: "crash" });
  }
});

port.postMessage({ type: "ready" });
