import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { desc, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { extractAddresses } from "@/lib/approvals/addresses";
import { HAYSTACK_HEADER_CAP, HAYSTACK_HEADER_FIELD_CAP, threadContext } from "@/lib/approvals/service";
import { hostsIn, linksNotInThread } from "@/lib/approvals/warnings";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// phase-h1-link-hardening C6 (Sec N4, owner Q7 a), Postgres only (TEST_DATABASE_URL, a disposable
// local database): the link-check haystack's copy of each header and subject is bounded (per field
// and in total, newest first, cut on a token boundary); addresses still come from whole headers.

const HOUR = 3_600_000;
/** ASCII filler of exactly n characters made of short words, ending with a space when n is even. */
const filler = (n: number) => "w ".repeat(Math.floor(n / 2)) + (n % 2 ? " " : "");
/** A To/Cc header of about n characters: distinct addresses on .test hosts. */
const addressList = (n: number, tag: string) => {
  const parts: string[] = [];
  for (let i = 0, len = 0; len < n; i++) {
    const p = `u${i}@${tag}${i}.test, `;
    parts.push(p);
    len += p.length;
  }
  return parts.join("");
};

describe.skipIf(!testDbUrl)("H1 C6: haystack header budget (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let acc: ConnectedAccount;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    acc = await makeGoogleAccount(database, userId, { email: "work@example.com" });
  });

  type Msg = { id: string; at: number; subject?: string | null; from?: string; to?: string; cc?: string | null; replyTo?: string | null; bodyText?: string | null };
  async function thread(messages: Msg[], owner = userId, account = acc) {
    const gt = `gt-${Math.random().toString(36).slice(2)}`;
    const [t] = await database
      .insert(schema.mailThreads)
      .values({ userId: owner, accountId: account.id, gmailThreadId: gt, subject: "Lunch", lastMessageAt: new Date(), messageCount: messages.length, inInbox: true, hasUnread: false })
      .returning();
    for (const m of messages) await add(t!.id, gt, m, owner, account);
    return t!;
  }
  async function add(threadId: string, gt: string, m: Msg, owner = userId, account = acc) {
    await database.insert(schema.mailMessages).values({
      userId: owner,
      accountId: account.id,
      threadId,
      gmailMessageId: m.id,
      gmailThreadId: gt,
      internalDate: new Date(m.at),
      labelIds: ["INBOX"],
      isSent: false,
      subject: m.subject === undefined ? "Lunch" : m.subject,
      fromHeader: m.from ?? "Alice <alice@example.org>",
      toHeader: m.to ?? account.email,
      ccHeader: m.cc ?? null,
      replyToHeader: m.replyTo ?? null,
      rfc822MessageId: `<${m.id}@mail.example.org>`,
      headers: [],
      bodyText: m.bodyText === undefined ? "Hello" : m.bodyText,
    });
  }
  /** The batch-3 haystack and addresses (headers in full), from the same rows in the same order. */
  async function oldContext(threadId: string) {
    const rows = await database
      .select()
      .from(schema.mailMessages)
      .where(eq(schema.mailMessages.threadId, threadId))
      .orderBy(desc(schema.mailMessages.internalDate), desc(schema.mailMessages.id));
    const parts: string[] = [];
    const addresses = new Set<string>();
    for (const r of rows) {
      for (const h of [r.fromHeader, r.toHeader, r.ccHeader, r.replyToHeader]) {
        for (const a of extractAddresses(h).addresses) addresses.add(a.toLowerCase());
        if (h) parts.push(h);
      }
      for (const x of [r.subject, r.bodyText, r.renderedText, r.renderedHtml]) if (x) parts.push(x);
    }
    return { haystack: parts.join(" "), addresses: [...addresses].sort() };
  }

  it("the caps are the owner's numbers (Q7)", () => {
    expect(HAYSTACK_HEADER_FIELD_CAP).toBe(16_384);
    expect(HAYSTACK_HEADER_CAP).toBe(262_144);
  });

  it("a normal thread gives the batch-3 haystack byte for byte, and truncated is false", async () => {
    const t = await thread([
      { id: "a", at: Date.now() - 2 * HOUR, subject: "Plans at a.test", from: "Bob <bob@example.org>", to: "work@example.com, carol@example.org", cc: "dan@example.org", replyTo: "list@example.org" },
      { id: "b", at: Date.now() - HOUR, subject: null, bodyText: "see https://b.test/x" },
      { id: "c", at: Date.now(), cc: addressList(HAYSTACK_HEADER_FIELD_CAP - 200, "c"), subject: "x".repeat(HAYSTACK_HEADER_FIELD_CAP) },
    ]);
    const got = await threadContext(database, userId, t.id);
    const want = await oldContext(t.id);
    expect(got.truncated).toBe(false);
    expect(got.haystack === want.haystack).toBe(true);
    expect(got.addresses.sort()).toEqual(want.addresses);
  });

  it("AC-9: a 1 Mi-unit To header: addresses unchanged, at most the field cap in the haystack, cut on a token boundary, truncated", async () => {
    const to = addressList(1024 * 1024, "h");
    const t = await thread([{ id: "a", at: Date.now(), to }]);
    const got = await threadContext(database, userId, t.id);
    const want = await oldContext(t.id);
    expect(got.addresses.sort()).toEqual(want.addresses);
    expect(got.addresses.length).toBeGreaterThan(40_000);
    expect(got.truncated).toBe(true);
    const start = got.haystack.indexOf("u0@h0.test");
    const kept = got.haystack.slice(start, got.haystack.indexOf(" Lunch", start));
    expect(kept.length).toBeLessThanOrEqual(HAYSTACK_HEADER_FIELD_CAP);
    expect(to.startsWith(kept)).toBe(true);
    expect(kept.endsWith(" ")).toBe(true); // cut back to a token boundary
    // A host only beyond the cap is not known, so it is flagged; one inside it is quiet.
    expect(linksNotInThread("https://h0.test/ https://h40000.test/", got.haystack)).toEqual(["https://h40000.test/"]);
  });

  it("a cut inside a host never leaves its prefix known", async () => {
    // The field cap falls inside "evil.test": without the token-boundary cut, "evil.tes" would be a known host.
    const cc = filler(HAYSTACK_HEADER_FIELD_CAP - 4) + "evil.test more";
    expect(cc.slice(HAYSTACK_HEADER_FIELD_CAP - 4, HAYSTACK_HEADER_FIELD_CAP)).toBe("evil");
    const cc2 = filler(HAYSTACK_HEADER_FIELD_CAP - 8) + "evil.test more";
    expect(cc2.slice(HAYSTACK_HEADER_FIELD_CAP - 8, HAYSTACK_HEADER_FIELD_CAP)).toBe("evil.tes");
    const t = await thread([{ id: "a", at: Date.now(), cc: cc2 }]);
    const got = await threadContext(database, userId, t.id);
    expect(got.truncated).toBe(true);
    expect(got.haystack.includes("evil.tes")).toBe(false);
    expect(hostsIn(got.haystack).has("evil.tes")).toBe(false);
    expect(linksNotInThread("Log in at evil.tes today", got.haystack)).toEqual(["evil.tes"]);
  });

  it("the subject is capped like a header", async () => {
    const subject = filler(HAYSTACK_HEADER_FIELD_CAP) + "late.test";
    const t = await thread([{ id: "a", at: Date.now(), subject }]);
    const got = await threadContext(database, userId, t.id);
    expect(got.truncated).toBe(true);
    expect(hostsIn(got.haystack).has("late.test")).toBe(false);
  });

  it("the total header budget is spent newest message first; older headers are left out", async () => {
    // 24 messages with a Cc of just under the field cap each: about 16 of them fit in 256 Ki.
    const n = 24;
    const per = HAYSTACK_HEADER_FIELD_CAP - 100;
    const msgs: Msg[] = [];
    for (let i = 0; i < n; i++) msgs.push({ id: `m${i}`, at: Date.now() - (n - i) * HOUR, cc: `${filler(per - 40)} m${i}.test `, subject: `s${i}` });
    const t = await thread(msgs);
    const got = await threadContext(database, userId, t.id);
    const want = await oldContext(t.id);
    expect(got.truncated).toBe(true);
    expect(got.addresses.sort()).toEqual(want.addresses);
    const known = hostsIn(got.haystack);
    // The newest (m23) is in; the oldest (m0) is out.
    expect(known.has("m23.test")).toBe(true);
    expect(known.has("m0.test")).toBe(false);
    const inCount = Array.from({ length: n }, (_, i) => known.has(`m${i}.test`)).filter(Boolean).length;
    expect(inCount).toBeGreaterThan(10);
    expect(inCount).toBeLessThan(n);
    // Every kept host is newer than every left-out one.
    const firstIn = Array.from({ length: n }, (_, i) => i).find((i) => known.has(`m${i}.test`))!;
    for (let i = firstIn; i < n; i++) expect(known.has(`m${i}.test`), `m${i}`).toBe(true);
    // Header and subject text is within the total cap: the rest is each body ("Hello", 5 units) and at
    // most 6 joining spaces per message.
    expect(got.haystack.length).toBeLessThanOrEqual(HAYSTACK_HEADER_CAP + n * (5 + 6));
    expect(want.haystack.length).toBeGreaterThan(HAYSTACK_HEADER_CAP + n * (5 + 6));
  });

  it("another user's messages are never read", async () => {
    const other = (await makeUser(database, "other@example.com")).id;
    const otherAcc = await makeGoogleAccount(database, other, { email: "other-work@example.com" });
    const mine = await thread([{ id: "a", at: Date.now(), bodyText: "mine.test" }]);
    // A row of the other user's pointing at my thread id (not something sync writes; a defence-in-depth check).
    await add(mine.id, "gt-other", { id: "x", at: Date.now() + HOUR, to: addressList(50_000, "o"), bodyText: "theirs.test" }, other, otherAcc);
    const got = await threadContext(database, userId, mine.id);
    expect(got.haystack.includes("theirs.test")).toBe(false);
    expect(got.haystack.includes("o0.test")).toBe(false);
    expect(got.truncated).toBe(false);
  });
});
