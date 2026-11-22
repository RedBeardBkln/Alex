import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { deleteAccount } from "@/lib/accounts";
import type { Caps } from "@/lib/ai-ledger/config";
import { emptyUsage } from "@/lib/ai-ledger/ledger";
import { runTriageStage, triageThreadNow } from "@/lib/ai/triage";
import type { TriageOutcome, TriageProvider } from "@/lib/ai/types";
import { approveAndSend as realApproveAndSend } from "@/lib/approvals/execute";
import { getOwnItem, HAYSTACK_CAP, HAYSTACK_FIELD_CAP, proposeReply, threadContext } from "@/lib/approvals/service";
import { sliceOnCodePoint } from "@/lib/approvals/text";
import { cutAtTokenBoundary, hostsIn, linksNotInThread } from "@/lib/approvals/warnings";
import { deleteStoredMessage } from "@/lib/gmail/store";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester, phase-2-followups-3 (Postgres only; TEST_DATABASE_URL must be a disposable local database).
// - S3: the bounded haystack at its exact edges (exactly at the caps, one unit over, many messages just
//   under the caps, a known host split by the cross-message cut, surrogates and 3-byte characters at
//   the cut, octet_length over-reservation, the 1,000-message query chunk boundary, rows changed or
//   deleted between query A and query B). The expected haystack is rebuilt independently.
// - S1: the real approveAndSend with an untyped undefined shownNewer fails closed and sends nothing.
// - Triage: skipped_cap vs a real message delete and vs Disconnect, and triageThreadNow vs a real
//   message delete, on a separate pool, staggered, with both outcomes tallied.

