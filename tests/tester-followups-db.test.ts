import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { asc, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { MessageBody } from "@/app/(app)/inbox/[threadId]/message-body";
import { accountConnectedDetail, accountDisconnectedDetail, loginDeniedDetail, loginDetail } from "@/lib/audit-details";
import { audit } from "@/lib/audit";
import { RenderPool, renderEmailBody } from "@/lib/email/render";
import { MIN_DISPLAYABLE_SANITIZER_VERSION, SANITIZER_DEPENDENCY_HISTORY, SANITIZER_VERSION } from "@/lib/email/version";
import { getThreadView } from "@/lib/gmail/store";
import { syncAccount, syncAfterConnect, syncAfterPush, type SyncDeps } from "@/lib/gmail/sync";
import { alternative, FakeGmail, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester, task phase-2a-followups: v1 -> v2 re-render through the real worker, and the new audit details.

const DAY = 86400_000;

describe("version constants (unit)", () => {
  it("SANITIZER_VERSION 2, MIN_DISPLAYABLE stays 1, v1 history entry unchanged, v2 appended", () => {
    expect(SANITIZER_VERSION).toBe(2);
    expect(MIN_DISPLAYABLE_SANITIZER_VERSION).toBe(1);
    expect(SANITIZER_DEPENDENCY_HISTORY.map((h) => h.version)).toEqual([1, 2]);
    expect(SANITIZER_DEPENDENCY_HISTORY[0]!.packages).toEqual({
      "sanitize-html": "2.18.2",
      htmlparser2: "12.0.0",
      postcss: "8.5.33",
      "@csstools/css-tokenizer": "4.0.3",
      "@csstools/css-parser-algorithms": "4.0.3",
    });
  });
});

describe("audit detail helpers on hostile input (unit)", () => {
  it("no '@' ever, whatever the address looks like", () => {
    for (const e of ["owner@example.com", "a@b@C.Example", '"a@b"@x.example', " Owner@Example.COM ", "x@", "noat", "@only", "<script>@x.example", "a@x.example\n@y", "", "a@İ.example"]) {
      const d = loginDeniedDetail(e);
      expect(JSON.stringify(d), e).not.toContain("@");
      expect(Object.keys(d)).toEqual(["domain"]);
    }
    expect(loginDeniedDetail("Owner@Example.COM").domain).toBe("example.com");
    expect(loginDeniedDetail("x@").domain).toBeNull();
    expect(loginDetail()).toBeUndefined();
    expect(accountConnectedDetail({ label: "personal", email: "a@example.com" } as never)).toEqual({ label: "personal" });
    expect(accountDisconnectedDetail({ id: "u-1", provider: "google", label: "business", email: "a@example.com" } as never)).toEqual({ accountId: "u-1", provider: "google", label: "business" });
  });
});

describe.skipIf(!testDbUrl)("tester followups (Postgres + fake Gmail + real worker)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  let pool: RenderPool;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    pool = new RenderPool();
  });
  afterAll(async () => {
    await pool.close();
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

  const deps = (over: Partial<SyncDeps> = {}): SyncDeps => ({
    db: database,
    gmailFor: () => gmail,
    now: () => new Date(clock),
    sleep: async () => {},
    unitsPerMinute: 1e9,
    render: (body, opts) => renderEmailBody(body, { pool, version: opts.version }),
    ...over,
  });
  const reload = async () => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
  const rows = async () => database.select().from(schema.mailMessages).orderBy(asc(schema.mailMessages.internalDate));
  const msg = (id: string, html: string, ageMs: number): FakeMessage => ({ id, threadId: `t-${id}`, labelIds: ["INBOX"], internalDate: clock - ageMs, payload: alternative("", html) });
  const page = async (gmailId: string) => {
    const r = (await rows()).find((x) => x.gmailMessageId === gmailId)!;
    const view = (await getThreadView(database, userId, r.threadId))!;
    const m = view.messages.find((x) => x.gmailMessageId === gmailId)!;
    return renderToStaticMarkup(createElement(MessageBody, { message: m, threadId: view.thread.id, remoteOn: false }));
  };

  it("v1 rows (including a former F1 too_deep row) are shown as stored until the cron re-renders them to v2; views, push and connect never re-render", { timeout: 120_000 }, async () => {
    const legacy = "<html><body>" + "<p>Legacy paragraph.".repeat(600) + "</body></html>";
    gmail.seed(msg("f1", legacy, 2 * DAY));
    for (let i = 0; i < 30; i++) gmail.seed(msg(`m${i}`, `<p>Message <b>${i}</b></p>`, (i + 3) * 3600_000));
    for (let i = 0; i < 4; i++) await syncAccount(deps(), await reload(), "cron");
    expect((await rows()).length).toBe(31);
    // Put every row back into a v1 state; the F1 row as round-9 stored it (text/too_deep).
    await database.execute(sql`update mail_messages set sanitizer_version = 1`);
    await database.execute(sql`update mail_messages set render_kind = 'text', render_reason = 'too_deep', rendered_html = null, rendered_html_remote = null, rendered_text = 'Legacy paragraph.', sanitizer_version = 1 where gmail_message_id = 'f1'`);
    const snapshot = JSON.stringify(await rows());

    // Views: stored v1 output is displayed (MIN = 1), nothing is re-rendered.
    expect(await page("m0")).toContain("<iframe");
    expect(await page("f1")).toContain("Legacy paragraph.");
    expect(await page("f1")).not.toContain("<iframe");
    // Push and connect runs skip the rerender stage.
    await syncAfterPush(deps(), account.id);
    await syncAfterConnect(deps(), account.id);
    expect(JSON.stringify(await rows())).toBe(snapshot);

    // The cron run re-renders everything to v2.
    await syncAccount(deps(), await reload(), "cron");
    const after = await rows();
    expect(after.every((r) => r.sanitizerVersion === 2)).toBe(true);
    const f1 = after.find((r) => r.gmailMessageId === "f1")!;
    expect([f1.renderKind, f1.renderReason]).toEqual(["html", null]);
    expect(await page("f1")).toContain("<iframe");
    const progress = (await database.select().from(schema.auditLog)).filter((a) => a.action === "mail.rerender_progress");
    expect(progress.reduce((n, a) => n + ((a.detail as { rendered: number }).rendered ?? 0), 0)).toBe(31);

    // Idempotent: a second cron run re-renders nothing and writes no progress audit.
    const before = progress.length;
    await syncAccount(deps(), await reload(), "cron");
    expect((await database.select().from(schema.auditLog)).filter((a) => a.action === "mail.rerender_progress").length).toBe(before);
  });

  it("new audit rows for the four actions contain no '@'; a pre-existing row with an email is left untouched by running the app code", async () => {
    await database.insert(schema.auditLog).values({ userId, action: "account.connected", detail: { email: "old@example.com", label: "personal" } });
    await audit({ userId, accountId: account.id, action: "account.connected", detail: accountConnectedDetail(account) }, database);
    await audit({ userId, action: "account.disconnected", detail: accountDisconnectedDetail(account) }, database);
    await audit({ userId, action: "login", detail: loginDetail() }, database);
    await audit({ userId: null, action: "login.denied", detail: loginDeniedDetail("Stranger@Example.ORG") }, database);
    // Run a full cron pass too (no code path may rewrite old audit rows).
    await syncAccount(deps(), await reload(), "cron");
    const all = await database.select().from(schema.auditLog).orderBy(asc(schema.auditLog.createdAt));
    const old = all.find((a) => JSON.stringify(a.detail).includes("old@example.com"));
    expect(old?.detail).toEqual({ email: "old@example.com", label: "personal" });
    const fresh = all.filter((a) => a !== old && ["account.connected", "account.disconnected", "login", "login.denied"].includes(a.action));
    expect(fresh).toHaveLength(4);
    for (const a of fresh) expect(JSON.stringify(a.detail ?? null), a.action).not.toContain("@");
    expect(fresh.find((a) => a.action === "login")!.detail).toBeNull();
    expect(fresh.find((a) => a.action === "login.denied")!.detail).toEqual({ domain: "example.org" });
  });
});
