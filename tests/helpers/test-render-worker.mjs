// A scriptable stand-in for .alex-build/render-worker.mjs, for render-pool tests (plan Revision 4 §16).
// Speaks the same protocol. Markers in the job's html choose the behaviour:
//   __BUSY__      busy-loops forever (the pool must terminate it at its limit)
//   __CRASH__     exits the worker thread
//   __THROW__     throws an uncaught error
//   __POSTCHECK__ reports a structural post-check failure
//   __LIE__{json} replies ok with exactly {html, remote} from the JSON
//   anything else succeeds with a fixed fragment (remote variant only if the html contains __REMOTE__)
import { parentPort } from "node:worker_threads";

parentPort.on("message", (job) => {
  const html = String(job.html);
  if (html.includes("__BUSY__")) {
    for (;;) {
      // spin
    }
  }
  if (html.includes("__CRASH__")) process.exit(3);
  if (html.includes("__THROW__")) throw new Error("test worker failure");
  if (html.includes("__POSTCHECK__")) {
    parentPort.postMessage({ id: job.id, ok: false, reason: "postcheck" });
    return;
  }
  // A well-formed "ok" reply whose content is unsafe (a worker bug or a stale bundle).
  if (html.includes("__UNSAFE__")) {
    parentPort.postMessage({ id: job.id, ok: true, html: "<p>hi</p><script>alert(1)</script>", remote: null });
    return;
  }
  // "__LIE__" + JSON {html, remote}: a well-formed "ok" reply with exactly that content.
  if (html.startsWith("__LIE__")) {
    const lie = JSON.parse(html.slice("__LIE__".length));
    parentPort.postMessage({ id: job.id, ok: true, html: lie.html, remote: lie.remote });
    return;
  }
  if (html.includes("__UNSAFE_REMOTE__")) {
    parentPort.postMessage({ id: job.id, ok: true, html: "<p>hi</p>", remote: "<p>hi</p><style>a{}</sty</style><img src=x onerror=alert(1)>" });
    return;
  }
  parentPort.postMessage({ id: job.id, ok: true, html: "<p>ok</p>", remote: html.includes("__REMOTE__") ? "<p>ok remote</p>" : null });
});

parentPort.postMessage({ type: "ready" });
