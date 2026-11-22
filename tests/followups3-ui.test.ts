import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import { renderToStaticMarkup } from "react-dom/server";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { HAYSTACK_FIELD_CAP, proposeAiReply, proposeReply } from "@/lib/approvals/service";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// phase-2-followups-3 (coder), AC-S3-6: the approval page's fixed truncation note, rendered against
// Postgres. Only the session and next/* are mocked (as in tester-followups2-ui).

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
const NOTE = "This thread is very long, so only its newest part was checked: a link may be flagged even if it appears in an older message.";
const LINKS = "The AI draft mentions links or domains";

describe.skipIf(!testDbUrl)("phase-2-followups-3: approval page truncation note", () => {
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

  async function threadWith(bodyText: string) {
    const gt = `gt-${Math.random().toString(36).slice(2)}`;
    const [t] = await database
      .insert(schema.mailThreads)
      .values({ userId, accountId: acc.id, gmailThreadId: gt, subject: "Lunch", lastMessageAt: new Date(), messageCount: 1, inInbox: true, hasUnread: false })
      .returning();
    const [m] = await database
      .insert(schema.mailMessages)
      .values({
        userId,
        accountId: acc.id,
        threadId: t!.id,
        gmailMessageId: `m-${gt}`,
        gmailThreadId: gt,
        internalDate: new Date(Date.now() - HOUR),
        labelIds: ["INBOX"],
        isSent: false,
        subject: "Lunch",
        fromHeader: "Alice <alice@example.org>",
        toHeader: acc.email,
        rfc822MessageId: `<${gt}@mail.example.org>`,
        headers: [],
        bodyText,
      })
      .returning();
    return { threadId: t!.id, messageId: m!.id };
  }
  async function page(itemId: string) {
    const { default: Page } = await import("@/app/(app)/queue/[itemId]/page");
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ itemId }), searchParams: Promise.resolve({}) }));
  }
  const ai = async (threadId: string, body: string) => ((await proposeAiReply(database, { userId, threadId, mode: "reply", body })) as { itemId: string }).itemId;
  const manual = async (t: { threadId: string; messageId: string }, body: string) =>
    ((await proposeReply(database, { userId, threadId: t.threadId, parentMessageId: t.messageId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: body, includeQuote: false })) as { itemId: string }).itemId;
  const long = "see https://bank.test/ " + "w ".repeat(HAYSTACK_FIELD_CAP);
  const count = (html: string, s: string) => html.split(s).length - 1;

  it("AI item, truncated thread, a flagged link: the note is part of the links warning", { timeout: 60_000 }, async () => {
    const t = await threadWith(long);
    const html = await page(await ai(t.threadId, "Please use https://evil.test/login"));
    expect(html).toContain(LINKS);
    expect(count(html, NOTE)).toBe(1);
    const li = html.slice(html.lastIndexOf("<li", html.indexOf(LINKS)), html.indexOf("</li>", html.indexOf(LINKS)));
    expect(li).toContain(NOTE);
  });

  it("AI item, truncated thread, no flagged link: the note on its own", { timeout: 60_000 }, async () => {
    const t = await threadWith(long);
    const html = await page(await ai(t.threadId, "Please use https://bank.test/login"));
    expect(html).not.toContain(LINKS);
    expect(count(html, NOTE)).toBe(1);
  });

  it("never for an AI item on a short thread, or for a manual item on a truncated one", { timeout: 60_000 }, async () => {
    const short = await threadWith("see https://bank.test/");
    const a = await page(await ai(short.threadId, "Please use https://evil.test/login"));
    expect(a).toContain(LINKS);
    expect(a).not.toContain(NOTE);
    const t = await threadWith(long);
    const m = await page(await manual(t, "Please use https://evil.test/login"));
    expect(m).not.toContain(NOTE);
    expect(m).not.toContain(LINKS);
  });
});
