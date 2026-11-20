// Tester round 9: misbehaving render workers, selected by the TESTER_WORKER_MODE env var (inherited from the parent when the Worker is created).
// Each speaks the render.worker protocol ({type:"ready"}, then {id, html} jobs).
import { parentPort } from "node:worker_threads";

const mode = process.env.TESTER_WORKER_MODE ?? "ok";
const port = parentPort;

port.postMessage({ type: "ready" });
if (mode === "exit-idle") setTimeout(() => process.exit(3), 100); // dies while idle, after its first job

port.on("message", (job) => {
  switch (mode) {
    case "oom": {
      // Allocate until the worker's maxOldGenerationSizeMb (256) is hit.
      const hold = [];
      for (;;) hold.push(new Array(1e6).fill(Math.random()));
    }
    case "regex": {
      // The round-4 T1 regex on an unterminated url( with many spaces: minutes of backtracking.
      /url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi.test("url(" + " ".repeat(20000) + "x");
      port.postMessage({ id: job.id, ok: true, html: "<p>never</p>", remote: null });
      return;
    }
    case "exit-on-job":
      process.exit(3);
    case "wrong-id":
      port.postMessage({ id: job.id + 1000, ok: true, html: "<p>stale</p>", remote: null });
      return;
    case "bad-shape":
      port.postMessage({ id: job.id, ok: true, html: { not: "a string" }, remote: 5 });
      return;
    case "bad-reason":
      port.postMessage({ id: job.id, ok: false, reason: "<script>alert(1)</script>" });
      return;
    case "postcheck":
      port.postMessage({ id: job.id, ok: false, reason: "postcheck" });
      return;
    case "throw-async":
      setTimeout(() => {
        throw new Error("boom");
      }, 0);
      return;
    case "reply": {
      // Round 10: a well-formed "ok" reply with whatever html/remote the test chose (TESTER_WORKER_REPLY JSON).
      const r = JSON.parse(process.env.TESTER_WORKER_REPLY ?? "{}");
      port.postMessage({ id: job.id, ok: true, html: r.html, remote: r.remote ?? null });
      return;
    }
    default:
      port.postMessage({ id: job.id, ok: true, html: `<p>${job.html.length}</p>`, remote: null });
  }
});
