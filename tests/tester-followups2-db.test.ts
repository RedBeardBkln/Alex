import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { appendFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ApprovalItem, ConnectedAccount } from "@/db/schema";
import { deleteAccount } from "@/lib/accounts";
import type { Caps } from "@/lib/ai-ledger/config";
import { emptyUsage } from "@/lib/ai-ledger/ledger";
import { costUsdMicros, DRAFT_RESERVED_COST_MICROS, TRIAGE_RESERVED_COST_MICROS } from "@/lib/ai-ledger/pricing";
import { draftReply } from "@/lib/ai/draft";
import { runTriageStage, triageThreadNow } from "@/lib/ai/triage";
import type { DraftOutcome, DraftProvider, TriageOutcome, TriageProvider } from "@/lib/ai/types";
import { approveItem, getItemView, getOwnItem, newerDigest, proposeReply } from "@/lib/approvals/service";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester, phase-2-followups-2 (Postgres only, disposable local database via TEST_DATABASE_URL).
// - O2 and its triage sibling under real races (separate postgres() pool, both sides staggered),
//   with a per-round ledger and audit tally: every provider call is recorded exactly once, at the
//   right cost, with null account ids once the account is gone; no throws, FK errors or deadlocks.
// - SF2 (option c) cases the coder's file doesn't cover.
// Set TESTER_SCRATCH=<file> to get the race tallies.

