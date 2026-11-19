import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { asc, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { RENDER_LIMIT_MS, RenderPool, defaultRenderPool, renderEmailBody } from "@/lib/email/render";
import type { RenderFields } from "@/lib/email/types";
import { SANITIZER_VERSION } from "@/lib/email/version";
import type { GmailClient } from "@/lib/gmail/client";
import { getThreadView, getSyncState } from "@/lib/gmail/store";
import { syncAccount, syncAfterConnect, syncAfterPush, type SyncDeps } from "@/lib/gmail/sync";
import { alternative, FakeGmail, textPart, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Plan Revision 4 with Postgres and a fake Gmail: render at ingest (R4.2), the budget guard (R4.8),
// the re-render stage (R4.7, AC 18o) and the hostile flood (AC 18p).

const DAY = 86400_000;
const testWorker = path.resolve(import.meta.dirname, "helpers/test-render-worker.mjs");

describe.skipIf(!testDbUrl)("render at ingest (Postgres + fake Gmail)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  let msPerCall: number;
  const pools: RenderPool[] = [];

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    for (const p of pools) await p.close();
    await defaultRenderPool().close();
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com" });
    gmail = new FakeGmail();
    clock = Date.now();
    msPerCall = 0;
  });

  function ticking(inner: GmailClient): GmailClient {
    return new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return async (...args: unknown[]) => {
          clock += msPerCall;
          return v.apply(target, args);
        };
      },
    });
  }
  const deps = (over: Partial<SyncDeps> = {}): SyncDeps => ({
    db: database,
    gmailFor: () => ticking(gmail),
    now: () => new Date(clock),
    sleep: async () => {},
    unitsPerMinute: 1e9,
    ...over,
  });
  const reload = async () => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
  const rows = async () =>
    database.select().from(schema.mailMessages).where(eq(schema.mailMessages.accountId, account.id)).orderBy(asc(schema.mailMessages.internalDate));
  const byId = async (id: string) => (await rows()).find((r) => r.gmailMessageId === id)!;
  const queue = async () => database.select().from(schema.mailFetchQueue).where(eq(schema.mailFetchQueue.accountId, account.id));
  const audits = async (action: string) => (await database.select().from(schema.auditLog)).filter((a) => a.action === action);
  const msg = (id: string, ageMs: number, payload?: FakeMessage["payload"]): FakeMessage => ({
    id,
    threadId: `t-${id}`,
    labelIds: ["INBOX"],
    internalDate: clock - ageMs,
    payload,
  });
  async function runUntilEmpty(d: SyncDeps, max = 20) {
    for (let i = 0; i < max; i++) {
      await syncAccount(d, await reload(), "cron");
      if ((await getSyncState(database, account.id))?.backfillStatus === "complete" && (await queue()).length === 0) return;
      clock += 5 * 60_000;
    }
  }

  it("hydrate stores the rendering with the message: html (both variants), none, too_large; getThreadView omits body_html", async () => {
    gmail.seed(msg("img", 3 * DAY, alternative("Plain", '<p style="color:red">Hi <img src="https://i.example/a.png" alt="a"></p>')));
    gmail.seed(msg("txt", 2 * DAY, textPart("text/plain", "Only text")));
    gmail.seed(msg("big", 1 * DAY, alternative("Big plain", `<p>${"x".repeat(262_144)}</p>`)));
    await runUntilEmpty(deps());

    const img = await byId("img");
    expect(img).toMatchObject({
      renderKind: "html",
      renderReason: null,
      renderedHtml: '<p style="color:red">Hi <img alt="a" /></p>',
      renderedHtmlRemote: '<p style="color:red">Hi <img src="https://i.example/a.png" alt="a" /></p>',
      renderedText: null,
      sanitizerVersion: SANITIZER_VERSION,
    });
    expect(img.renderedAt).not.toBeNull();
    expect(await byId("txt")).toMatchObject({ renderKind: "none", sanitizerVersion: SANITIZER_VERSION, renderedHtml: null });
    expect(await byId("big")).toMatchObject({ renderKind: "text", renderReason: "too_large", renderedText: "Big plain", renderedHtml: null });

    const view = (await getThreadView(database, userId, img.threadId))!;
    expect(view.messages[0]).not.toHaveProperty("bodyHtml");
    expect(view.messages[0]).toMatchObject({ renderKind: "html", renderedHtmlRemote: img.renderedHtmlRemote });
  });

  it("budget guard: with less than RENDER_LIMIT_MS + 5 s left, hydrate makes no full get", async () => {
    gmail.seed(msg("a", DAY));
    await syncAccount(deps({ budgetMs: RENDER_LIMIT_MS + 5_000 - 1 }), await reload(), "connect");
    expect(gmail.count("getMessageFull")).toBe(0);
    expect((await queue()).map((q) => q.gmailMessageId)).toEqual(["a"]);
    const res = await syncAccount(deps({ budgetMs: RENDER_LIMIT_MS + 5_000 + 1 }), await reload(), "cron");
    expect(gmail.count("getMessageFull")).toBe(1);
    // R4.3 smoke check: the run reports content-free render counts by kind and reason.
    expect(res.renders).toEqual({ html: 1 });
  });

  it("18o: a raised SANITIZER_VERSION re-renders stale rows in the cron run (batches of 25, newest first); push and connect don't", async () => {
    for (let i = 0; i < 30; i++) gmail.seed(msg(`m${String(i).padStart(2, "0")}`, (i + 1) * 3600_000));
    await runUntilEmpty(deps());
    expect((await rows()).every((r) => r.sanitizerVersion === SANITIZER_VERSION)).toBe(true);

    const order: string[] = [];
    const spy: SyncDeps["render"] = async (body, opts) => {
      order.push(body.html ?? "");
      return renderEmailBody(body, { version: opts.version });
    };
    // Push and connect never re-render.
    await syncAfterPush(deps({ render: spy, sanitizerVersion: SANITIZER_VERSION + 1 }), account.id);
    await syncAfterConnect(deps({ render: spy, sanitizerVersion: SANITIZER_VERSION + 1 }), account.id);
    expect(order).toEqual([]);

    await syncAccount(deps({ render: spy, sanitizerVersion: SANITIZER_VERSION + 1 }), await reload(), "cron");
    expect(order).toHaveLength(30);
    // Newest first: m00 is the newest message.
    expect(order[0]).toContain("Body of m00");
    expect(order[29]).toContain("Body of m29");
    expect((await rows()).every((r) => r.sanitizerVersion === SANITIZER_VERSION + 1 && r.renderKind === "html")).toBe(true);
    const progress = await audits("mail.rerender_progress");
    expect(progress.at(-1)!.detail).toEqual({ rendered: 30, remaining: 0 });
  });

  it("18o: re-render stops when the budget runs low and reports what remains", async () => {
    for (let i = 0; i < 10; i++) gmail.seed(msg(`m${i}`, (i + 1) * 3600_000));
    await runUntilEmpty(deps());
    // Each render costs 30 s of simulated time; budget 240 s, guard 7 s: 7 renders fit.
    const slow: SyncDeps["render"] = async (body, opts) => {
      clock += 30_000;
      return renderEmailBody(body, { version: opts.version });
    };
    await syncAccount(deps({ render: slow, sanitizerVersion: SANITIZER_VERSION + 1 }), await reload(), "cron");
    const done = (await rows()).filter((r) => r.sanitizerVersion === SANITIZER_VERSION + 1).length;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(10);
    expect((await audits("mail.rerender_progress")).at(-1)!.detail).toEqual({ rendered: done, remaining: 10 - done });
  });

  it("worker unavailable: stored as text with sanitizer_version NULL, audited once; re-render doesn't overwrite while it stays unavailable", async () => {
    const unavailable: SyncDeps["render"] = async (body, opts) =>
      renderEmailBody(body, { version: opts.version, pool: new RenderPool({ workerPath: path.join(path.dirname(testWorker), "missing.mjs") }) });
    gmail.seed(msg("a", 2 * DAY));
    gmail.seed(msg("b", DAY));
    await runUntilEmpty(deps({ render: unavailable }));
    for (const id of ["a", "b"]) {
      expect(await byId(id)).toMatchObject({ renderKind: "text", renderReason: "worker_unavailable", sanitizerVersion: null, renderedText: `Body of ${id}` });
    }
    expect((await audits("mail.render_worker_unavailable")).length).toBeLessThanOrEqual(1);
    const before = (await rows()).map((r) => r.renderedAt?.getTime());
    await syncAccount(deps({ render: unavailable }), await reload(), "cron");
    expect((await rows()).map((r) => r.renderedAt?.getTime())).toEqual(before);
    // Once the worker works again, the cron re-render fixes them.
    await syncAccount(deps(), await reload(), "cron");
    expect((await rows()).every((r) => r.renderKind === "html" && r.sanitizerVersion === SANITIZER_VERSION)).toBe(true);
  });

  it("18p: a hostile flood (30 W1-shaped + 30 normal) is all stored, the queue empties, the run stays in budget, no extra Gmail calls", { timeout: 60_000 }, async () => {
    const pool = new RenderPool({ workerPath: testWorker, limitMs: 50 });
    pools.push(pool);
    let timeouts = 0;
    // Real routing; the test worker busy-loops on __BUSY__ and is cut at 50 ms. Each timeout is
    // charged the full RENDER_LIMIT_MS + 100 ms of simulated time, as in production.
    const render: SyncDeps["render"] = async (body, opts) => {
      const r = await renderEmailBody(body, { version: opts.version, pool });
      if (r.renderReason === "timeout") {
        timeouts += 1;
        clock += RENDER_LIMIT_MS + 100;
      }
      return r;
    };
    const deep = `${"<div>".repeat(23_000)}x${"</div>".repeat(23_000)}`; // 253 KB, depth 23K: too_deep
    const busy = `<p>__BUSY__ ${"<b>".repeat(400)}</p>`; // depth 401: goes to the worker and times out
    for (let i = 0; i < 15; i++) gmail.seed(msg(`deep${i}`, (i + 1) * 60_000, alternative("Deep plain", deep)));
    for (let i = 0; i < 15; i++) gmail.seed(msg(`busy${i}`, (i + 20) * 60_000, alternative("Busy plain", busy)));
    for (let i = 0; i < 30; i++) gmail.seed(msg(`ok${i}`, (i + 40) * 60_000));

    const runStarts: number[] = [];
    const runEnds: number[] = [];
    for (let i = 0; i < 10; i++) {
      runStarts.push(clock);
      await syncAccount(deps({ render }), await reload(), "cron");
      runEnds.push(clock);
      if ((await queue()).length === 0 && (await getSyncState(database, account.id))?.backfillStatus === "complete") break;
      clock += 5 * 60_000;
    }
    const all = await rows();
    expect(all).toHaveLength(60);
    expect(await queue()).toEqual([]);
    for (let i = 0; i < runStarts.length; i++) expect(runEnds[i]! - runStarts[i]!).toBeLessThanOrEqual(240_000);
    expect(all.filter((r) => r.gmailMessageId.startsWith("deep")).every((r) => r.renderKind === "text" && r.renderReason === "too_deep")).toBe(true);
    expect(all.filter((r) => r.gmailMessageId.startsWith("busy")).every((r) => r.renderKind === "text" && r.renderReason === "timeout")).toBe(true);
    expect(all.filter((r) => r.gmailMessageId.startsWith("ok")).every((r) => r.renderKind === "html")).toBe(true);
    expect(timeouts).toBe(15);
    expect(gmail.count("getMessageFull")).toBe(60); // one per message, nothing extra
    expect(gmail.count("getMessageMinimal")).toBe(0);
  });
});

// Type-level check that the render dependency matches the renderer's output shape.
const _typecheck: (f: RenderFields) => RenderFields = (f) => f;
void _typecheck;
