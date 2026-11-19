import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { asc, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { MessageBody } from "@/app/(app)/inbox/[threadId]/message-body";
import { RENDER_LIMIT_MS, RenderPool, renderEmailBody } from "@/lib/email/render";
import type { RenderFields } from "@/lib/email/types";
import { SANITIZER_VERSION } from "@/lib/email/version";
import { isStructurallySafe } from "@/lib/email-html";
import { getThreadView } from "@/lib/gmail/store";
import { runCronSync, syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { alternative, FakeGmail, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester round 9 (Revision 4) with Postgres: real-worker ingest end to end, page output from stored
// columns, pre-R4 rows and re-render, and the budget guard under shared-pool contention.

const DAY = 86400_000;
const misbehaving = path.resolve(import.meta.dirname, "helpers/tester-workers.mjs");

describe.skipIf(!testDbUrl)("tester r9: render at ingest end to end (Postgres + fake Gmail)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  const pools: RenderPool[] = [];
  let realPool: RenderPool;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    realPool = new RenderPool();
    pools.push(realPool);
  });
  afterAll(async () => {
    for (const p of pools) await p.close();
    delete process.env.TESTER_WORKER_MODE;
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.auditLog);
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com" });
    gmail = new FakeGmail();
    clock = Date.now();
  });

  const realRender = (pool: RenderPool): SyncDeps["render"] => (body, opts) => renderEmailBody(body, { pool, version: opts.version });
  const deps = (over: Partial<SyncDeps> = {}): SyncDeps => ({
    db: database,
    gmailFor: () => gmail,
    now: () => new Date(clock),
    sleep: async () => {},
    unitsPerMinute: 1e9,
    render: realRender(realPool),
    ...over,
  });
  const reload = async () => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
  const rowOf = async (id: string) => (await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, id)))[0]!;
  const msg = (id: string, html: string | null, text = `text of ${id}`, ageMs = DAY): FakeMessage => ({
    id,
    threadId: `t-${id}`,
    labelIds: ["INBOX"],
    internalDate: clock - ageMs,
    payload: html === null ? { mimeType: "text/plain", filename: "", body: { data: Buffer.from(text).toString("base64url"), size: text.length } } : alternative(text, html),
  });
  const pageFor = async (gmailId: string, remoteOn = false) => {
    const row = await rowOf(gmailId);
    const view = (await getThreadView(database, userId, row.threadId))!;
    const m = view.messages.find((x) => x.gmailMessageId === gmailId)!;
    expect(Object.keys(m)).not.toContain("bodyHtml");
    return renderToStaticMarkup(createElement(MessageBody, { message: m, threadId: view.thread.id, remoteOn }));
  };
  const srcdoc = (markup: string) => {
    const m = markup.match(/srcDoc="([^"]*)"/i) ?? markup.match(/srcdoc="([^"]*)"/i);
    return m ? m[1]!.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
  };

  it("hostile mail through the real worker and cron: stored html is structurally safe; the page shows only stored output", { timeout: 60_000 }, async () => {
    gmail.seed(msg("s1", '<style>a{color:red}</sty\\le><meta http-equiv="refresh" content="0;url=https://e.example.com/x"></style><p>after</p><img src="https://ok.example.org/i.png">'));
    gmail.seed(msg("u1", '<div style="background:url(&quot;data:,x&#10;);background:url(https://e.example.com/u1);y:&quot;)">u</div>'));
    gmail.seed(msg("deep", "<div>".repeat(20_000) + "x" + "</div>".repeat(20_000), "")); // too_deep, no text part
    gmail.seed(msg("plain", null, "<script>alert(1)</script> plain body"));
    for (let i = 0; i < 4; i++) await syncAccount(deps(), await reload(), "cron");

    const s1 = await rowOf("s1");
    expect([s1.renderKind, s1.renderReason, s1.sanitizerVersion]).toEqual(["html", null, SANITIZER_VERSION]);
    expect(isStructurallySafe(s1.renderedHtml!)).toBe(true);
    expect(s1.renderedHtml).not.toMatch(/<meta|e\.example\.com|ok\.example\.org/);
    expect(s1.renderedHtmlRemote).toContain("https://ok.example.org/i.png");
    const p1 = await pageFor("s1");
    expect(srcdoc(p1)).toContain("<p>after</p>");
    expect(srcdoc(p1)).not.toContain("ok.example.org");
    expect(srcdoc(await pageFor("s1", true))).toContain("ok.example.org");

    const u1 = await rowOf("u1");
    expect(u1.renderedHtml ?? "").not.toContain("e.example.com");

    const deep = await rowOf("deep");
    expect([deep.renderKind, deep.renderReason]).toEqual(["text", "too_deep"]);
    expect(deep.renderedText).toBe("x");
    const pd = await pageFor("deep");
    expect(pd).toContain("<pre");
    expect(pd).not.toContain("<iframe");

    const plain = await rowOf("plain");
    expect(plain.renderKind).toBe("none");
    const pp = await pageFor("plain");
    expect(pp).toContain("&lt;script&gt;alert(1)&lt;/script&gt; plain body");
    expect(pp).not.toContain("<script>");
  });

  it("rows from before Revision 4 (render columns NULL) show body_text until the cron re-renders them; re-render makes no Gmail calls", { timeout: 60_000 }, async () => {
    gmail.seed(msg("old1", "<p>Old <b>html</b></p>", "old text", 2 * DAY));
    gmail.seed(msg("old2", "<p>Older</p>", "", 3 * DAY));
    for (let i = 0; i < 3; i++) await syncAccount(deps(), await reload(), "cron");
    // Simulate rows stored before Revision 4.
    await database.execute(sql`update mail_messages set render_kind = null, render_reason = null, rendered_html = null, rendered_html_remote = null, rendered_text = null, sanitizer_version = null, rendered_at = null`);
    const before1 = await pageFor("old1");
    expect(before1).toContain("old text");
    expect(before1).not.toContain("<iframe");
    expect(await pageFor("old2")).toContain("being prepared for display");

    gmail.calls = [];
    const r = await syncAccount(deps(), await reload(), "cron");
    expect(r.outcome).toBe("ok");
    expect(gmail.calls.filter((c) => c.op === "getMessageFull" || c.op === "getMessageMinimal" || c.op === "getBodyPartData")).toEqual([]);
    expect((await rowOf("old1")).renderKind).toBe("html");
    expect(srcdoc(await pageFor("old1"))).toContain("<b>html</b>");
    expect(srcdoc(await pageFor("old2"))).toContain("Older");
    const progress = (await database.select().from(schema.auditLog)).filter((a) => a.action === "mail.rerender_progress");
    expect(progress.at(-1)?.detail).toEqual({ rendered: 2, remaining: 0 });
    // Audit details stay content-free.
    expect(JSON.stringify(progress)).not.toMatch(/Old|Older|html|text/);
  });

  it("budget guard under shared-pool contention: 4 accounts, every job hits the 2 s limit; measured overrun beyond the budget is bounded", { timeout: 120_000 }, async () => {
    process.env.TESTER_WORKER_MODE = "regex";
    const slowPool = new RenderPool({ workerPath: misbehaving });
    pools.push(slowPool);
    const gmails = new Map<string, FakeGmail>();
    const accounts = [account];
    for (let i = 0; i < 3; i++) accounts.push(await makeGoogleAccount(database, userId, { email: `a${i}@example.com` }));
    for (const a of accounts) {
      const g = new FakeGmail();
      for (let k = 0; k < 6; k++) g.seed({ ...msg(`${a.id.slice(0, 4)}-${k}`, "<p>x</p>"), threadId: `t-${a.id}-${k}` });
      gmails.set(a.id, g);
    }
    // Setup + listing first (no renders), then the measured run in real time.
    await runCronSync(deps({ gmailFor: (a) => gmails.get(a.id)!, budgetMs: 0, now: () => new Date() }));
    const budgetMs = RENDER_LIMIT_MS + 5_000 + 500; // each account can start exactly one row
    const t0 = Date.now();
    const results = await runCronSync(deps({ gmailFor: (a) => gmails.get(a.id)!, budgetMs, now: () => new Date(), render: realRender(slowPool) }));
    const elapsed = Date.now() - t0;
    const overrun = elapsed - budgetMs;
    console.log(`[tester] shared-pool contention: budget ${budgetMs} ms, elapsed ${elapsed} ms, overrun ${overrun} ms, renders ${JSON.stringify(results.map((r) => r.renders))}`);
    // Not a plan violation as long as the run stays well inside maxDuration (300 s) – 240 s budget = 60 s slack.
    expect(overrun).toBeLessThan(accounts.length * (RENDER_LIMIT_MS + 1_000));
    delete process.env.TESTER_WORKER_MODE;
  });
});
