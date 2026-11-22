import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ApprovalItem, ConnectedAccount } from "@/db/schema";
import { deleteAccount } from "@/lib/accounts";
import type { Caps } from "@/lib/ai-ledger/config";
import { emptyUsage, SPEND_LIMIT_CODE } from "@/lib/ai-ledger/ledger";
import { costUsdMicros } from "@/lib/ai-ledger/pricing";
import { runTriageStage, triageThreadNow } from "@/lib/ai/triage";
import type { TriageOutcome, TriageProvider } from "@/lib/ai/types";
import { extractAddresses } from "@/lib/approvals/addresses";
import { approveItem as realApproveItem, getItemView, getOwnItem, HAYSTACK_CAP, HAYSTACK_FIELD_CAP, proposeReply, threadContext } from "@/lib/approvals/service";
import { hostsIn, linksNotInThread } from "@/lib/approvals/warnings";
import { approveItem } from "./helpers/approve";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// phase-2-followups-3 (coder), Postgres only (TEST_DATABASE_URL, a disposable local database):
// - S1: shownNewer is required (an untyped undefined fails closed); the test wrapper's computed default.
// - S3: threadContext's bounded haystack (caps, newest first, token-boundary cuts, headers in full).
// - Triage: N-2 (cap audit before the disconnect stop), N-3 (not_found for a deleted message) and
//   security N1 (skipped_cap rows only for messages still present).

const HOST = "alex.example.com";
const HOUR = 3_600_000;
const BIG: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 100, draftMicros: 30_000_000, totalMicros: 35_000_000 };
const TRIAGE_USAGE = { ...emptyUsage("anthropic-haiku", "claude-haiku-5-5", 5), inputTokens: 800, outputTokens: 60 };
const TRIAGE_COST = costUsdMicros("claude-haiku-5-5", TRIAGE_USAGE)!;
const cp = (n: number) => String.fromCodePoint(n);
const pgCode = (err: unknown): string => {
  const e = err as { cause?: { code?: string }; code?: string };
  return e?.cause?.code ?? e?.code ?? (err instanceof Error ? err.name : "?");
};
/** ASCII filler of exactly n characters made of short words, ending with a space when n is even. */
const filler = (n: number) => "w ".repeat(Math.floor(n / 2)) + (n % 2 ? " " : "");

