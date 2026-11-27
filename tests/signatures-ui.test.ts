import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import { eq } from "drizzle-orm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { contentHash, emailSendPayload } from "@/lib/approvals/payload";
import { getOwnItem, proposeNewMessage } from "@/lib/approvals/service";
import { storeSignatureRead, type SignatureRead } from "@/lib/signatures/refresh";
import { COMPOSE_SIGNATURE_NOTE, EDIT_SIGNATURE_NOTE, ReplySignaturePreview } from "@/app/(app)/signature-ui";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Phase email-signatures, plan steps 7, 8 and 10: what the owner sees. The pages are rendered for
// real (only the session and next/navigation are mocked); DB parts run against TEST_DATABASE_URL.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as { id: string; email: string; name: string | null; timeZone: string | null } | null }));
vi.mock("@/db", async (orig) => ({ ...(await orig<object>()), db: () => state.db }));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user, currentUser: async () => state.user }));
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

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")");
const SIG = "Jane Doe\nExample Co <https://example.com/>";
type Page<P> = { default: (props: P) => Promise<ReactNode> };

describe("reply form preview and fixed notes", () => {
  it("shows the signature as text in a <pre>, or a fixed reason per state", () => {
    const set = renderToStaticMarkup(ReplySignaturePreview({ signature: { state: "set", text: "<b>Jane</b>" } }));
    expect(set).toContain("Your Gmail signature is added below your message, before the quoted text.");
    expect(set).toMatch(/<pre[^>]*>&lt;b&gt;Jane&lt;\/b&gt;<\/pre>/);
    const reasons: [Parameters<typeof ReplySignaturePreview>[0]["signature"]["state"], string][] = [
      ["none", "No signature: none is set in Gmail for this address"],
      [null, "Alex hasn't read this account's signature yet"],
      ["too_large", "Your Gmail signature is too long to add"],
      ["not_found", "Not found in Gmail's settings for this address"],
    ];
    for (const [s, line] of reasons) expect(text(renderToStaticMarkup(ReplySignaturePreview({ signature: { state: s, text: null } })))).toContain(line);
  });

  it("the reply form has no signature field; the compose note and edit note are fixed text", async () => {
    const { ReplyForm } = await import("@/app/(app)/inbox/[threadId]/reply-form");
    const html = renderToStaticMarkup(
      ReplyForm({
        threadId: "00000000-0000-4000-8000-000000000001",
        parentMessageId: "00000000-0000-4000-8000-000000000002",
        account: { email: "work@example.com", label: "business" },
        mode: "reply",
        defaults: { to: ["a@example.org"], cc: [], subject: "Re: x", unreadable: 0, hasQuote: true },
        signature: { state: "set", text: SIG },
      }),
    );
    expect([...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["bodyText", "cc", "includeQuote", "parentMessageId", "subject", "threadId", "to"]);
    expect(text(html)).toContain("Jane Doe Example Co <https://example.com/>");
    const { ComposeForm } = await import("@/app/(app)/compose/compose-form");
    const compose = renderToStaticMarkup(createElement(ComposeForm, { accounts: [] }));
    expect(text(compose)).toContain(COMPOSE_SIGNATURE_NOTE);
    expect([...compose.matchAll(/name="([^"]+)"/g)].map((m) => m[1])).not.toContain("signature");
    expect(EDIT_SIGNATURE_NOTE).toBe("Saving adds this account's current Gmail signature.");
  });
});

describe.skipIf(!testDbUrl)("Accounts page and approval page (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let clock: number;

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
    state.user = { id: u.id, email: u.email, name: null, timeZone: null };
    account = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    clock = Date.now();
  });
  const store = (read: SignatureRead) => {
    clock += 60_000;
    return storeSignatureRead(database, account, read, new Date(clock));
  };
  const accounts = async () => {
    const { default: AccountsPage } = (await import("@/app/(app)/page")) as Page<{ searchParams: Promise<Record<string, string>> }>;
    return renderToStaticMarkup((await AccountsPage({ searchParams: Promise.resolve({}) })) as never);
  };
  const item = async (id: string, edit = false) => {
    const { default: QueueItemPage } = (await import("@/app/(app)/queue/[itemId]/page")) as Page<{ params: Promise<{ itemId: string }>; searchParams: Promise<Record<string, string>> }>;
    return renderToStaticMarkup((await QueueItemPage({ params: Promise.resolve({ itemId: id }), searchParams: Promise.resolve<Record<string, string>>(edit ? { edit: "1" } : {}) })) as never);
  };
  const compose = async () => {
    const r = await proposeNewMessage(database, { userId, accountId: account.id, to: "bob@example.org", cc: "", subject: "Hi", bodyText: "Hello" });
    if (!r.ok) throw new Error(r.error);
    return (await getOwnItem(database, userId, r.itemId))!;
  };

  it("Accounts page: each state line, the error line and the preview", async () => {
    const NOTE = "Alex sends it as plain text: no images or formatting; link addresses are written after the link text.";
    let t = text(await accounts());
    expect(t).toContain("Signature: not read yet");
    expect(t).toContain(NOTE);

    await store({ ok: false, code: "http_500:backendError" });
    t = text(await accounts());
    expect(t).toContain("Signature: not read yet");
    expect(t).toContain("Couldn't read it at the last check (http_500:backendError); no copy yet");

    await store({ ok: true, state: "set", text: "<script>x</script>\nJane" });
    const html = await accounts();
    t = text(html);
    expect(t).toContain("Signature: from Gmail, checked");
    expect(t).not.toContain("Couldn't read it");
    expect(html).toContain("<summary");
    expect(html).toMatch(/<pre[^>]*>&lt;script&gt;x&lt;\/script&gt;\nJane<\/pre>/);
    // (React's own form-replay <script> is in the markup; the signature's never is.)
    expect(html).not.toContain("<script>x</script>");

    await store({ ok: false, code: "http_403" });
    t = text(await accounts());
    expect(t).toContain("Signature: from Gmail, checked");
    expect(t).toMatch(/Couldn't read it at the last check \(http_403\); using the copy from \S/);

    for (const [read, line] of [
      [{ ok: true, state: "none", text: null }, "Signature: none set in Gmail"],
      [{ ok: true, state: "not_found", text: null }, "Signature: not found for this address"],
      [{ ok: true, state: "too_large", text: null }, "Signature: too long to add (over 10,000 characters as text)"],
    ] as const) {
      await store(read);
      const h = await accounts();
      expect(text(h)).toContain(line);
      expect(h).not.toContain("<pre");
    }
  });

  it("approval page: the signature in the body and the 'included' line; the Edit form note", async () => {
    await store({ ok: true, state: "set", text: SIG });
    const it0 = await compose();
    const html = await item(it0.id);
    expect(html).toMatch(/<pre[^>]*>Hello\n\nJane Doe\nExample Co &lt;https:\/\/example.com\/&gt;<\/pre>/);
    const t = text(html);
    expect(t).toContain("Includes your Gmail signature (plain text).");
    expect(t).not.toContain("Your Gmail signature has changed since this was saved.");
    expect(text(await item(it0.id, true))).toContain("Saving adds this account's current Gmail signature.");
  });

  it("approval page: none available; changed since saved (open items only); invisible characters warned", async () => {
    await store({ ok: true, state: "none", text: null });
    const none = await compose();
    expect(text(await item(none.id))).toContain("No signature: none was available for this account when this was saved.");

    await store({ ok: true, state: "set", text: SIG });
    const changedHtml = text(await item(none.id));
    expect(changedHtml).toContain("Your Gmail signature has changed since this was saved. Edit and save to use the current one.");
    // A closed item doesn't get the warning.
    await database.update(schema.approvalItems).set({ status: "rejected" }).where(eq(schema.approvalItems.id, none.id));
    expect(text(await item(none.id))).not.toContain("has changed since this was saved");

    const rlo = String.fromCharCode(0x202e);
    await store({ ok: true, state: "set", text: `Jane ${rlo}Doe` });
    const bidi = await compose();
    expect(text(await item(bidi.id))).toContain("The signature contains 1 invisible, control or text-direction character");
  });

  it("approval page: a legacy item says none will be sent, and offers Edit only when a signature is set", async () => {
    await store({ ok: true, state: "set", text: SIG });
    const legacy = await compose();
    const { signature: _drop, ...payload } = emailSendPayload.parse(legacy.payload);
    void _drop;
    await database.update(schema.approvalItems).set({ payload, contentHash: contentHash("email.send", account.id, payload) }).where(eq(schema.approvalItems.id, legacy.id));
    let t = text(await item(legacy.id));
    expect(t).toContain("Saved before Alex added signatures, so none will be sent. Edit and save to add your current one.");
    expect(t).not.toContain("Jane Doe");
    expect(t).not.toContain("has changed since this was saved");
    await store({ ok: true, state: "none", text: null });
    t = text(await item(legacy.id));
    expect(t).toContain("Saved before Alex added signatures, so none will be sent.");
    expect(t).not.toContain("Edit and save to add your current one.");
  });
});
