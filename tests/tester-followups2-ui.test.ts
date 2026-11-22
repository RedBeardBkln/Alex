import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import { renderToStaticMarkup } from "react-dom/server";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { newerDigest, proposeReply } from "@/lib/approvals/service";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester, phase-2-followups-2: renders the real Inbox page (O2 notice, owner Q7) and the approval
// page (SF2 option c: warning, tick and hidden shownNewer) against Postgres; only the session and
// next/* are mocked.

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

const HOUR = 3_600_000;
const NOTICE = "its account was disconnected";

describe.skipIf(!testDbUrl)("tester phase-2-followups-2: Inbox notice and approval page", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let acc: ConnectedAccount;

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
    acc = await makeGoogleAccount(database, userId, { email: "work@example.com" });
  });

  async function inbox(params: Record<string, string>) {
    const { default: Inbox } = await import("@/app/(app)/inbox/page");
    return renderToStaticMarkup(await Inbox({ searchParams: Promise.resolve(params) }));
  }

  it("Inbox: the fixed notice for account_disconnected only; unknown, inherited or injected values show nothing and are never echoed", { timeout: 30_000 }, async () => {
    const ok = await inbox({ notice: "account_disconnected" });
    expect(ok).toContain(NOTICE);
    expect(ok).toContain('role="status"');
    for (const v of ["", "constructor", "__proto__", "toString", "hasOwnProperty", "ACCOUNT_DISCONNECTED", "account_disconnected ", "<b>x</b>", "valueOf"]) {
      const html = await inbox({ notice: v });
      expect(html, v).not.toContain(NOTICE);
      expect(html, v).not.toContain('role="status"');
      if (v.length > 3) expect(html, v).not.toContain(v.replace(/</g, "&lt;"));
    }
    expect(await inbox({})).not.toContain(NOTICE);
  });

  async function threadWith(messages: { id: string; at: number }[]) {
    const gt = `gt-${Math.random().toString(36).slice(2)}`;
    const [t] = await database
      .insert(schema.mailThreads)
      .values({ userId, accountId: acc.id, gmailThreadId: gt, subject: "Lunch", lastMessageAt: new Date(), messageCount: messages.length, inInbox: true, hasUnread: false })
      .returning();
    const rows = [];
    for (const m of messages) rows.push(await add(t!.id, gt, m));
    return { thread: t!, gt, rows };
  }
  async function add(threadId: string, gt: string, m: { id: string; at: number }) {
    const [row] = await database
      .insert(schema.mailMessages)
      .values({
        userId,
        accountId: acc.id,
        threadId,
        gmailMessageId: m.id,
        gmailThreadId: gt,
        internalDate: new Date(m.at),
        labelIds: ["INBOX"],
        isSent: false,
        subject: "Lunch",
        fromHeader: "Alice <alice@example.org>",
        toHeader: acc.email,
        rfc822MessageId: `<${m.id}@mail.example.org>`,
        headers: [],
        bodyText: "Hello",
      })
      .returning();
    return row!;
  }
  async function page(itemId: string) {
    const { default: Page } = await import("@/app/(app)/queue/[itemId]/page");
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ itemId }), searchParams: Promise.resolve({}) }));
  }
  const hidden = (html: string, name: string) => {
    const m = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`));
    return m ? (m[0].match(/value="([^"]*)"/)?.[1] ?? null) : null;
  };

  it("approval page: no newer message → no warning, no tick, shownNewer empty; an unflagged newer message → warning, required tick, shownNewer = its digest", { timeout: 30_000 }, async () => {
    const t = await threadWith([{ id: "p1", at: Date.now() - HOUR }]);
    const r = (await proposeReply(database, { userId, threadId: t.thread.id, parentMessageId: t.rows[0]!.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Sounds good", includeQuote: false })) as { itemId: string };
    const quiet = await page(r.itemId);
    expect(hidden(quiet, "shownNewer")).toBe("");
    expect(quiet).not.toContain("New messages arrived");
    expect(quiet).not.toContain('name="ackThreadChange"');
    const m = await add(t.thread.id, t.gt, { id: "m2", at: Date.now() - 60_000 });
    const after = await page(r.itemId);
    expect(after).toContain("New messages arrived");
    expect(after).toMatch(/<input[^>]*name="ackThreadChange"[^>]*>/);
    expect(after.match(/<input[^>]*name="ackThreadChange"[^>]*>/)![0]).toContain("required");
    expect(hidden(after, "shownNewer")).toBe(newerDigest([m.id]));
    expect(hidden(after, "shownThreadChangedAt")).toBe("");
  });
});
