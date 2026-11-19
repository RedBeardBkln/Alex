import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { htmlNestingDepth, renderPlainText } from "./plain-text";
import { isRenderSafe } from "./postcheck";
import type { RenderFields, RenderReason } from "./types";
import { SANITIZER_VERSION } from "./version";

/**
 * Ingest-time rendering of email bodies (plan Revision 4, R4.2–R4.3). Runs in the sync path only,
 * never on a page view. HTML is sanitized in a worker thread with a hard wall-clock limit; every
 * step on the main thread is linear and Alex's own code (no htmlparser2 here).
 */

/** Wall-clock limit per render job (both variants), from dispatch to the worker (owner, Q-R4-2). */
export const RENDER_LIMIT_MS = 2_000;
/** Deeper HTML goes straight to plain text without reaching the worker (owner, Q-R4-2). */
export const MAX_HTML_DEPTH = 512;
/** Same value as MAX_HTML_CHARS in email-html.ts (256 Ki code units); checked here so oversized mail never reaches the worker. */
export const MAX_RENDER_HTML_CHARS = 262_144;
/** A worker that hasn't reported ready by then counts as unavailable. */
export const READY_TIMEOUT_MS = 5_000;
/** After the worker was found unavailable, don't try to start it again for this long. */
const UNAVAILABLE_RETRY_MS = 60_000;
const WORKER_HEAP_MB = 256;

/** Location of the bundled worker; Vercel includes it through outputFileTracingIncludes (next.config.ts). */
export function defaultWorkerPath(): string {
  return path.join(process.cwd(), ".alex-build", "render-worker.mjs");
}

export type WorkerOutcome =
  | { ok: true; html: string; remote: string | null }
  | { ok: false; reason: Exclude<RenderReason, "too_deep"> };

type QueuedJob = { html: string; resolve: (r: WorkerOutcome) => void };

/**
 * A pool of one worker, created lazily and reused across messages and accounts in the process.
 * Jobs run one at a time, in order. A job that passes `limitMs` gets the worker terminated (it is
 * respawned for the next job); a crash or a missing bundle is reported as a failure outcome, never
 * thrown.
 */
export class RenderPool {
  readonly workerPath: string;
  readonly limitMs: number;
  readonly readyTimeoutMs: number;
  /** Jobs sent to a worker (tests use it to prove a message never reached the worker). */
  dispatched = 0;
  private worker: Worker | null = null;
  private starting: Promise<Worker | null> | null = null;
  private unavailableUntil = 0;
  private queue: QueuedJob[] = [];
  private draining = false;
  private nextId = 1;

  constructor(opts: { workerPath?: string; limitMs?: number; readyTimeoutMs?: number } = {}) {
    this.workerPath = opts.workerPath ?? defaultWorkerPath();
    this.limitMs = opts.limitMs ?? RENDER_LIMIT_MS;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  }

  run(html: string): Promise<WorkerOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ html, resolve });
      void this.drain();
    });
  }

  /** Stops the worker, if any (tests and shutdown). */
  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.starting = null;
    if (w) await w.terminate().catch(() => undefined);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        job.resolve(await this.runOne(job.html));
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOne(html: string): Promise<WorkerOutcome> {
    const worker = await this.getWorker();
    if (!worker) return { ok: false, reason: "worker_unavailable" };
    const id = this.nextId++;
    this.dispatched += 1;
    return new Promise<WorkerOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: WorkerOutcome, kill: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onFailure);
        worker.off("exit", onFailure);
        if (!kill) {
          resolve(outcome);
          return;
        }
        if (this.worker === worker) this.worker = null;
        // Wait for termination so the old worker isn't still burning CPU when the next job starts.
        worker.terminate().then(
          () => resolve(outcome),
          () => resolve(outcome),
        );
      };
      const onMessage = (m: unknown) => {
        const msg = m as { id?: number; ok?: boolean; html?: unknown; remote?: unknown; reason?: unknown };
        if (msg.id !== id) return;
        if (msg.ok === true && typeof msg.html === "string") {
          settle({ ok: true, html: msg.html, remote: typeof msg.remote === "string" ? msg.remote : null }, false);
        } else {
          const reason = msg.reason === "too_large" || msg.reason === "postcheck" ? msg.reason : "crash";
          settle({ ok: false, reason }, false);
        }
      };
      const onFailure = () => settle({ ok: false, reason: "crash" }, true);
      const timer = setTimeout(() => settle({ ok: false, reason: "timeout" }, true), this.limitMs);
      worker.on("message", onMessage);
      worker.on("error", onFailure);
      worker.on("exit", onFailure);
      worker.postMessage({ id, html });
    });
  }

  private getWorker(): Promise<Worker | null> {
    if (this.worker) return Promise.resolve(this.worker);
    if (Date.now() < this.unavailableUntil) return Promise.resolve(null);
    this.starting ??= this.spawn().then((w) => {
      this.starting = null;
      if (w) this.worker = w;
      else this.unavailableUntil = Date.now() + UNAVAILABLE_RETRY_MS;
      return w;
    });
    return this.starting;
  }

  private spawn(): Promise<Worker | null> {
    if (!existsSync(this.workerPath)) return Promise.resolve(null);
    let worker: Worker;
    try {
      worker = new Worker(this.workerPath, { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    } catch {
      return Promise.resolve(null);
    }
    worker.unref(); // an idle worker must not keep the process alive
    // A worker that dies while idle is dropped, so the next job starts a fresh one.
    worker.on("exit", () => {
      if (this.worker === worker) this.worker = null;
    });
    worker.on("error", () => undefined);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("exit", onExit);
        if (ok) resolve(worker);
        else {
          void worker.terminate().catch(() => undefined);
          resolve(null);
        }
      };
      const onMessage = (m: unknown) => {
        if ((m as { type?: unknown })?.type === "ready") done(true);
      };
      const onExit = () => done(false);
      const timer = setTimeout(() => done(false), this.readyTimeoutMs);
      worker.on("message", onMessage);
      worker.on("exit", onExit);
    });
  }
}