const HOST = "alex.example.com";
const MIN = 60_000;
const HOUR = 60 * MIN;
const BIG: Caps = { triageCalls: 4_000, triageMicros: 50_000_000, draftCalls: 1_000, draftMicros: 300_000_000, totalMicros: 350_000_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const note = (s: string) => {
  if (process.env.TESTER_SCRATCH) appendFileSync(process.env.TESTER_SCRATCH, `${s}\n`);
};
const pgCode = (err: unknown): string => {
  const e = err as { cause?: { code?: string }; code?: string };
  return e?.cause?.code ?? e?.code ?? (err instanceof Error ? err.name : "?");
};
const DRAFT_USAGE = { ...emptyUsage("anthropic-opus", "claude-opus-5-5", 5), inputTokens: 1_000, outputTokens: 100 };
const DRAFT_COST = costUsdMicros("claude-opus-5-5", DRAFT_USAGE)!;
const TRIAGE_USAGE = { ...emptyUsage("anthropic-haiku", "claude-haiku-5-5", 5), inputTokens: 800, outputTokens: 60 };
const TRIAGE_COST = costUsdMicros("claude-haiku-5-5", TRIAGE_USAGE)!;

describe.skipIf(!testDbUrl)("tester phase-2-followups-2 (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    pool = postgres(testDbUrl!, { max: 12, onnotice: () => {} });
    poolDb = drizzle(pool, { schema }) as unknown as Database;
  });
  afterAll(async () => {
    await pool.end();
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
  });

  async function thread(userId: string, acc: ConnectedAccount, messages: { id: string; at: number }[]) {
    const gt = `gt-${Math.random().toString(36).slice(2)}`;
    const [t] = await database
      .insert(schema.mailThreads)
      .values({ userId, accountId: acc.id, gmailThreadId: gt, subject: "Lunch", lastMessageAt: new Date(), messageCount: messages.length, inInbox: true, hasUnread: false })
      .returning();
    const rows = [];
    for (const m of messages) rows.push(await addMessage(userId, acc, t!.id, gt, m));
    return { thread: t!, gmailThreadId: gt, messages: rows };
  }
  async function addMessage(userId: string, acc: ConnectedAccount, threadId: string, gt: string, m: { id: string; at: number }) {
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
  const audits = async (userId: string) =>
    (await database.select().from(schema.auditLog).where(eq(schema.auditLog.userId, userId))).filter((a) => a.action.startsWith("ai."));

  // ---- O2: draft vs Disconnect, real race, per-round ledger tally -------------------------------

  it("O2 race: 36 staggered rounds (ok, timeout, definite error): every call recorded once at the right cost, audits consistent, no throw", { timeout: 180_000 }, async () => {
    const tally: Record<string, number> = {};
    const problems: string[] = [];
    for (let round = 0; round < 36; round++) {
      const user = await makeUser(database, `r${round}@example.com`);
      const acc = await makeGoogleAccount(database, user.id, { email: `a${round}@example.com` });
      const t = await thread(user.id, acc, [{ id: `p${round}`, at: Date.now() - HOUR }]);
      const kind = (["ok", "timeout", "api_400"] as const)[round % 3];
      let called = 0;
      const provider: DraftProvider = {
        id: "anthropic-opus",
        draft: async (): Promise<DraftOutcome> => {
          called++;
          await sleep(round % 5);
          if (kind === "ok") return { status: "ok", body: "Sounds good.", notes: "", errorCode: null, usage: DRAFT_USAGE };
          return { status: "error", body: null, notes: null, errorCode: kind, usage: emptyUsage("anthropic-opus", "claude-opus-5-5", 90_000) };
        },
      };
      const [d, del] = await Promise.all([
        (async () => {
          await sleep(round % 3);
          return draftReply({ db: poolDb, provider, caps: BIG }, { userId: user.id, threadId: t.thread.id, mode: "reply", instruction: null }).then(
            (r) => (r.ok ? "proposed" : r.code),
            (err: unknown) => `throws:${pgCode(err)}`,
          );
        })(),
        (async () => {
          await sleep((round % 12) * 10);
          return deleteAccount(poolDb, user.id, acc.id, { attempts: 1 }).then(
            () => "ok",
            (err: unknown) => `error:${pgCode(err)}`,
          );
        })(),
      ]);
      const key = `${kind}:${d}`;
      tally[key] = (tally[key] ?? 0) + 1;
      if (del !== "ok") problems.push(`r${round} disconnect ${del}`);
      if (!["proposed", "account_disconnected", "not_found", "error"].includes(d)) problems.push(`r${round} draft ${d}`);
      if (d === "proposed" && kind !== "ok") problems.push(`r${round} proposed on ${kind}`);
      if (d === "error" && kind === "ok") problems.push(`r${round} error on ok`);

      const calls = await database.select().from(schema.aiCalls).where(eq(schema.aiCalls.userId, user.id));
      const a = await audits(user.id);
      const closing = a.filter((x) => x.action === "ai.draft_failed" || x.action === "ai.draft_proposed");
      const requested = a.filter((x) => x.action === "ai.draft_requested");
      if (calls.length > 1) problems.push(`r${round} ${calls.length} ai_calls rows`);
      if (called > 0 && calls.length !== 1) problems.push(`r${round} provider called but ${calls.length} rows`);
      if (calls.some((c) => c.status === "pending")) problems.push(`r${round} pending row`);
      if (calls.some((c) => c.accountId !== null)) problems.push(`r${round} row keeps account id after the disconnect`);
      if (calls.length === 0) {
        if (a.length !== 0) problems.push(`r${round} audits without a row: ${a.map((x) => x.action)}`);
        if (d !== "account_disconnected" && d !== "not_found") problems.push(`r${round} no row but ${d}`);
      } else {
        const c = calls[0]!;
        if (requested.length !== 1) problems.push(`r${round} ${requested.length} draft_requested`);
        if (closing.length !== 1) problems.push(`r${round} ${closing.length} closing audits`);
        const cl = closing[0];
        if (called === 0) {
          // W1: gone before the model call.
          if (!(c.status === "error" && c.errorCode === "account_disconnected" && c.costUsdMicros === 0)) problems.push(`r${round} W1 row ${c.status}/${c.errorCode}/${c.costUsdMicros}`);
        } else if (kind === "ok") {
          if (c.status !== "ok" || c.costUsdMicros !== DRAFT_COST) problems.push(`r${round} ok row ${c.status}/${c.costUsdMicros}`);
          if (d === "proposed" && (c.errorCode !== null || cl?.action !== "ai.draft_proposed")) problems.push(`r${round} proposed but ${c.errorCode}/${cl?.action}`);
          if (d === "account_disconnected" && (c.errorCode !== "account_disconnected" || c.approvalItemId !== null)) problems.push(`r${round} gone-ok row ${c.errorCode}/${c.approvalItemId}`);
        } else {
          const want = kind === "timeout" ? DRAFT_RESERVED_COST_MICROS : 0;
          if (c.status !== "error" || c.errorCode !== kind || c.costUsdMicros !== want) problems.push(`r${round} error row ${c.status}/${c.errorCode}/${c.costUsdMicros}`);
          const pe = a.filter((x) => x.action === "ai.provider_error");
          if (pe.length !== 1) problems.push(`r${round} ${pe.length} provider_error audits`);
        }
        if (d === "account_disconnected" && !(cl?.action === "ai.draft_failed" && cl.accountId === null && (cl.detail as { code?: string }).code === "account_disconnected"))
          problems.push(`r${round} disconnected closing ${JSON.stringify(cl && { action: cl.action, accountId: cl.accountId, detail: cl.detail })}`);
        if (d === "error" && !(cl?.action === "ai.draft_failed" && (cl.detail as { code?: string }).code === kind)) problems.push(`r${round} error closing ${cl?.action}`);
      }
    }
    note(`O2 race tally ${JSON.stringify(tally)} problems=${JSON.stringify(problems)}`);
    expect(problems).toEqual([]);
    expect(await database.select().from(schema.approvalItems)).toEqual([]);
    // Both sides must have won sometimes, or the race tested nothing.
    expect(Object.keys(tally).some((k) => k.endsWith(":account_disconnected"))).toBe(true);
    expect(Object.keys(tally).some((k) => k.endsWith(":proposed") || k.endsWith(":error"))).toBe(true);
  });

  // ---- Triage sibling: on demand and ingest, real races -------------------------------------------

  const okTriage = (): TriageOutcome => ({ status: "ok", result: { category: "fyi", needsReply: false, summary: "A note." }, errorCode: null, usage: TRIAGE_USAGE });
  const timeoutTriage = (): TriageOutcome => ({ status: "error", result: null, errorCode: "timeout", usage: emptyUsage("anthropic-haiku", "claude-haiku-5-5", 30_000) });

  it("triage on demand vs Disconnect: 30 staggered rounds, every call recorded once, null ids when gone, no throw", { timeout: 180_000 }, async () => {
    const tally: Record<string, number> = {};
    const problems: string[] = [];
    for (let round = 0; round < 30; round++) {
      const user = await makeUser(database, `t${round}@example.com`);
      const acc = await makeGoogleAccount(database, user.id, { email: `b${round}@example.com` });
      const t = await thread(user.id, acc, [{ id: `q${round}`, at: Date.now() - HOUR }]);
      const fail = round % 3 === 2;
      let called = 0;
      const provider: TriageProvider = {
        id: "anthropic-haiku",
        triage: async () => {
          called++;
          await sleep(round % 4);
          return fail ? timeoutTriage() : okTriage();
        },
      };
      const [r, del] = await Promise.all([
        (async () => {
          await sleep(round % 3);
          return triageThreadNow({ db: poolDb, provider, caps: BIG }, user.id, t.thread.id).then(
            (x) => x as string,
            (err: unknown) => `throws:${pgCode(err)}`,
          );
        })(),
        (async () => {
          await sleep((round % 10) * 4);
          return deleteAccount(poolDb, user.id, acc.id, { attempts: 1 }).then(
            () => "ok",
            (err: unknown) => `error:${pgCode(err)}`,
          );
        })(),
      ]);
      tally[`${fail ? "timeout" : "ok"}:${r}`] = (tally[`${fail ? "timeout" : "ok"}:${r}`] ?? 0) + 1;
      if (del !== "ok") problems.push(`r${round} disconnect ${del}`);
      if (!["triaged", "failed", "account_disconnected", "not_found"].includes(r)) problems.push(`r${round} triage ${r}`);
      const calls = await database.select().from(schema.aiCalls).where(eq(schema.aiCalls.userId, user.id));
      if (calls.length !== called) problems.push(`r${round} provider calls ${called} but ${calls.length} rows`);
      const a = await audits(user.id);
      const runs = a.filter((x) => x.action === "ai.triage_run");
      if (runs.length !== called) problems.push(`r${round} ${runs.length} triage_run audits for ${called} calls`);
      for (const c of calls) {
        if (c.accountId !== null || c.messageId !== null) problems.push(`r${round} row keeps ids`);
        const cost = fail ? TRIAGE_RESERVED_COST_MICROS : TRIAGE_COST;
        if (c.costUsdMicros !== cost) problems.push(`r${round} cost ${c.costUsdMicros}`);
        if (fail && c.errorCode !== "timeout") problems.push(`r${round} failed call code ${c.errorCode}`);
        if (!fail && r === "account_disconnected" && c.errorCode !== "account_disconnected") problems.push(`r${round} gone-ok code ${c.errorCode}`);
        if (!fail && r === "triaged" && c.errorCode !== null) problems.push(`r${round} triaged code ${c.errorCode}`);
      }
      if (r === "account_disconnected" && runs[0]?.accountId !== null) problems.push(`r${round} triage_run keeps account id`);
    }
    note(`triage on-demand race tally ${JSON.stringify(tally)} problems=${JSON.stringify(problems)}`);
    expect(problems).toEqual([]);
    expect(await database.select().from(schema.mailTriage)).toEqual([]);
    expect(Object.keys(tally).some((k) => k.endsWith(":account_disconnected"))).toBe(true);
    expect(Object.keys(tally).some((k) => k.endsWith(":triaged") || k.endsWith(":failed"))).toBe(true);
  });

  it("ingest triage stage vs Disconnect: 24 staggered rounds of 4 messages: the stage resolves, records every call, stops after the disconnect", { timeout: 180_000 }, async () => {
    const tally: Record<string, number> = {};
    const problems: string[] = [];
    for (let round = 0; round < 24; round++) {
      const user = await makeUser(database, `s${round}@example.com`);
      const acc = await makeGoogleAccount(database, user.id, { email: `c${round}@example.com` });
      for (let k = 0; k < 4; k++) await thread(user.id, acc, [{ id: `s${round}-${k}`, at: Date.now() - (k + 1) * HOUR }]);
      let called = 0;
      let callsAfterGone = 0;
      let gone = false;
      const provider: TriageProvider = {
        id: "anthropic-haiku",
        triage: async () => {
          called++;
          if (gone) callsAfterGone++;
          await sleep(2 + (round % 3));
          return round % 4 === 3 ? timeoutTriage() : okTriage();
        },
      };
      const [r, del] = await Promise.all([
        runTriageStage({ db: poolDb, provider, caps: BIG }, acc).then(
          (x) => x,
          (err: unknown) => `throws:${pgCode(err)}`,
        ),
        (async () => {
          await sleep((round % 8) * 6);
          return deleteAccount(poolDb, user.id, acc.id, { attempts: 1 }).then(
            () => ((gone = true), "ok"),
            (err: unknown) => `error:${pgCode(err)}`,
          );
        })(),
      ]);
      if (del !== "ok") problems.push(`r${round} disconnect ${del}`);
      if (typeof r === "string") {
        problems.push(`r${round} stage ${r}`);
        continue;
      }
      tally[`calls=${called}`] = (tally[`calls=${called}`] ?? 0) + 1;
      const calls = await database.select().from(schema.aiCalls).where(eq(schema.aiCalls.userId, user.id));
      if (calls.length !== called) problems.push(`r${round} provider calls ${called} but ${calls.length} rows`);
      if (r.triaged + r.failed !== called) problems.push(`r${round} result ${r.triaged}+${r.failed} for ${called} calls`);
      if (calls.some((c) => c.accountId !== null)) problems.push(`r${round} row keeps account id`);
      const sum = calls.reduce((s, c) => s + (c.costUsdMicros ?? 0), 0);
      if (sum !== r.costUsdMicros) problems.push(`r${round} cost ${sum} vs result ${r.costUsdMicros}`);
      // At most the one call that was already in flight when the account went.
      if (callsAfterGone > 1) problems.push(`r${round} ${callsAfterGone} calls started after the disconnect`);
      const runs = (await audits(user.id)).filter((x) => x.action === "ai.triage_run");
      if (called > 0 && runs.length !== 1) problems.push(`r${round} ${runs.length} triage_run audits`);
    }
    note(`triage ingest race tally ${JSON.stringify(tally)} problems=${JSON.stringify(problems)}`);
    expect(problems).toEqual([]);
    expect(await database.select().from(schema.mailTriage)).toEqual([]);
    expect(Object.keys(tally).some((k) => k !== "calls=4" && k !== "calls=0")).toBe(true);
  });

  // ---- SF2 extra cases ----------------------------------------------------------------------------

  describe("SF2 (option c), extra cases", () => {
    let userId: string;
    let acc: ConnectedAccount;
    beforeEach(async () => {
      userId = (await makeUser(database)).id;
      acc = await makeGoogleAccount(database, userId, { email: "work@example.com" });
    });
    const reload = async (id: string) => (await getOwnItem(database, userId, id))!;
    const view = async (itemId: string) => (await getItemView(database, userId, itemId, { newRecipientLimit: 10 }))!;
    const approve = (item: ApprovalItem, over: Partial<Parameters<typeof approveItem>[1]>) =>
      approveItem(database, {
        userId,
        itemId: item.id,
        revision: item.revision,
        contentHash: item.contentHash,
        ackThreadChange: false,
        shownThreadChangedAt: item.threadChangedAt ? item.threadChangedAt.getTime() : null,
        messageIdHost: HOST,
        confirmedRecipients: [],
        newRecipientLimit: 10,
        ...over,
      });
    const reply = async (threadId: string, parentId: string) =>
      (await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Sounds good", includeQuote: false })) as { ok: true; itemId: string };

    it("a page rendered before the deploy (no shownNewer, so the action sends \"\") with a flagged item and the tick: ack_required once, then approved with the digest", async () => {
      const t = await thread(userId, acc, [{ id: "p1", at: Date.now() - HOUR }]);
      const r = await reply(t.thread.id, t.messages[0]!.id);
      const m = await addMessage(userId, acc, t.thread.id, t.gmailThreadId, { id: "m2", at: Date.now() - MIN });
      // Flag it as the hook would.
      await database.update(schema.approvalItems).set({ threadChangedAt: new Date() }).where(eq(schema.approvalItems.id, r.itemId));
      const item = await reload(r.itemId);
      expect(await approve(item, { ackThreadChange: true, shownNewer: "" })).toEqual({ kind: "blocked", reason: "ack_required" });
      const v = await view(r.itemId);
      expect(v.newerDigest).toBe(newerDigest([m.id]));
      expect(await approve(item, { ackThreadChange: true, shownNewer: v.newerDigest })).toEqual({ kind: "approved" });
    });

    it("the right digest without the tick, and the tick with the stale flag value, are both refused (the checks are independent)", async () => {
      const t = await thread(userId, acc, [{ id: "p1", at: Date.now() - HOUR }]);
      const r = await reply(t.thread.id, t.messages[0]!.id);
      await addMessage(userId, acc, t.thread.id, t.gmailThreadId, { id: "m2", at: Date.now() - MIN });
      const v = await view(r.itemId);
      expect(v.newerCount).toBe(1);
      expect(await approve(v.item, { ackThreadChange: false, shownNewer: v.newerDigest })).toEqual({ kind: "blocked", reason: "ack_required" });
      await database.update(schema.approvalItems).set({ threadChangedAt: new Date() }).where(eq(schema.approvalItems.id, r.itemId));
      // The page's shownThreadChangedAt (null) no longer matches the stored flag.
      expect(await approve(v.item, { ackThreadChange: true, shownNewer: v.newerDigest, shownThreadChangedAt: null })).toEqual({ kind: "blocked", reason: "ack_required" });
    });

    it("a newer message deleted after the page rendered changes the digest: refused, then the re-rendered page approves without a tick", async () => {
      const t = await thread(userId, acc, [{ id: "p1", at: Date.now() - HOUR }]);
      const r = await reply(t.thread.id, t.messages[0]!.id);
      const m = await addMessage(userId, acc, t.thread.id, t.gmailThreadId, { id: "m2", at: Date.now() - MIN });
      const v = await view(r.itemId);
      await database.delete(schema.mailMessages).where(eq(schema.mailMessages.id, m.id));
      expect(await approve(v.item, { ackThreadChange: true, shownNewer: v.newerDigest })).toEqual({ kind: "blocked", reason: "ack_required" });
      const again = await view(r.itemId);
      expect([again.newerCount, again.newerDigest]).toEqual([0, ""]);
      expect(await approve(again.item, { shownNewer: "" })).toEqual({ kind: "approved" });
    });

    it("a second newer message after the page rendered (digest of one) is refused even with the tick", async () => {
      const t = await thread(userId, acc, [{ id: "p1", at: Date.now() - HOUR }]);
      const r = await reply(t.thread.id, t.messages[0]!.id);
      await addMessage(userId, acc, t.thread.id, t.gmailThreadId, { id: "m2", at: Date.now() - 2 * MIN });
      const v = await view(r.itemId);
      await addMessage(userId, acc, t.thread.id, t.gmailThreadId, { id: "m3", at: Date.now() - MIN });
      expect(await approve(v.item, { ackThreadChange: true, shownNewer: v.newerDigest })).toEqual({ kind: "blocked", reason: "ack_required" });
    });

    it("a message in another thread, or another user's thread, doesn't change the digest", async () => {
      const t = await thread(userId, acc, [{ id: "p1", at: Date.now() - HOUR }]);
      const other = await thread(userId, acc, [{ id: "o1", at: Date.now() - HOUR }]);
      const r = await reply(t.thread.id, t.messages[0]!.id);
      await addMessage(userId, acc, other.thread.id, other.gmailThreadId, { id: "o2", at: Date.now() - MIN });
      const v = await view(r.itemId);
      expect([v.newerCount, v.newerDigest]).toEqual([0, ""]);
      expect(await approve(v.item, { shownNewer: "" })).toEqual({ kind: "approved" });
    });

    it("the digest check runs after the account lock: a disconnected account answers stale, not ack_required", async () => {
      const t = await thread(userId, acc, [{ id: "p1", at: Date.now() - HOUR }]);
      const r = await reply(t.thread.id, t.messages[0]!.id);
      const item = await reload(r.itemId);
      await deleteAccount(database, userId, acc.id);
      const out = await approve(item, { shownNewer: "" });
      expect(out.kind === "stale" || (out.kind === "blocked" && out.reason !== "ack_required")).toBe(true);
      expect(await database.select().from(schema.approvalItems).where(and(eq(schema.approvalItems.userId, userId)))).toEqual([]);
    });
  });
});