describe.skipIf(!testDbUrl)("phase-2-followups-3 (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;
  let userId: string;
  let acc: ConnectedAccount;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    pool = postgres(testDbUrl!, { max: 4, onnotice: () => {} });
    poolDb = drizzle(pool, { schema }) as unknown as Database;
  });
  afterAll(async () => {
    await pool.end();
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    acc = await makeGoogleAccount(database, userId, { email: "work@example.com" });
  });

  type Msg = { id: string; at: number; subject?: string; from?: string; bodyText?: string | null; renderedText?: string | null; renderedHtml?: string | null };
  async function thread(messages: Msg[], ex: Database = database) {
    const gt = `gt-${Math.random().toString(36).slice(2)}`;
    const [t] = await ex
      .insert(schema.mailThreads)
      .values({ userId, accountId: acc.id, gmailThreadId: gt, subject: "Lunch", lastMessageAt: new Date(), messageCount: messages.length, inInbox: true, hasUnread: false })
      .returning();
    const rows = [];
    for (const m of messages) rows.push(await add(t!.id, gt, m, ex));
    return { thread: t!, gt, rows };
  }
  async function add(threadId: string, gt: string, m: Msg, ex: Database = database) {
    const [row] = await ex
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
        subject: m.subject ?? "Lunch",
        fromHeader: m.from ?? "Alice <alice@example.org>",
        toHeader: acc.email,
        rfc822MessageId: `<${m.id}@mail.example.org>`,
        headers: [],
        bodyText: m.bodyText === undefined ? "Hello" : m.bodyText,
        renderedText: m.renderedText ?? null,
        renderedHtml: m.renderedHtml ?? null,
      })
      .returning();
    return row!;
  }
  const reply = async (threadId: string, parentId: string) =>
    ((await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Sounds good", includeQuote: false })) as { ok: true; itemId: string }).itemId;
  const reload = async (id: string) => (await getOwnItem(database, userId, id))!;
  const input = (item: ApprovalItem) => ({
    userId,
    itemId: item.id,
    revision: item.revision,
    contentHash: item.contentHash,
    ackThreadChange: false,
    shownThreadChangedAt: null,
    messageIdHost: HOST,
    confirmedRecipients: [],
    newRecipientLimit: 10,
  });

  // ---- S1 -----------------------------------------------------------------------------------------

  it("AC-S1-2: an untyped shownNewer: undefined is ack_required, with and without newer messages", async () => {
    const t = await thread([{ id: "p1", at: Date.now() - HOUR }]);
    const item = await reload(await reply(t.thread.id, t.rows[0]!.id));
    const untyped = realApproveItem as (ex: Database, i: unknown) => ReturnType<typeof realApproveItem>;
    expect(await untyped(database, { ...input(item), shownNewer: undefined })).toEqual({ kind: "blocked", reason: "ack_required" });
    expect(await untyped(database, { ...input(item), ackThreadChange: true, shownNewer: undefined })).toEqual({ kind: "blocked", reason: "ack_required" });
    await add(t.thread.id, t.gt, { id: "m2", at: Date.now() - 60_000 });
    expect(await untyped(database, { ...input(item), ackThreadChange: true, shownNewer: undefined })).toEqual({ kind: "blocked", reason: "ack_required" });
    // The real function with the empty digest still approves a thread with no newer messages.
    const t2 = await thread([{ id: "q1", at: Date.now() - HOUR }]);
    const quiet = await reload(await reply(t2.thread.id, t2.rows[0]!.id));
    expect(await realApproveItem(database, { ...input(quiet), shownNewer: "" })).toEqual({ kind: "approved" });
  });

  it("the test wrapper computes the digest when shownNewer is omitted, and passes an explicit value through", async () => {
    const t = await thread([{ id: "p1", at: Date.now() - HOUR }]);
    const item = await reload(await reply(t.thread.id, t.rows[0]!.id));
    await add(t.thread.id, t.gt, { id: "m2", at: Date.now() - 60_000 });
    // "The page was rendered just now": it shows the newer message, so the tick is still required.
    expect(await approveItem(database, input(item))).toEqual({ kind: "blocked", reason: "ack_required" });
    // An explicit value is not replaced.
    expect(await approveItem(database, { ...input(item), ackThreadChange: true, shownNewer: "" })).toEqual({ kind: "blocked", reason: "ack_required" });
    expect(await approveItem(database, { ...input(item), ackThreadChange: true })).toEqual({ kind: "approved" });
  });

  // T1 (round 2): the Q6 / review-B1 thread_changed_at checks, isolated from the SF2 digest. The thread
  // has no newer message (digest ""), so only the thread_changed_at checks can block. Real approveItem.
  describe("Q6/B1 thread_changed_at checks on their own (digest empty)", () => {
    const flagged = async (at: number | null) => {
      const t = await thread([{ id: `q6-${Math.random().toString(36).slice(2)}`, at: Date.now() - HOUR }]);
      const id = await reply(t.thread.id, t.rows[0]!.id);
      await database.update(schema.approvalItems).set({ threadChangedAt: at === null ? null : new Date(at) }).where(eq(schema.approvalItems.id, id));
      return reload(id);
    };
    const X = Date.now() - 30_000;
    const go = (item: ApprovalItem, shownThreadChangedAt: number | null, ackThreadChange: boolean) =>
      realApproveItem(database, { ...input(item), shownNewer: "", shownThreadChangedAt, ackThreadChange });
    const ACK = { kind: "blocked", reason: "ack_required" };

    it("a flag the page didn't show (null) is ack_required, even with the tick", async () => {
      expect(await go(await flagged(X), null, true)).toEqual(ACK);
    });
    it("an older shown flag (1 ms earlier) is ack_required, even with the tick", async () => {
      expect(await go(await flagged(X), X - 1, true)).toEqual(ACK);
    });
    it("a shown flag that is no longer stored is ack_required", async () => {
      expect(await go(await flagged(null), X, true)).toEqual(ACK);
    });
    it("the shown flag without the tick is ack_required", async () => {
      expect(await go(await flagged(X), X, false)).toEqual(ACK);
    });
    it("a mismatched flag is refused before the first-time-recipient cap runs (no new_recipient_limit audit)", async () => {
      // The conditional UPDATE also re-checks the flag, so only the order of the checks shows the pre-check.
      const t = await thread([{ id: `q6-${Math.random().toString(36).slice(2)}`, at: Date.now() - HOUR }]);
      const r = (await proposeReply(database, { userId, threadId: t.thread.id, parentMessageId: t.rows[0]!.id, to: "stranger@example.net", cc: "", subject: "Re: Lunch", bodyText: "Hi", includeQuote: false })) as { ok: true; itemId: string };
      await database.update(schema.approvalItems).set({ threadChangedAt: new Date(X) }).where(eq(schema.approvalItems.id, r.itemId));
      const item = await reload(r.itemId);
      expect(await realApproveItem(database, { ...input(item), newRecipientLimit: 0, shownNewer: "", shownThreadChangedAt: X - 1, ackThreadChange: true })).toEqual(ACK);
      expect((await database.select().from(schema.auditLog)).filter((a) => a.action === "approval.new_recipient_limit")).toEqual([]);
      // Control: with the flag shown, the cap is what blocks.
      expect(await realApproveItem(database, { ...input(item), newRecipientLimit: 0, shownNewer: "", shownThreadChangedAt: X, ackThreadChange: true })).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
    });
    it("a flag moved after the pre-check (before the transaction) is caught by the conditional UPDATE", async () => {
      const item = await flagged(X);
      const moved = new Proxy(database, {
        get(target, p, r) {
          if (p === "transaction")
            return async (fn: never, cfg?: never) => {
              await target.update(schema.approvalItems).set({ threadChangedAt: new Date(X + 1) }).where(eq(schema.approvalItems.id, item.id));
              return target.transaction(fn, cfg);
            };
          return Reflect.get(target, p, r);
        },
      }) as Database;
      expect(await realApproveItem(moved, { ...input(item), shownNewer: "", shownThreadChangedAt: X, ackThreadChange: true })).toEqual(ACK);
      expect((await reload(item.id)).status).toBe("pending");
    });
    it("controls: the shown flag with the tick approves; no flag, none shown, no tick approves", async () => {
      expect(await go(await flagged(X), X, true)).toEqual({ kind: "approved" });
      expect(await go(await flagged(null), null, false)).toEqual({ kind: "approved" });
    });
  });

  // ---- S3 -----------------------------------------------------------------------------------------

  /** The batch-2 haystack, built from the same rows in the same (newest first) order. */
  async function oldHaystack(threadId: string) {
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
    return { haystack: parts.join(" "), addresses: [...addresses] };
  }

  it("AC-S3-5: an under-cap thread gives the batch-2 haystack exactly, and truncated is false", async () => {
    const t = await thread([
      { id: "a", at: Date.now() - 3 * HOUR, bodyText: "first https://a.test/x", renderedText: "first", renderedHtml: "<p>first</p>" },
      { id: "b", at: Date.now() - 2 * HOUR, bodyText: null, renderedText: "second b.test", from: "Bob <bob@example.org>" },
      { id: "c", at: Date.now() - HOUR, bodyText: "", renderedHtml: `<a href="https://c.test/">c</a> ${filler(HAYSTACK_FIELD_CAP - 40)}` },
    ]);
    const got = await threadContext(database, userId, t.thread.id);
    const want = await oldHaystack(t.thread.id);
    expect(got.truncated).toBe(false);
    expect(got.haystack === want.haystack).toBe(true);
    expect(got.addresses.sort()).toEqual(want.addresses.sort());
  });

  it("a non-ASCII field over the cap in bytes but not in characters is not cut", async () => {
    const body = `${cp(0xe9)} `.repeat(120_000) + "end.test"; // 248,008 units, 368,008 UTF-8 bytes
    const t = await thread([{ id: "a", at: Date.now(), bodyText: body }]);
    const got = await threadContext(database, userId, t.thread.id);
    expect(got.truncated).toBe(false);
    expect(got.haystack.endsWith("end.test")).toBe(true);
  });

  it("AC-S3-2/3: four 4 MB bodies (and 1 MB rendered fields): bounded, newest first, headers and subjects of every message kept", { timeout: 120_000 }, async () => {
    const big = (host: string, mb = 4) => `see https://${host}/x ` + filler(mb * 1024 * 1024);
    const r = (host: string) => big(host, 1);
    const t = await thread([
      { id: "m1", at: Date.now() - 4 * HOUR, subject: "About oldsubject.test", from: "Old <old@example.org>", bodyText: big("oldest.test"), renderedText: r("oldest-r.test"), renderedHtml: r("oldest-h.test") },
      { id: "m2", at: Date.now() - 3 * HOUR, bodyText: big("second.test"), renderedText: r("second-r.test"), renderedHtml: r("second-h.test") },
      { id: "m3", at: Date.now() - 2 * HOUR, bodyText: big("third.test"), renderedText: r("third-r.test"), renderedHtml: r("third-h.test") },
      { id: "m4", at: Date.now() - HOUR, bodyText: big("newest.test"), renderedText: r("newest-r.test"), renderedHtml: r("newest-h.test") },
    ]);
    const ctx = await threadContext(database, userId, t.thread.id);
    expect(ctx.truncated).toBe(true);
    const headerChars = (await oldHaystackHeaders(t.thread.id)).length;
    expect(ctx.haystack.length).toBeLessThanOrEqual(HAYSTACK_CAP + headerChars + 64);
    // Newest first: 8 fields of 256 Ki fill the 2 Mi cap (m4's three, m3's three, m2's first two).
    const known = hostsIn(ctx.haystack);
    for (const h of ["newest.test", "newest-r.test", "newest-h.test", "third.test", "third-r.test", "third-h.test", "second.test", "second-r.test"]) expect(known.has(h), h).toBe(true);
    for (const h of ["second-h.test", "oldest.test", "oldest-r.test", "oldest-h.test"]) expect(known.has(h), h).toBe(false);
    // Headers and subjects of every message are always in.
    expect(known.has("oldsubject.test")).toBe(true);
    expect(ctx.addresses).toContain("old@example.org");
    expect(linksNotInThread("https://oldest.test/x and https://newest.test/x", ctx.haystack)).toEqual(["https://oldest.test/x"]);

    // Timing (in-process guard; the tester times it in its own process): the page's work for a
    // 500-unknown-host, 20,000-character AI body.
    const item = await reload(await reply(t.thread.id, t.rows[3]!.id));
    const body = Array.from({ length: 500 }, (_, i) => `https://h${i}.example/abcdefghijklmnopq`).join(" ").slice(0, 20_000);
    const time = async () => {
      const t0 = performance.now();
      const v = (await getItemView(database, userId, item.id, { newRecipientLimit: 10 }))!;
      const flagged = linksNotInThread(body, v.threadHaystack);
      return { ms: performance.now() - t0, flagged: flagged.length, truncated: v.threadHaystackTruncated };
    };
    await time();
    const r4 = await time();
    // Double the stored thread: four more 4 MB messages, older than the rest.
    for (let i = 0; i < 4; i++) await add(t.thread.id, t.gt, { id: `o${i}`, at: Date.now() - (10 + i) * HOUR, bodyText: big(`older${i}.test`), renderedText: r(`older${i}-r.test`), renderedHtml: r(`older${i}-h.test`) });
    await time();
    const r8 = await time();
    console.info("AC-S3-2 timing (ms, in-process)", { fourMessages: Math.round(r4.ms), eightMessages: Math.round(r8.ms) });
    expect(r4.truncated && r8.truncated).toBe(true);
    expect(r4.flagged).toBeGreaterThan(400);
    expect(r4.ms).toBeLessThan(3_000);
    expect(r8.ms).toBeLessThan(Math.max(3_000, r4.ms * 2));
  });

  async function oldHaystackHeaders(threadId: string) {
    const rows = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.threadId, threadId));
    return rows.flatMap((r) => [r.fromHeader, r.toHeader, r.ccHeader, r.replyToHeader, r.subject].filter((x): x is string => !!x).map((x) => `${x} `)).join("");
  }

  it("AC-S3-4: a field cut inside bank.com doesn't make bank.co known", async () => {
    const body = filler(HAYSTACK_FIELD_CAP - 7) + "bank.com and more";
    expect(body.slice(HAYSTACK_FIELD_CAP - 7, HAYSTACK_FIELD_CAP)).toBe("bank.co");
    const t = await thread([{ id: "a", at: Date.now(), bodyText: body }]);
    const ctx = await threadContext(database, userId, t.thread.id);
    expect(ctx.truncated).toBe(true);
    expect(ctx.haystack.includes("bank.co")).toBe(false);
    expect(linksNotInThread("Log in at bank.co today", ctx.haystack)).toEqual(["bank.co"]);
  });

  it("an astral-character field is cut on a code point and a token boundary, within the field cap", async () => {
    const body = `${cp(0x1f600)} `.repeat(100_000); // 300,000 units
    const t = await thread([{ id: "a", at: Date.now(), bodyText: body }]);
    const ctx = await threadContext(database, userId, t.thread.id);
    expect(ctx.truncated).toBe(true);
    const field = ctx.haystack.slice(ctx.haystack.indexOf(cp(0x1f600)));
    expect(field.length).toBeLessThanOrEqual(HAYSTACK_FIELD_CAP);
    expect(field.endsWith(" ")).toBe(true);
    expect(field.isWellFormed()).toBe(true);
  });

  // ---- Triage ---------------------------------------------------------------------------------------

  const okTriage = (): TriageOutcome => ({ status: "ok", result: { category: "fyi", needsReply: false, summary: "A note." }, errorCode: null, usage: TRIAGE_USAGE });
  const aiAudits = async () => (await database.select().from(schema.auditLog)).filter((a) => a.action.startsWith("ai.")).map((a) => ({ action: a.action, accountId: a.accountId, detail: a.detail }));

  it("AC-T-1 (N-2): the account is gone and the provider hit the spend limit: one cap_reached audit, and the stage stops", async () => {
    await thread([{ id: "a1", at: Date.now() - HOUR }]);
    await thread([{ id: "b1", at: Date.now() - 2 * HOUR }]);
    let called = 0;
    const provider: TriageProvider = {
      id: "anthropic-haiku",
      triage: async () => {
        called++;
        await deleteAccount(database, userId, acc.id, { attempts: 1 });
        return { status: "error", result: null, errorCode: SPEND_LIMIT_CODE, usage: emptyUsage("anthropic-haiku", "claude-haiku-5-5", 5) };
      },
    };
    const r = await runTriageStage({ db: database, provider, caps: BIG }, acc);
    expect(called).toBe(1);
    expect(r).toMatchObject({ triaged: 0, failed: 1, skippedCap: 0 });
    const audits = await aiAudits();
    expect(audits.filter((a) => a.action === "ai.cap_reached")).toEqual([{ action: "ai.cap_reached", accountId: null, detail: { purpose: "triage", cap: "spend_limit" } }]);
    expect(audits.map((a) => a.action).sort()).toEqual(["ai.cap_reached", "ai.provider_error", "ai.triage_run"]);
  });

  it("AC-T-2 (N-3): the message is deleted during an on-demand call, the account live: not_found, the call recorded, no triage row", async () => {
    const t = await thread([{ id: "p1", at: Date.now() - HOUR }]);
    const provider: TriageProvider = {
      id: "anthropic-haiku",
      triage: async () => {
        await database.delete(schema.mailMessages).where(eq(schema.mailMessages.id, t.rows[0]!.id));
        return okTriage();
      },
    };
    expect(await triageThreadNow({ db: database, provider, caps: BIG }, userId, t.thread.id)).toBe("not_found");
    const calls = await database.select().from(schema.aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: "triage", status: "ok", errorCode: null, accountId: acc.id, messageId: null, costUsdMicros: TRIAGE_COST });
    expect(await database.select().from(schema.mailTriage)).toEqual([]);
    expect(await aiAudits()).toEqual([{ action: "ai.triage_run", accountId: acc.id, detail: { triaged: 1, failed: 0, skipped_cap: 0, costUsdMicros: TRIAGE_COST } }]);
  });

  it("AC-T-3 (security N1): a candidate deleted before the skipped_cap write gets no row and isn't counted", async () => {
    const a = await thread([{ id: "a1", at: Date.now() - HOUR }]);
    await thread([{ id: "b1", at: Date.now() - 2 * HOUR }]);
    await thread([{ id: "c1", at: Date.now() - 3 * HOUR }]);
    // Seam: delete a1 right before the first transaction (the skipped_cap write; capped at i = 0).
    let first = true;
    const db = new Proxy(database, {
      get(target, p, r) {
        if (p === "transaction")
          return async (fn: never, cfg?: never) => {
            if (first) {
              first = false;
              await target.delete(schema.mailMessages).where(eq(schema.mailMessages.id, a.rows[0]!.id));
            }
            return target.transaction(fn, cfg);
          };
        return Reflect.get(target, p, r);
      },
    }) as Database;
    const provider: TriageProvider = { id: "anthropic-haiku", triage: async () => okTriage() };
    const r = await runTriageStage({ db, provider, caps: { ...BIG, triageCalls: 0 } }, acc);
    expect(first).toBe(false);
    expect(r).toMatchObject({ skippedCap: 2 });
    const rows = await database.select().from(schema.mailTriage);
    expect(rows.map((x) => x.status)).toEqual(["skipped_cap", "skipped_cap"]);
    expect(rows.some((x) => x.messageId === a.rows[0]!.id)).toBe(false);
  });

  it("AC-T-3 race: skipped_cap writes vs message deletes on a separate pool: no FK error, no deadlock", { timeout: 120_000 }, async () => {
    const errors: string[] = [];
    for (let round = 0; round < 20; round++) {
      await poolDb.delete(schema.mailMessages).where(eq(schema.mailMessages.accountId, acc.id));
      const ts = [];
      for (let i = 0; i < 4; i++) ts.push(await thread([{ id: `r${round}-${i}`, at: Date.now() - (i + 1) * HOUR }], poolDb));
      const victim = ts[round % 4]!.rows[0]!.id;
      const provider: TriageProvider = { id: "anthropic-haiku", triage: async () => okTriage() };
      const [stage, del] = await Promise.allSettled([
        runTriageStage({ db: poolDb, provider, caps: { ...BIG, triageCalls: 0 } }, acc),
        (async () => {
          await new Promise((r) => setTimeout(r, round % 5));
          await poolDb.delete(schema.mailMessages).where(eq(schema.mailMessages.id, victim));
        })(),
      ]);
      if (stage.status === "rejected") errors.push(`round ${round}: stage ${pgCode(stage.reason)}`);
      if (del.status === "rejected") errors.push(`round ${round}: delete ${pgCode(del.reason)}`);
      if (stage.status === "fulfilled") {
        const n = (await poolDb.select().from(schema.mailTriage)).length;
        if (stage.value.skippedCap > 4 || stage.value.skippedCap < 3) errors.push(`round ${round}: skippedCap ${stage.value.skippedCap}`);
        if (n > 4) errors.push(`round ${round}: ${n} rows`);
      }
    }
    expect(errors).toEqual([]);
  });
});
