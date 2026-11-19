import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { proposeReply, getOwnItem } from "@/lib/approvals/service";
import { getSyncState } from "@/lib/gmail/store";
import { syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { FakeGmail, header, textPart } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester (phase 2b): renders the real approval page (server component) and reply form against
// Postgres, with only the session and next/navigation mocked, to check what the owner sees.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as { id: string; email: string } | null }));
vi.mock("@/db", async (orig) => ({ ...(await orig<object>()), db: () => state.db }));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (u: string) => {
    throw new Error(`REDIRECT ${u}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const DAY = 86_400_000;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe.skipIf(!testDbUrl)("tester: approval page and reply form show everything", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let threadId: string;
  let parentId: string;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    state.db = database;
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await database.delete(schema.users);
    const u = await makeUser(database);
    userId = u.id;
    state.user = { id: u.id, email: u.email };
    const account = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    const gmail = new FakeGmail();
    const clock = Date.now();
    gmail.seed({
      id: "p1",
      threadId: "gt1",
      labelIds: ["INBOX"],
      internalDate: clock - DAY,
      from: "Alice <alice@example.org>",
      subject: "Lunch",
      messageIdHeader: "<p1@mail.example.org>",
      payload: { ...textPart("text/plain", "Original <b>text</b>"), headers: [header("Reply-To", "billing@evil.example"), header("Cc", "c1@example.org")] },
    });
    const deps: SyncDeps = {
      db: database,
      gmailFor: () => gmail,
      now: () => new Date(clock),
      sleep: async () => {},
      unitsPerMinute: 1e9,
      render: async (body, opts) => ({ renderKind: "none", renderReason: null, renderedHtml: null, renderedHtmlRemote: null, renderedText: body.text, renderTruncated: false, sanitizerVersion: opts.version, renderedAt: new Date(clock) }),
    };
    for (let i = 0; i < 10; i++) {
      const acc = (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
      await syncAccount(deps, acc, "cron");
      if ((await getSyncState(database, account.id))?.backfillStatus === "complete") break;
    }
    threadId = (await database.select().from(schema.mailThreads))[0]!.id;
    parentId = (await database.select().from(schema.mailMessages))[0]!.id;
  });

  async function renderItem(itemId: string) {
    const { default: Page } = await import("@/app/(app)/queue/[itemId]/page");
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ itemId }), searchParams: Promise.resolve({}) }));
  }

  it("approval page: From account, all 50 recipients in full, No Bcc, subject, entire body and quote, thread target, warnings, hidden revision/hash", async () => {
    const to = Array.from({ length: 30 }, (_, i) => `to${i}-${"x".repeat(40)}@example.org`);
    const cc = Array.from({ length: 20 }, (_, i) => `cc${i}@sub.example.net`);
    const body = Array.from({ length: 500 }, (_, i) => `para ${i} <script>x</script>`).join("\n");
    const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: ["billing@evil.example", ...to].slice(0, 30).join("\n"), cc: cc.join("\n"), subject: "Changed subject", bodyText: body, includeQuote: true });
    expect(r.ok).toBe(true);
    const id = (r as { itemId: string }).itemId;
    await database.update(schema.approvalItems).set({ threadChangedAt: new Date() }).where(eq(schema.approvalItems.id, id));
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" });
    const html = await renderItem(id);
    const t = text(html);
    const it0 = (await getOwnItem(database, userId, id))!;
    expect(t).toContain("work@example.com");
    expect(t).toContain("(Business)");
    for (const a of ["billing@evil.example", ...to.slice(0, 29), ...cc]) expect(html, a).toContain(`>${a}</li>`);
    expect(t).toContain("No Bcc");
    expect(t).toContain("Changed subject");
    expect(t).toContain("para 499 <script>x</script>");
    expect(html).not.toContain("<script>x</script>"); // escaped, not markup
    expect(t).toContain("> Original <b>text</b>");
    expect(t).toMatch(/Reply in thread: Lunch \(1 message\)/);
    expect(t).toMatch(/Reply-To differs from the sender[\s\S]*billing@evil\.example[\s\S]*alice@example\.org/);
    expect(t).toContain("The subject was changed");
    expect(t).toContain("New messages arrived in this thread");
    expect(t).toContain("This account must be reconnected before sending");
    expect(html).toContain('<input type="checkbox" required="" name="ackThreadChange"/>');
    expect(html).toContain(`name="revision" value="${it0.revision}"`);
    expect(html).toContain(`name="contentHash" value="${it0.contentHash}"`);
  });

  it("another user's item is a 404, and a non-uuid id too", async () => {
    const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "x", includeQuote: false });
    const other = await makeUser(database, "intruder@example.com");
    state.user = { id: other.id, email: other.email };
    await expect(renderItem((r as { itemId: string }).itemId)).rejects.toThrow("NOT_FOUND");
    await expect(renderItem("../../etc")).rejects.toThrow("NOT_FOUND");
  });

  it("reply form: the sending account is text only (no field can carry an account or From)", async () => {
    const { ReplyForm } = await import("@/app/(app)/inbox/[threadId]/reply-form");
    const html = renderToStaticMarkup(
      ReplyForm({ threadId, parentMessageId: parentId, account: { email: "work@example.com", label: "business" }, mode: "reply", defaults: { to: ["a@example.org"], cc: [], subject: "Re: Lunch", unreadable: 2, hasQuote: true } }),
    );
    const names = [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(["bodyText", "cc", "includeQuote", "parentMessageId", "subject", "threadId", "to"]);
    expect(text(html)).toContain("work@example.com");
    expect(text(html)).toContain("2 addresses couldn't be read");
  });

  it("round 4 (B1): the approve form renders the exact stored thread_changed_at in ms, or empty when unflagged", async () => {
    const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "x", includeQuote: false });
    const id = (r as { itemId: string }).itemId;
    expect(await renderItem(id)).toContain('name="shownThreadChangedAt" value=""');
    const at = new Date(Date.now() - 1234);
    await database.update(schema.approvalItems).set({ threadChangedAt: at }).where(eq(schema.approvalItems.id, id));
    const html = await renderItem(id);
    expect(html).toContain(`name="shownThreadChangedAt" value="${at.getTime()}"`);
    expect(html).toContain('<input type="checkbox" required="" name="ackThreadChange"/>');
  });

  it("round 4 (N1): /queue renders for inherited-property tab names and unknown tabs", async () => {
    const { default: Queue } = await import("@/app/(app)/queue/page");
    for (const tab of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "", "pending", "attention", "done", "x".repeat(5000)]) {
      const html = renderToStaticMarkup(await Queue({ searchParams: Promise.resolve({ tab }) }));
      expect(html.length, tab.slice(0, 20)).toBeGreaterThan(0);
    }
  });
});
