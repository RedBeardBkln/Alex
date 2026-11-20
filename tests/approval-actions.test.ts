import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { Sender } from "@/lib/approvals/execute";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Phase 2b AC9 at the Server Action level: sign-in, the Origin requirement, user scoping and the
// server-side account, with next/headers, next/navigation, next/cache, the session and the Gmail
// sender mocked. No live Google.

const state = vi.hoisted(() => ({
  origin: null as string | null,
  user: null as { id: string; email: string } | null,
  db: null as unknown,
  sends: 0,
}));

class Redirect extends Error {
  constructor(public readonly url: string) {
    super(`redirect ${url}`);
  }
}

vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.origin === null ? {} : { origin: state.origin }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({
  requireUser: async () => {
    if (!state.user) throw new Redirect("/login");
    return state.user;
  },
}));
vi.mock("@/db", async (orig) => ({ ...(await orig<object>()), db: () => state.db }));
vi.mock("@/lib/approvals/runtime", () => ({
  approvalExecutorDeps: () => ({
    db: state.db,
    send: (async () => {
      state.sends++;
      await new Promise((r) => setTimeout(r, 20));
      return { kind: "succeeded", gmailMessageId: `m${state.sends}`, gmailThreadId: "gt1" };
    }) as Sender,
  }),
  approvalReconcileDeps: () => ({ db: state.db, gmailFor: () => ({ listMessages: async () => ({}) }) }),
  messageIdHost: () => "alex.example.com",
}));

const actions = await import("@/app/(app)/queue/actions");

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const ALL = [
  actions.proposeReplyAction,
  actions.editItemAction,
  actions.approveItemAction,
  actions.rejectItemAction,
  actions.cancelItemAction,
  actions.markNotSentAction,
  actions.recheckItemAction,
  (f: FormData) => actions.proposeReplyFormAction(null, f),
];
const ANY_ID = "00000000-0000-4000-8000-000000000000";

describe("every approval action requires sign-in and the app's Origin", () => {
  beforeEach(() => {
    state.db = new Proxy({}, { get: () => { throw new Error("the database must not be reached"); } });
    state.sends = 0;
  });

  it("signed out: redirected to /login before anything else", async () => {
    state.user = null;
    state.origin = "https://alex.example.com";
    for (const action of ALL) await expect(action(form({ itemId: ANY_ID }))).rejects.toMatchObject({ url: "/login" });
  });

  it("no Origin header, a foreign Origin or the literal null Origin: rejected", async () => {
    state.user = { id: ANY_ID, email: "owner@example.com" };
    for (const origin of [null, "https://evil.example", "null", "http://alex.example.com", "https://alex.example.com.evil.example"]) {
      state.origin = origin;
      for (const action of ALL) await expect(action(form({ itemId: ANY_ID })), String(origin)).rejects.toThrow("Request origin not allowed");
    }
    expect(state.sends).toBe(0);
  });
});

