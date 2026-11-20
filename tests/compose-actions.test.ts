import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { Sender } from "@/lib/approvals/execute";
import { getOwnItem, proposeNewMessage } from "@/lib/approvals/service";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Phase 2d at the Server Action and page level: the compose action's sign-in and Origin checks,
// its refusals, the approve action's recipient ticks, and what the compose page and the approval
// page render for a new message. next/headers, next/navigation, next/cache, the session and the
// Gmail sender are mocked. No live Google.

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
    throw new Error("NOT_FOUND");
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
      return { kind: "succeeded", gmailMessageId: `m${state.sends}`, gmailThreadId: `t${state.sends}` };
    }) as Sender,
  }),
  approvalReconcileDeps: () => ({ db: state.db, gmailFor: () => ({ listMessages: async () => ({}) }) }),
  messageIdHost: () => "alex.example.com",
}));

const actions = await import("@/app/(app)/queue/actions");

const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const ANY_ID = "00000000-0000-4000-8000-000000000000";
const root = path.resolve(import.meta.dirname, "..");
/** Source without comments, so documentation doesn't count. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the compose action requires sign-in and the app's Origin", () => {
  beforeEach(() => {
    state.db = new Proxy({}, { get: () => { throw new Error("the database must not be reached"); } });
  });
  it("signed out: redirected to /login; no or foreign Origin: rejected; the database is never reached", async () => {
    state.user = null;
    state.origin = "https://alex.example.com";
    await expect(actions.proposeNewMessageFormAction(null, form({ accountId: ANY_ID }))).rejects.toMatchObject({ url: "/login" });
    state.user = { id: ANY_ID, email: "owner@example.com" };
    for (const origin of [null, "https://evil.example", "null", "http://alex.example.com"]) {
      state.origin = origin;
      await expect(actions.proposeNewMessageFormAction(null, form({ accountId: ANY_ID })), String(origin)).rejects.toThrow("Request origin not allowed");
    }
  });
});

describe("static: the compose page can't be prefilled", () => {
  const page = code(readFileSync(path.join(root, "src/app/(app)/compose/page.tsx"), "utf8"));
  const formSrc = code(readFileSync(path.join(root, "src/app/(app)/compose/compose-form.tsx"), "utf8"));
  it("reads no searchParams, params or URL state, and the form has no defaults beyond the action's own response", () => {
    for (const src of [page, formSrc]) {
      expect(src).not.toMatch(/searchParams|useSearchParams|useParams|params\b|location\.|URLSearchParams/);
    }
    expect(page).toMatch(/export default async function ComposePage\(\)/);
    expect(formSrc).toContain('state?.values ?? { accountId: "", to: "", cc: "", subject: "", bodyText: "" }');
  });
});

describe.skipIf(!testDbUrl)("compose action and pages against Postgres", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let accountId: string;
  let inactiveId: string;

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
    userId = user.id;
    state.user = { id: user.id, email: user.email };
    accountId = (await makeGoogleAccount(database, user.id, { email: "work@example.com", label: "business" })).id;
    inactiveId = (await makeGoogleAccount(database, user.id, { email: "home@example.com" })).id;
    await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, inactiveId));
  });

  const fields = { to: "bob@example.org", cc: "", subject: "Hello", bodyText: "Hi Bob" };

  it("no account picked, another user's account and bad input are refused with the typed values back; nothing is stored", async () => {
    const none = await actions.proposeNewMessageFormAction(null, form(fields));
    expect(none).toEqual({ seq: 1, error: "no_account", invalid: [], values: { accountId: "", ...fields } });
    const other = await makeUser(database, "other@example.com");
    const otherAcc = await makeGoogleAccount(database, other.id, { email: "intruder@example.com" });
    expect(await actions.proposeNewMessageFormAction(none, form({ ...fields, accountId: otherAcc.id }))).toMatchObject({ seq: 2, error: "not_found" });
    expect(await actions.proposeNewMessageFormAction(null, form({ ...fields, accountId: inactiveId }))).toMatchObject({ error: "account_inactive" });
    const bad = await actions.proposeNewMessageFormAction(null, form({ ...fields, accountId, to: "Bob <bob@example.org>", bodyText: "keep me" }));
    expect(bad).toEqual({ seq: 1, error: "invalid_recipients", invalid: ["Bob", "<bob@example.org>"], values: { accountId, to: "Bob <bob@example.org>", cc: "", subject: "Hello", bodyText: "keep me" } });
    expect(await database.select().from(schema.approvalItems)).toEqual([]);
    expect(state.sends).toBe(0);
  });

  it("a valid save creates a pending new-message item from the picked account and opens it; a forged threadId field is ignored", async () => {
    const r = await actions.proposeNewMessageFormAction(null, form({ ...fields, accountId, threadId: ANY_ID, parentMessageId: ANY_ID, from: "evil@example.net" })).catch((e: unknown) => e);
    expect(r).toBeInstanceOf(Redirect);
    const id = (r as Redirect).url.slice("/queue/".length);
    const item = (await getOwnItem(database, userId, id))!;
    expect(item).toMatchObject({ status: "pending", accountId, threadId: null, parentMessageId: null });
    expect(state.sends).toBe(0);
  });

  it("approve: without the ticks nothing is sent; with every box ticked it sends once; more than 100 values are refused", async () => {
    const p = await proposeNewMessage(database, { userId, accountId, to: "bob@example.org\namy@example.net", cc: "", subject: "Hello", bodyText: "Hi" });
    const item = (await getOwnItem(database, userId, (p as { itemId: string }).itemId))!;
    const base = { itemId: item.id, revision: String(item.revision), contentHash: item.contentHash };
    await expect(actions.approveItemAction(form({ ...base, confirmRecipient: ["bob@example.org"] }))).rejects.toMatchObject({ url: `/queue/${item.id}?notice=recipients_unconfirmed` });
    await expect(actions.approveItemAction(form({ ...base, confirmRecipient: Array.from({ length: 101 }, (_, i) => `x${i}@example.org`) }))).rejects.toThrow();
    expect(state.sends).toBe(0);
    await expect(actions.approveItemAction(form({ ...base, confirmRecipient: ["bob@example.org", "amy@example.net"] }))).rejects.toMatchObject({ url: `/queue/${item.id}?notice=sent` });
    expect(state.sends).toBe(1);
  });

  it("compose page: account radios for Google accounts only, none checked, the inactive one disabled; no checkbox", async () => {
    await database.insert(schema.connectedAccounts).values({ userId, provider: "slack", providerAccountId: "S1", email: "slack@example.com" });
    const { default: ComposePage } = await import("@/app/(app)/compose/page");
    const html = renderToStaticMarkup(await ComposePage());
    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios).toHaveLength(2);
    for (const r of radios) expect(r).not.toMatch(/checked/);
    expect(radios.filter((r) => /disabled/.test(r))).toHaveLength(1);
    expect(radios.find((r) => r.includes(inactiveId))).toMatch(/disabled/);
    expect(html).not.toContain("slack@example.com");
    expect(html).not.toMatch(/type="checkbox"/);
    const names = [...new Set([...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]))].sort();
    expect(names).toEqual(["accountId", "bodyText", "cc", "subject", "to"]);
    expect(text(html)).toContain("No Bcc");
    expect(text(html)).toContain("reconnect first");
  });

  it("approval page for a new message: New email, New conversation, one required unticked box per recipient, First time and IDN markers, the count line", async () => {
    const p = await proposeNewMessage(database, { userId, accountId, to: "bob@xn--caf-dma.example\nhome@example.com", cc: "amy@example.net", subject: "Hello", bodyText: "Hi" });
    const id = (p as { itemId: string }).itemId;
    const { default: Page } = await import("@/app/(app)/queue/[itemId]/page");
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ itemId: id }), searchParams: Promise.resolve({}) }));
    const t = text(html);
    expect(t).toContain("New email");
    expect(t).toContain("New conversation");
    expect(t).not.toContain("not in this conversation");
    const boxes = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0]);
    expect(boxes).toHaveLength(3);
    for (const b of boxes) {
      expect(b).toContain('name="confirmRecipient"');
      expect(b).toContain('required=""');
      expect(b).not.toMatch(/checked/);
    }
    expect(boxes.map((b) => /value="([^"]+)"/.exec(b)![1]).sort()).toEqual(["amy@example.net", "bob@xn--caf-dma.example", "home@example.com"]);
    expect(t).toContain("3 recipients: 2 To, 1 Cc");
    // home@ is one of the owner's accounts, so only the other two are first-time.
    expect(t).toContain("2 of them are first-time recipients; today's limit: 10 left.");
    expect(t.match(/First time/g)?.length).toBeGreaterThanOrEqual(2);
    expect(t).toMatch(/internationalised domain/);
    expect(t).toContain(`caf${String.fromCodePoint(0xe9)}.example`);
    expect(html).toContain("<strong>xn--caf-dma.example</strong>");

    const { default: Queue } = await import("@/app/(app)/queue/page");
    expect(text(renderToStaticMarkup(await Queue({ searchParams: Promise.resolve({}) })))).toContain("New email");
  });
  it("round 2: an item with more first-time recipients than the daily limit says so, instead of 'resets at 00:00 UTC'", async () => {
    const to = Array.from({ length: 11 }, (_, i) => `over${i}@example.org`).join(" ");
    const p = await proposeNewMessage(database, { userId, accountId, to, cc: "", subject: "Hello", bodyText: "Hi" });
    const id = (p as { itemId: string }).itemId;
    const { default: Page } = await import("@/app/(app)/queue/[itemId]/page");
    const t = text(renderToStaticMarkup(await Page({ params: Promise.resolve({ itemId: id }), searchParams: Promise.resolve({ notice: "new_recipient_limit" }) })));
    expect(t).toContain("This email has 11 first-time recipients; the daily limit is 10, so it can't be sent as it is");
    expect(t).not.toContain("resets at 00:00 UTC");
    // An item that fits the limit keeps the normal notice.
    const small = await proposeNewMessage(database, { userId, accountId, to: "one@example.org", cc: "", subject: "Hello", bodyText: "Hi" });
    const t2 = text(renderToStaticMarkup(await Page({ params: Promise.resolve({ itemId: (small as { itemId: string }).itemId }), searchParams: Promise.resolve({ notice: "new_recipient_limit" }) })));
    expect(t2).toContain("resets at 00:00 UTC");
    expect(t2).not.toContain("This email has");
  });
});