let processPool: RenderPool | undefined;

/** The process-wide pool (one worker), created on first use. */
export function defaultRenderPool(): RenderPool {
  processPool ??= new RenderPool();
  return processPool;
}

export type RenderOptions = {
  pool?: RenderPool;
  /** Version stamped on the output (tests override it to exercise re-rendering). */
  version?: number;
  now?: () => Date;
};

/**
 * Renders a message body for storage (R4.2): none (no HTML), html (both sanitized variants from
 * the worker) or text (Alex's linear plain-text rendering, with a content-free reason).
 */
export async function renderEmailBody(
  body: { html: string | null; text: string | null },
  opts: RenderOptions = {},
): Promise<RenderFields> {
  const version = opts.version ?? SANITIZER_VERSION;
  const renderedAt = (opts.now ?? (() => new Date()))();
  const html = body.html;
  if (html === null || html.trim() === "") {
    return { renderKind: "none", renderReason: null, renderedHtml: null, renderedHtmlRemote: null, renderedText: null, renderTruncated: false, sanitizerVersion: version, renderedAt };
  }
  const asText = (reason: RenderReason): RenderFields => {
    const plain = renderPlainText(html, body.text);
    return {
      renderKind: "text",
      renderReason: reason,
      renderedHtml: null,
      renderedHtmlRemote: null,
      renderedText: plain.text,
      renderTruncated: plain.truncated,
      // worker_unavailable is retried by the re-render stage, so it records no version.
      sanitizerVersion: reason === "worker_unavailable" ? null : version,
      renderedAt,
    };
  };
  if (html.length > MAX_RENDER_HTML_CHARS) return asText("too_large");
  if (htmlNestingDepth(html, MAX_HTML_DEPTH) > MAX_HTML_DEPTH) return asText("too_deep");
  const outcome = await (opts.pool ?? defaultRenderPool()).run(html);
  if (!outcome.ok) return asText(outcome.reason);
  // Defence in depth: re-run the post-check on the main thread before storing, whatever the worker
  // (or a stale bundle) replied: the structural check (tag allowlist, style containment) plus the
  // render check (attribute allowlist; URL schemes, with img src only data: or, in the remote
  // variant, https:; no remote images in the default variant; link target/rel exactly as the
  // sanitizer forces them; CSS charset with no url(, @ other than @media, \, expression or any
  // function but rgb/rgba/hsl/hsla). It doesn't re-run the sanitizer or
  // the CSS parser; it relies on how sanitize-html serializes, and the iframe sandbox and CSP still
  // apply. Linear, reject-only and import-free (postcheck.ts).
  if (!isRenderSafe(outcome.html, "default") || (outcome.remote !== null && !isRenderSafe(outcome.remote, "remote"))) {
    return asText("postcheck");
  }
  return {
    renderKind: "html",
    renderReason: null,
    renderedHtml: outcome.html,
    renderedHtmlRemote: outcome.remote,
    renderedText: null,
    renderTruncated: false,
    sanitizerVersion: version,
    renderedAt,
  };
}