const HOUR = 3_600_000;
const BIG: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 100, draftMicros: 30_000_000, totalMicros: 35_000_000 };
const TRIAGE_USAGE = { ...emptyUsage("anthropic-haiku", "claude-haiku-5-5", 5), inputTokens: 800, outputTokens: 60 };
const FROM = "Alice <alice@example.org>";
const TO = "work@example.com";
const SUBJECT = "Lunch";
const cp = (n: number) => String.fromCodePoint(n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pgCode = (err: unknown): string => {
  const e = err as { cause?: { code?: string }; code?: string };
  return e?.cause?.code ?? e?.code ?? (err instanceof Error ? err.message.slice(0, 60) : "?");
};
/** Exactly n characters of short words. */
const words = (n: number) => ("w ".repeat(Math.ceil(n / 2))).slice(0, n);
/** n characters: a host link first, then short words. */
const withHost = (host: string, n: number) => {
  const head = `see https://${host}/x `;
  return head + words(n - head.length);
};

describe.skipIf(!testDbUrl)("tester phase-2-followups-3 (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;
  let userId: string;
  let acc: ConnectedAccount;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    pool = postgres(testDbUrl!, { max: 8, onnotice: () => {} });
    poolDb = drizzle(pool, { schema }) as unknown as Database;
  });
  afterAll(async () => {
    await pool.end();
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    acc = await makeGoogleAccount(database, userId, { email: TO });
  });

  type Msg = { id: string; at: number; bodyText?: string | null; renderedText?: string | null; renderedHtml?: string | null };
  async function newThread(ex: Database = database) {
    const gt = `gt-${Math.random().toString(36).slice(2)}`;
    const [t] = await ex
      .insert(schema.mailThreads)
      .values({ userId, accountId: acc.id, gmailThreadId: gt, subject: SUBJECT, lastMessageAt: new Date(), messageCount: 1, inInbox: true, hasUnread: false })
      .returning();
    return { id: t!.id, gt };
  }
  const row = (t: { id: string; gt: string }, m: Msg) => ({
    userId,
    accountId: acc.id,
    threadId: t.id,
    gmailMessageId: m.id,
    gmailThreadId: t.gt,
    internalDate: new Date(m.at),
    labelIds: ["INBOX"],
    isSent: false,
    subject: SUBJECT,
    fromHeader: FROM,
    toHeader: TO,
    rfc822MessageId: `<${m.id}@mail.example.org>`,
    headers: [],
    bodyText: m.bodyText === undefined ? "Hello" : m.bodyText,
    renderedText: m.renderedText ?? null,
    renderedHtml: m.renderedHtml ?? null,
  });
  async function thread(messages: Msg[], ex: Database = database) {
    const t = await newThread(ex);
    const rows = [];
    for (const m of messages) rows.push((await ex.insert(schema.mailMessages).values(row(t, m)).returning())[0]!);
    return { thread: t, rows };
  }

  /**
   * An independent model of the S3 plan (owner Q3): newest first, per message body, rendered text,
   * rendered HTML; each field's budget is min(FIELD_CAP, remaining), and the reservation is
   * min(budget, UTF-8 size). A cut is sliceOnCodePoint then cutAtTokenBoundary. Headers in full.
   */
  function model(messages: Msg[]) {
    const sorted = [...messages].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
    let remaining = HAYSTACK_CAP;
    let truncated = false;
    const parts: string[] = [];
    let bodyUnits = 0;
    for (const m of sorted) {
      parts.push(FROM, TO, SUBJECT);
      const fields = [m.bodyText === undefined ? "Hello" : m.bodyText, m.renderedText ?? null, m.renderedHtml ?? null];
      for (const f of fields) {
        if (!f) continue;
        if (remaining <= 0) {
          truncated = true;
          continue;
        }
        const budget = Math.min(HAYSTACK_FIELD_CAP, remaining);
        remaining -= Math.min(budget, Buffer.byteLength(f, "utf8"));
        let text = f;
        if (text.length > budget) {
          text = cutAtTokenBoundary(sliceOnCodePoint(text, budget));
          truncated = true;
        }
        if (text) {
          parts.push(text);
          bodyUnits += text.length;
        }
      }
    }
    return { haystack: parts.join(" "), truncated, bodyUnits };
  }

  // ---- S3 edges --------------------------------------------------------------------------------

  it("exactly at the caps: 8 fields of exactly FIELD_CAP fill HAYSTACK_CAP and nothing is truncated; an empty older field changes nothing; one more character does", { timeout: 120_000 }, async () => {
    expect(8 * HAYSTACK_FIELD_CAP).toBe(HAYSTACK_CAP);
    const msgs: Msg[] = Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, at: Date.now() - (i + 1) * HOUR, bodyText: withHost(`h${i}.test`, HAYSTACK_FIELD_CAP) }));
    const t = await thread(msgs);
    let ctx = await threadContext(database, userId, t.thread.id);
    expect(ctx.truncated).toBe(false);
    expect(ctx.haystack === model(msgs).haystack).toBe(true);
    for (let i = 0; i < 8; i++) expect(hostsIn(ctx.haystack).has(`h${i}.test`)).toBe(true);

    const older1: Msg = { id: "o1", at: Date.now() - 20 * HOUR, bodyText: "", renderedText: null };
    await database.insert(schema.mailMessages).values(row(t.thread, older1));
    ctx = await threadContext(database, userId, t.thread.id);
    expect(ctx.truncated).toBe(false);

    const older2: Msg = { id: "o2", at: Date.now() - 21 * HOUR, bodyText: "x" };
    await database.insert(schema.mailMessages).values(row(t.thread, older2));
    ctx = await threadContext(database, userId, t.thread.id);
    expect(ctx.truncated).toBe(true);
    expect(ctx.haystack === model([...msgs, older1, older2]).haystack).toBe(true);
  });

  it("one unit over the field cap is a cut (truncated), even when only a trailing character is dropped", async () => {
    const body = words(HAYSTACK_FIELD_CAP) + "x"; // the cut lands right after a space
    expect(body[HAYSTACK_FIELD_CAP - 1]).toBe(" ");
    const t = await thread([{ id: "a", at: Date.now(), bodyText: body }]);
    const ctx = await threadContext(database, userId, t.thread.id);
    expect(ctx.truncated).toBe(true);
    expect(ctx.haystack === model([{ id: "a", at: 0, bodyText: body }]).haystack).toBe(true);
  });

  it("nine messages just under the field cap: the total cap cuts the oldest at 80 units, on a token boundary, and a known host split there is not known", { timeout: 120_000 }, async () => {
    const n = HAYSTACK_FIELD_CAP - 10;
    const msgs: Msg[] = Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, at: Date.now() - (i + 1) * HOUR, bodyText: withHost(`h${i}.test`, n) }));
    const left = HAYSTACK_CAP - 8 * n;
    expect(left).toBe(80);
    // The oldest message: "https://bank.co" ends exactly at unit 80, so the raw cut would leave "bank.co".
    const pad = words(left - "https://bank.co".length);
    const oldest: Msg = { id: "u8", at: Date.now() - 30 * HOUR, bodyText: `${pad}https://bank.com/login and later.test ${words(1000)}` };
    expect(oldest.bodyText!.slice(0, left).endsWith("https://bank.co")).toBe(true);
    const all = [...msgs, oldest];
    const t = await thread(all);
    const ctx = await threadContext(database, userId, t.thread.id);
    const want = model(all);
    expect(ctx.truncated).toBe(true);
    expect(ctx.haystack === want.haystack).toBe(true);
    expect(want.bodyUnits).toBeLessThanOrEqual(HAYSTACK_CAP);
    const known = hostsIn(ctx.haystack);
    expect(known.has("bank.co")).toBe(false);
    expect(known.has("bank.com")).toBe(false);
    expect(known.has("later.test")).toBe(false);
    expect(linksNotInThread("Log in at https://bank.co/login or bank.co", ctx.haystack)).toEqual(["https://bank.co/login", "bank.co"]);
    expect(linksNotInThread("see https://h7.test/x", ctx.haystack)).toEqual([]);
  });

  it("the cut splits fields inside one message: body fills the rest, rendered text gets the remainder, rendered HTML is left out", { timeout: 120_000 }, async () => {
    const n = HAYSTACK_FIELD_CAP;
    const msgs: Msg[] = Array.from({ length: 7 }, (_, i) => ({ id: `f${i}`, at: Date.now() - (i + 1) * HOUR, bodyText: withHost(`h${i}.test`, n) }));
    const last: Msg = { id: "f7", at: Date.now() - 20 * HOUR, bodyText: withHost("body7.test", n - 30), renderedText: `rt https://rt7.test/ ${words(100)}`, renderedHtml: `<a href="https://html7.test/">x</a>` };
    const all = [...msgs, last];
    const t = await thread(all);
    const ctx = await threadContext(database, userId, t.thread.id);
    expect(ctx.truncated).toBe(true);
    expect(ctx.haystack === model(all).haystack).toBe(true);
    const known = hostsIn(ctx.haystack);
    expect(known.has("body7.test")).toBe(true);
    // 30 units are left for rendered text: "rt https://rt7.test/ " (21) fits whole, the rest is cut.
    expect(known.has("rt7.test")).toBe(true);
    expect(ctx.haystack.includes(`rt https://rt7.test/ ${words(100)}`)).toBe(false);
    expect(known.has("html7.test")).toBe(false);
  });

  it("surrogates and 3-byte characters at the cut: well-formed, within the field cap, cut on a token boundary", async () => {
    const cases: string[] = [
      words(HAYSTACK_FIELD_CAP - 1) + cp(0x1f600) + " tail.test", // the pair straddles the cut
      cp(0x1f600).repeat(200_000), // no token break at all: the whole field is dropped
      ("中文 " + cp(0x20000) + " ").repeat(60_000), // 3- and 4-byte characters
      ("é".repeat(9) + " ").repeat(30_000),
    ];
    for (const [i, body] of cases.entries()) {
      await database.delete(schema.mailThreads);
      const t = await thread([{ id: `s${i}`, at: Date.now(), bodyText: body }]);
      const ctx = await threadContext(database, userId, t.thread.id);
      const want = model([{ id: `s${i}`, at: 0, bodyText: body }]);
      expect(ctx.truncated, `case ${i}`).toBe(true);
      expect(ctx.haystack === want.haystack, `case ${i}`).toBe(true);
      expect(ctx.haystack.isWellFormed(), `case ${i}`).toBe(true);
      expect(want.bodyUnits, `case ${i}`).toBeLessThanOrEqual(HAYSTACK_FIELD_CAP);
      expect(hostsIn(ctx.haystack).has("tail.test"), `case ${i}`).toBe(false);
    }
  });

  it("octet_length over-reserves for non-ASCII text: 8 fields of 200K units (300 KB) use the whole budget, so a 9th small message is left out and the note shows (fails toward warning)", { timeout: 120_000 }, async () => {
    const body = (i: number) => `see https://n${i}.test/ ` + "é ".repeat(100_000);
    const msgs: Msg[] = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, at: Date.now() - (i + 1) * HOUR, bodyText: body(i) }));
    const ninth: Msg = { id: "n8", at: Date.now() - 30 * HOUR, bodyText: "hello https://ninth.test/" };
    const t = await thread([...msgs, ninth]);
    const ctx = await threadContext(database, userId, t.thread.id);
    const want = model([...msgs, ninth]);
    expect(ctx.haystack === want.haystack).toBe(true);
    expect(ctx.truncated).toBe(true);
    expect(want.bodyUnits).toBeLessThan(HAYSTACK_CAP * 0.8); // the units actually checked
    expect(hostsIn(ctx.haystack).has("ninth.test")).toBe(false);
  });

  it("query B chunking: 2,100 small messages (3 statements) give the full haystack and no truncation", { timeout: 120_000 }, async () => {
    const t = await newThread();
    const msgs: Msg[] = Array.from({ length: 2100 }, (_, i) => ({ id: `c${i}`, at: Date.now() - (i + 1) * 1000, bodyText: `msg https://c${i}.test/`, renderedText: i % 3 === 0 ? `rt r${i}.test` : null }));
    for (let i = 0; i < msgs.length; i += 300) await database.insert(schema.mailMessages).values(msgs.slice(i, i + 300).map((m) => row(t, m)));
    const ctx = await threadContext(database, userId, t.id);
    expect(ctx.truncated).toBe(false);
    expect(ctx.haystack === model(msgs).haystack).toBe(true);
    const known = hostsIn(ctx.haystack);
    for (const i of [0, 999, 1000, 1001, 1999, 2000, 2099]) expect(known.has(`c${i}.test`), `c${i}`).toBe(true);
    expect(known.has("r999.test") && known.has("r2097.test")).toBe(true);
  });

  it("rows changed between query A and query B: a body that grew is cut to its planned budget (truncated); a deleted message is just missing", async () => {
    const t = await thread([
      { id: "g1", at: Date.now() - HOUR, bodyText: "small https://grow.test/" },
      { id: "g2", at: Date.now() - 2 * HOUR, bodyText: "gone https://gone.test/" },
    ]);
    let fired = false;
    const seam = new Proxy(database, {
      get(target, p, r) {
        if (p === "execute")
          return async (q: never) => {
            if (!fired) {
              fired = true;
              await target.update(schema.mailMessages).set({ bodyText: "small https://grow.test/ " + words(HAYSTACK_FIELD_CAP * 2) + " https://late.test/" }).where(eq(schema.mailMessages.id, t.rows[0]!.id));
              await target.delete(schema.mailMessages).where(eq(schema.mailMessages.id, t.rows[1]!.id));
            }
            return target.execute(q);
          };
        return Reflect.get(target, p, r);
      },
    }) as Database;
    const ctx = await threadContext(seam, userId, t.thread.id);
    expect(fired).toBe(true);
    // g1 was planned at min(FIELD_CAP, cap) = FIELD_CAP units (its size was small, but the budget is the cap).
    expect(ctx.truncated).toBe(true);
    const known = hostsIn(ctx.haystack);
    expect(known.has("grow.test")).toBe(true);
    expect(known.has("late.test")).toBe(false);
    expect(known.has("gone.test")).toBe(false);
    expect(ctx.haystack.length).toBeLessThanOrEqual(HAYSTACK_FIELD_CAP + 200);
  });

  it("another user's message with the same thread id is never read (query A and B filter by user)", async () => {
    const t = await thread([{ id: "mine", at: Date.now(), bodyText: "mine https://mine.test/" }]);
    const other = (await makeUser(database, "other@example.com")).id;
    const otherAcc = await makeGoogleAccount(database, other, { email: "other-work@example.com" });
    await database.insert(schema.mailMessages).values({ ...row(t.thread, { id: "theirs", at: Date.now() + HOUR, bodyText: "theirs https://theirs.test/" }), userId: other, accountId: otherAcc.id });
    const ctx = await threadContext(database, userId, t.thread.id);
    expect(hostsIn(ctx.haystack).has("theirs.test")).toBe(false);
    expect(hostsIn(ctx.haystack).has("mine.test")).toBe(true);
  });

  // ---- S1 ----------------------------------------------------------------------------------------

  it("S1: the real approveAndSend with an untyped undefined shownNewer is ack_required and sends nothing", async () => {
    const t = await thread([{ id: "p1", at: Date.now() - HOUR }]);
    const r = await proposeReply(database, { userId, threadId: t.thread.id, parentMessageId: t.rows[0]!.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Sounds good", includeQuote: false });
    const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    let sends = 0;
    const untyped = realApproveAndSend as (d: unknown, i: unknown) => ReturnType<typeof realApproveAndSend>;
    const base = { userId, itemId: item.id, revision: item.revision, contentHash: item.contentHash, ackThreadChange: true, shownThreadChangedAt: null, messageIdHost: "alex.example.com", confirmedRecipients: [], newRecipientLimit: 10 };
    const deps = { db: database, send: async () => { sends++; throw new Error("must not send"); } };
    expect(await untyped(deps, { ...base, shownNewer: undefined })).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
    expect(await untyped(deps, base)).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
    expect(await untyped(deps, { ...base, shownNewer: null })).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
    expect(sends).toBe(0);
    expect((await getOwnItem(database, userId, item.id))!.status).toBe("pending");
  });

  // ---- Triage races ---------------------------------------------------------------------------------

  const okTriage = (): TriageOutcome => ({ status: "ok", result: { category: "fyi", needsReply: false, summary: "A note." }, errorCode: null, usage: TRIAGE_USAGE });

  it("skipped_cap vs a real deleteStoredMessage, staggered: no error, rows = skippedCap, both orders seen", { timeout: 180_000 }, async () => {
    const errors: string[] = [];
    const tally = { lockedFirst: 0, deleteFirst: 0 };
    for (let round = 0; round < 40; round++) {
      await poolDb.delete(schema.mailThreads).where(eq(schema.mailThreads.accountId, acc.id));
      const ts = [];
      for (let i = 0; i < 4; i++) ts.push(await thread([{ id: `d${round}-${i}`, at: Date.now() - (i + 1) * HOUR }], poolDb));
      const victim = ts[round % 4]!.rows[0]!;
      const provider: TriageProvider = { id: "anthropic-haiku", triage: async () => okTriage() };
      const [stage, del] = await Promise.allSettled([
        (async () => {
          if (round % 2) await sleep(round % 7);
          return runTriageStage({ db: poolDb, provider, caps: { ...BIG, triageCalls: 0 } }, acc);
        })(),
        (async () => {
          await sleep((round % 12) * 1.5);
          return deleteStoredMessage(poolDb, acc.id, victim.gmailMessageId);
        })(),
      ]);
      if (stage.status === "rejected") errors.push(`round ${round}: stage ${pgCode(stage.reason)}`);
      if (del.status === "rejected") errors.push(`round ${round}: delete ${pgCode(del.reason)}`);
      if (stage.status === "fulfilled") {
        const n = (await poolDb.select().from(schema.mailTriage)).length;
        if (n !== 3) errors.push(`round ${round}: ${n} rows after both`);
        if (stage.value.skippedCap === 4) tally.lockedFirst++;
        else if (stage.value.skippedCap === 3) tally.deleteFirst++;
        else errors.push(`round ${round}: skippedCap ${stage.value.skippedCap}`);
      }
    }
    if (process.env.TESTER_SCRATCH) (await import("node:fs")).appendFileSync(process.env.TESTER_SCRATCH, `skipped_cap vs delete: ${JSON.stringify(tally)} errors=${errors.length}\n`);
    expect(errors).toEqual([]);
    expect(tally.lockedFirst + tally.deleteFirst).toBe(40);
  });

  it("skipped_cap vs Disconnect, staggered: no 23503 or 40P01, and nothing of the account is left", { timeout: 180_000 }, async () => {
    const errors: string[] = [];
    const tally = { written: 0, zero: 0, fk: 0, deadlock: 0 };
    for (let round = 0; round < 30; round++) {
      await database.delete(schema.users);
      userId = (await makeUser(database)).id;
      acc = await makeGoogleAccount(database, userId, { email: TO });
      for (let i = 0; i < 4; i++) await thread([{ id: `x${round}-${i}`, at: Date.now() - (i + 1) * HOUR }], poolDb);
      const provider: TriageProvider = { id: "anthropic-haiku", triage: async () => okTriage() };
      const a = acc;
      const [stage, disc] = await Promise.allSettled([
        runTriageStage({ db: poolDb, provider, caps: { ...BIG, triageCalls: 0 } }, a),
        (async () => {
          await sleep((round % 10) * 2);
          await deleteAccount(poolDb, userId, a.id, { attempts: 1 });
        })(),
      ]);
      for (const [side, s] of [["stage", stage], ["disconnect", disc]] as const) {
        if (s.status === "rejected") {
          const c = pgCode(s.reason);
          if (c === "23503") tally.fk++;
          else if (c === "40P01") tally.deadlock++;
          errors.push(`round ${round}: ${side} ${c}`);
        }
      }
      if (stage.status === "fulfilled") {
        if (stage.value.skippedCap === 4) tally.written++;
        else if (stage.value.skippedCap === 0) tally.zero++;
        else errors.push(`round ${round}: skippedCap ${stage.value.skippedCap}`);
      }
      const left = (await poolDb.select().from(schema.mailTriage)).length + (await poolDb.select().from(schema.mailMessages).where(eq(schema.mailMessages.accountId, a.id))).length;
      if (left !== 0) errors.push(`round ${round}: ${left} rows left`);
    }
    if (process.env.TESTER_SCRATCH) (await import("node:fs")).appendFileSync(process.env.TESTER_SCRATCH, `skipped_cap vs disconnect: ${JSON.stringify(tally)} errors=${JSON.stringify(errors)}\n`);
    expect(errors).toEqual([]);
  });

  it("triageThreadNow vs a real deleteStoredMessage, staggered around the write: triaged or not_found, never an error; not_found means no triage row and a null message id", { timeout: 180_000 }, async () => {
    const errors: string[] = [];
    const tally: Record<string, number> = {};
    for (let round = 0; round < 30; round++) {
      await poolDb.delete(schema.aiCalls);
      await poolDb.delete(schema.auditLog);
      await poolDb.delete(schema.mailThreads).where(eq(schema.mailThreads.accountId, acc.id));
      const t = await thread([{ id: `t${round}`, at: Date.now() - HOUR }], poolDb);
      let release!: () => void;
      const called = new Promise<void>((r) => (release = r));
      const provider: TriageProvider = {
        id: "anthropic-haiku",
        triage: async () => {
          release();
          await sleep(5);
          return okTriage();
        },
      };
      const [res, del] = await Promise.allSettled([
        triageThreadNow({ db: poolDb, provider, caps: BIG }, userId, t.thread.id),
        (async () => {
          await called;
          await sleep(round % 12);
          return deleteStoredMessage(poolDb, acc.id, t.rows[0]!.gmailMessageId);
        })(),
      ]);
      if (res.status === "rejected") errors.push(`round ${round}: triage ${pgCode(res.reason)}`);
      if (del.status === "rejected") errors.push(`round ${round}: delete ${pgCode(del.reason)}`);
      if (res.status === "fulfilled") {
        tally[res.value] = (tally[res.value] ?? 0) + 1;
        const calls = await poolDb.select().from(schema.aiCalls);
        const runs = (await poolDb.select().from(schema.auditLog)).filter((a) => a.action === "ai.triage_run");
        if (calls.length !== 1 || runs.length !== 1) errors.push(`round ${round}: ${calls.length} calls, ${runs.length} runs`);
        if (!["triaged", "not_found"].includes(res.value)) errors.push(`round ${round}: ${res.value}`);
        if (calls[0]?.messageId !== null) errors.push(`round ${round}: message id kept after delete`);
        if ((await poolDb.select().from(schema.mailTriage)).length !== 0) errors.push(`round ${round}: triage row left`);
      }
    }
    if (process.env.TESTER_SCRATCH) (await import("node:fs")).appendFileSync(process.env.TESTER_SCRATCH, `triageThreadNow vs delete: ${JSON.stringify(tally)}\n`);
    expect(errors).toEqual([]);
    expect(Object.keys(tally).length).toBeGreaterThan(0);
  });

  it("triageThreadNow when Disconnect happens during the call is account_disconnected (checked before not_found)", async () => {
    const t = await thread([{ id: "q1", at: Date.now() - HOUR }]);
    const provider: TriageProvider = {
      id: "anthropic-haiku",
      triage: async () => {
        await deleteAccount(database, userId, acc.id, { attempts: 1 });
        return okTriage();
      },
    };
    expect(await triageThreadNow({ db: database, provider, caps: BIG }, userId, t.thread.id)).toBe("account_disconnected");
    const calls = await database.select().from(schema.aiCalls).orderBy(desc(schema.aiCalls.createdAt));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ accountId: null, messageId: null });
  });
});