describe.skipIf(!testDbUrl)("approval actions against Postgres", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let threadId: string;
  let parentId: string;
  let accountId: string;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    state.db = database;
    state.sends = 0;
    state.origin = "https://alex.example.com";
    await database.delete(schema.users);
    const user = await makeUser(database);
    state.user = { id: user.id, email: user.email };
    const account = await makeGoogleAccount(database, user.id, { email: "work@example.com" });
    accountId = account.id;
    const [thread] = await database
      .insert(schema.mailThreads)
      .values({ userId: user.id, accountId, gmailThreadId: "gt1", subject: "Lunch", lastMessageAt: new Date(), messageCount: 1, inInbox: true, hasUnread: false })
      .returning();
    threadId = thread!.id;
    const [m] = await database
      .insert(schema.mailMessages)
      .values({
        userId: user.id,
        accountId,
        threadId,
        gmailMessageId: "p1",
        gmailThreadId: "gt1",
        internalDate: new Date(Date.now() - 60_000),
        labelIds: ["INBOX"],
        isSent: false,
        subject: "Lunch",
        fromHeader: "Alice <alice@example.org>",
        rfc822MessageId: "<p1@mail.example.org>",
        headers: [],
        bodyText: "Hello",
      })
      .returning();
    parentId = m!.id;
  });

  async function propose(extra: Record<string, string> = {}) {
    const r = await actions
      .proposeReplyAction(form({ threadId, parentMessageId: parentId, to: "alice@example.org", subject: "Re: Lunch", bodyText: "Yes", includeQuote: "on", ...extra }))
      .catch((e: unknown) => e);
    expect(r).toBeInstanceOf(Redirect);
    const url = (r as Redirect).url;
    expect(url).toMatch(/^\/queue\/[0-9a-f-]{36}$/);
    const [item] = await database.select().from(schema.approvalItems).where(eq(schema.approvalItems.id, url.slice("/queue/".length)));
    return item!;
  }

  it("propose: the account comes from the thread; a forged accountId field is ignored; nothing is sent", async () => {
    const other = await makeGoogleAccount(database, state.user!.id, { email: "personal@example.com" });
    const item = await propose({ accountId: other.id, from: "personal@example.com" });
    expect(item).toMatchObject({ status: "pending", accountId, threadId });
    expect(state.sends).toBe(0);
  });

  it("approve sends once; a replayed POST sends nothing; another user's approve does nothing", async () => {
    const item = await propose();
    const fields = { itemId: item.id, revision: String(item.revision), contentHash: item.contentHash };
    await expect(actions.approveItemAction(form(fields))).rejects.toMatchObject({ url: `/queue/${item.id}?notice=sent` });
    await expect(actions.approveItemAction(form(fields))).rejects.toMatchObject({ url: `/queue/${item.id}?notice=stale` });
    expect(state.sends).toBe(1);

    const second = await propose();
    const owner = state.user;
    state.user = { id: (await makeUser(database, "other@example.com")).id, email: "other@example.com" };
    await expect(actions.approveItemAction(form({ itemId: second.id, revision: "1", contentHash: second.contentHash }))).rejects.toMatchObject({
      url: `/queue/${second.id}?notice=not_found`,
    });
    await expect(actions.rejectItemAction(form({ itemId: second.id }))).rejects.toMatchObject({ url: `/queue/${second.id}?notice=stale` });
    state.user = owner;
    expect(state.sends).toBe(1);
    const [still] = await database.select().from(schema.approvalItems).where(eq(schema.approvalItems.id, second.id));
    expect(still!.status).toBe("pending");
  });

  it("10 concurrent approve POSTs send exactly once", async () => {
    const item = await propose();
    const fields = { itemId: item.id, revision: String(item.revision), contentHash: item.contentHash };
    const results = await Promise.all(Array.from({ length: 10 }, () => actions.approveItemAction(form(fields)).catch((e: Redirect) => e.url)));
    expect(state.sends).toBe(1);
    expect(results.filter((u) => u === `/queue/${item.id}?notice=sent`)).toHaveLength(1);
  });

  it("N2: a refused save keeps the mode (plain action) and the typed values (form action)", async () => {
    const bad = { threadId, parentMessageId: parentId, mode: "all", to: "not an address", cc: "c@example.org", subject: "Re: Lunch", bodyText: "my long reply", includeQuote: "on" };
    await expect(actions.proposeReplyAction(form(bad))).rejects.toMatchObject({ url: `/inbox/${threadId}?reply=all&error=invalid_recipients#reply` });
    const first = await actions.proposeReplyFormAction(null, form(bad));
    expect(first).toEqual({ seq: 1, error: "invalid_recipients", values: { to: "not an address", cc: "c@example.org", subject: "Re: Lunch", bodyText: "my long reply", includeQuote: true } });
    const { includeQuote: _omit, ...unticked } = bad; // an unticked checkbox isn't submitted
    const second = await actions.proposeReplyFormAction(first, form(unticked));
    expect(second).toMatchObject({ seq: 2, values: { bodyText: "my long reply", includeQuote: false } });
    expect(await database.select().from(schema.approvalItems)).toEqual([]);
    // And a valid save through the form action redirects to the new item.
    await expect(actions.proposeReplyFormAction(second, form({ ...bad, to: "alice@example.org" }))).rejects.toMatchObject({ url: expect.stringMatching(/^\/queue\/[0-9a-f-]{36}$/) });
  });

  it("B1: the approve form's rendered thread_changed_at is enforced", async () => {
    const item = await propose();
    await database.update(schema.approvalItems).set({ threadChangedAt: new Date() }).where(eq(schema.approvalItems.id, item.id));
    const [flagged] = await database.select().from(schema.approvalItems).where(eq(schema.approvalItems.id, item.id));
    const fields = { itemId: item.id, revision: String(item.revision), contentHash: item.contentHash, ackThreadChange: "on" };
    // Rendered with no warning (empty field), or with an older value: refused.
    await expect(actions.approveItemAction(form(fields))).rejects.toMatchObject({ url: `/queue/${item.id}?notice=ack_required` });
    await expect(actions.approveItemAction(form({ ...fields, shownThreadChangedAt: String(flagged!.threadChangedAt!.getTime() - 1) }))).rejects.toMatchObject({ url: `/queue/${item.id}?notice=ack_required` });
    await expect(actions.approveItemAction(form({ ...fields, shownThreadChangedAt: "12x" }))).rejects.toThrow();
    expect(state.sends).toBe(0);
    await expect(actions.approveItemAction(form({ ...fields, shownThreadChangedAt: String(flagged!.threadChangedAt!.getTime()) }))).rejects.toMatchObject({ url: `/queue/${item.id}?notice=sent` });
    expect(state.sends).toBe(1);
  });

  it("N1: ?tab= ignores inherited keys such as constructor", async () => {
    const { default: QueuePage } = await import("@/app/(app)/queue/page");
    for (const tab of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      await expect(QueuePage({ searchParams: Promise.resolve({ tab }) }), tab).resolves.toBeTruthy();
    }
  });

  it("input is validated: a bad hash or revision is refused before anything happens", async () => {
    const item = await propose();
    await expect(actions.approveItemAction(form({ itemId: item.id, revision: "1", contentHash: "x" }))).rejects.toThrow();
    await expect(actions.approveItemAction(form({ itemId: item.id, revision: "0", contentHash: item.contentHash }))).rejects.toThrow();
    await expect(actions.approveItemAction(form({ itemId: "not-a-uuid", revision: "1", contentHash: item.contentHash }))).rejects.toThrow();
    expect(state.sends).toBe(0);
  });
});
