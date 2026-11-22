import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
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
import { approveItem, getItemView, getOwnItem, newerDigest, newerMessageIds, proposeNewMessage, proposeReply } from "@/lib/approvals/service";
import { parseMessage } from "@/lib/gmail/mime";
import { storeMessage, type StoreMessageInput } from "@/lib/gmail/store";
import { toFull } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// phase-2-followups-2 (coder), Postgres only (TEST_DATABASE_URL, a disposable local database):
// - O2: draftReply with the account disconnected in each window (W1–W4), and a staggered race.
// - O2 triage sibling (owner Q10 amendment): on-demand and ingest-stage triage across a disconnect.
// - SF2 (owner Q1 option c): approve is bound to the newer-message set the page showed.
// Window seams: W1 and W4 delete the account right before the Nth `.transaction` call of draftReply
// (a Proxy on the executor); W2 and W3 delete it inside the provider stub.

const HOST = "alex.example.com";
const MIN = 60_000;
const HOUR = 60 * MIN;
const BIG: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 100, draftMicros: 30_000_000, totalMicros: 35_000_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pgCode = (err: unknown): string => {
  const e = err as { cause?: { code?: string }; code?: string };
  return e?.cause?.code ?? e?.code ?? (err instanceof Error ? err.name : "?");
};
const DRAFT_USAGE = { ...emptyUsage("anthropic-opus", "claude-opus-5-5", 5), inputTokens: 1_000, outputTokens: 100 };
const DRAFT_COST = costUsdMicros("claude-opus-5-5", DRAFT_USAGE)!;
const TRIAGE_USAGE = { ...emptyUsage("anthropic-haiku", "claude-haiku-5-5", 5), inputTokens: 800, outputTokens: 60 };
const TRIAGE_COST = costUsdMicros("claude-haiku-5-5", TRIAGE_USAGE)!;

describe.skipIf(!testDbUrl)("phase-2-followups-2 (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;
  let userId: string;
  let accountA: ConnectedAccount;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    pool = postgres(testDbUrl!, { max: 6, onnotice: () => {} });
    poolDb = drizzle(pool, { schema }) as unknown as Database;
  });
  afterAll(async () => {
    await pool.end();
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    accountA = await makeGoogleAccount(database, userId, { email: "work@example.com" });
  });

  const reload = async (id: string) => (await getOwnItem(database, userId, id))!;
  async function thread(acc: ConnectedAccount, messages: { id: string; at: number; labels?: string[]; sent?: boolean; rfc822?: string }[]) {
    const gt = `gt-${Math.random().toString(36).slice(2)}`;
    const [t] = await database
      .insert(schema.mailThreads)
      .values({ userId, accountId: acc.id, gmailThreadId: gt, subject: "Lunch", lastMessageAt: new Date(), messageCount: messages.length, inInbox: true, hasUnread: false })
      .returning();
    const rows = [];
    for (const m of messages) rows.push(await addMessage(acc, t!.id, gt, m));
    return { thread: t!, gmailThreadId: gt, messages: rows };
  }
  async function addMessage(acc: ConnectedAccount, threadId: string, gt: string, m: { id: string; at: number; labels?: string[]; sent?: boolean; rfc822?: string }) {
    const [row] = await database
      .insert(schema.mailMessages)
      .values({
        userId,
        accountId: acc.id,
        threadId,
        gmailMessageId: m.id,
        gmailThreadId: gt,
        internalDate: new Date(m.at),
        labelIds: m.labels ?? (m.sent ? ["SENT"] : ["INBOX"]),
        isSent: m.sent ?? false,
        subject: "Lunch",
        fromHeader: m.sent ? acc.email : "Alice <alice@example.org>",
        toHeader: m.sent ? "alice@example.org" : acc.email,
        rfc822MessageId: m.rfc822 ?? `<${m.id}@mail.example.org>`,
        headers: [],
        bodyText: "Hello",
      })
      .returning();
    return row!;
  }
  const replyInput = (threadId: string, parentMessageId: string) => ({ userId, threadId, parentMessageId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Sounds good", includeQuote: false });
  const storeInput = (acc: ConnectedAccount, id: string, gmailThreadId: string, at: number): StoreMessageInput => {
    const full = toFull({ id, threadId: gmailThreadId, labelIds: ["INBOX"], internalDate: at, from: "Alice <alice@example.org>" });
    return {
      account: acc,
      gmailMessageId: id,
      gmailThreadId,
      historyId: "1",
      internalDate: new Date(at),
      labelIds: full.labelIds ?? [],
      snippet: null,
      sizeEstimate: 10,
      parsed: parseMessage(full),
      bodyIncomplete: false,
      createThread: true,
    };
  };
  /** What the approval page would post: the shown flag and digest, the tick only if the page asked for it. */
  const approveFrom = (item: ApprovalItem, digest: string, over: Partial<Parameters<typeof approveItem>[1]> = {}): Parameters<typeof approveItem>[1] => ({
    userId,
    itemId: item.id,
    revision: item.revision,
    contentHash: item.contentHash,
    ackThreadChange: item.threadChangedAt !== null || digest !== "",
    shownThreadChangedAt: item.threadChangedAt ? item.threadChangedAt.getTime() : null,
    shownNewer: digest,
    messageIdHost: HOST,
    confirmedRecipients: [],
    newRecipientLimit: 10,
    ...over,
  });
  const view = async (itemId: string) => (await getItemView(database, userId, itemId, { newRecipientLimit: 10 }))!;

  // ---- O2: draftReply across a disconnect ---------------------------------------------------------

  /** An executor that deletes accountA right before its `n`th `.transaction` call (1-based). */
  const deleteBeforeTransaction = (n: number) => {
    let calls = 0;
    return new Proxy(database, {
      get(t, p) {
        if (p === "transaction")
          return async (fn: (tx: unknown) => Promise<unknown>, cfg?: unknown) => {
            calls++;
            if (calls === n) await deleteAccount(database, userId, accountA.id, { attempts: 1 });
            return (t.transaction as (f: unknown, c?: unknown) => Promise<unknown>)(fn, cfg);
          };
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Database;
  };
  const okDraft = (): DraftOutcome => ({ status: "ok", body: "Sounds good.", notes: "", errorCode: null, usage: DRAFT_USAGE });
  const aiAudits = async () => (await database.select().from(schema.auditLog)).filter((a) => a.action.startsWith("ai.")).map((a) => ({ action: a.action, accountId: a.accountId, detail: a.detail }));
  const draftInput = (threadId: string) => ({ userId, threadId, mode: "reply" as const, instruction: null });

  it("W1: gone after startDraftCall, before ai.draft_requested: no model call, the row finished at $0, one draft_failed", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    let called = 0;
    const provider: DraftProvider = { id: "anthropic-opus", draft: async () => (called++, okDraft()) };
    const out = await draftReply({ db: deleteBeforeTransaction(2), provider, caps: BIG }, draftInput(t.thread.id));
    expect(out).toEqual({ ok: false, code: "account_disconnected" });
    expect(called).toBe(0);
    const calls = await database.select().from(schema.aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "error", errorCode: "account_disconnected", costUsdMicros: 0, accountId: null, threadId: null, approvalItemId: null });
    expect(await aiAudits()).toEqual([
      { action: "ai.draft_requested", accountId: null, detail: { threadId: t.thread.id } },
      { action: "ai.draft_failed", accountId: null, detail: { code: "account_disconnected" } },
    ]);
    expect(await database.select().from(schema.approvalItems)).toEqual([]);
  });

  it("W2: gone during a provider call that returns ok: real usage kept, status ok, code account_disconnected, no item", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    const provider: DraftProvider = {
      id: "anthropic-opus",
      draft: async () => {
        await deleteAccount(database, userId, accountA.id, { attempts: 1 });
        return okDraft();
      },
    };
    expect(await draftReply({ db: database, provider, caps: BIG }, draftInput(t.thread.id))).toEqual({ ok: false, code: "account_disconnected" });
    const calls = await database.select().from(schema.aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "ok", errorCode: "account_disconnected", costUsdMicros: DRAFT_COST, inputTokens: 1_000, outputTokens: 100, accountId: null, approvalItemId: null });
    expect(DRAFT_COST).toBeGreaterThan(0);
    const audits = await aiAudits();
    expect(audits.filter((a) => a.action === "ai.draft_failed")).toEqual([{ action: "ai.draft_failed", accountId: null, detail: { code: "account_disconnected" } }]);
    expect(audits.some((a) => a.action === "ai.draft_proposed")).toBe(false);
    expect(await database.select().from(schema.approvalItems)).toEqual([]);
  });

  it("W3: gone during a provider call that fails: the provider's code and the reserve (timeout) or $0 (definite) are kept", async () => {
    for (const [code, cost] of [["timeout", DRAFT_RESERVED_COST_MICROS], ["api_400", 0]] as const) {
      await database.delete(schema.users);
      userId = (await makeUser(database)).id;
      accountA = await makeGoogleAccount(database, userId, { email: "work@example.com" });
      const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
      const provider: DraftProvider = {
        id: "anthropic-opus",
        draft: async () => {
          await deleteAccount(database, userId, accountA.id, { attempts: 1 });
          return { status: "error", body: null, notes: null, errorCode: code, usage: emptyUsage("anthropic-opus", "claude-opus-5-5", 90_000) };
        },
      };
      expect(await draftReply({ db: database, provider, caps: BIG }, draftInput(t.thread.id)), code).toEqual({ ok: false, code: "account_disconnected" });
      const calls = await database.select().from(schema.aiCalls);
      expect(calls, code).toHaveLength(1);
      expect(calls[0], code).toMatchObject({ status: "error", errorCode: code, costUsdMicros: cost, accountId: null });
      const audits = await aiAudits();
      expect(audits.filter((a) => a.action !== "ai.draft_requested"), code).toEqual([
        { action: "ai.provider_error", accountId: null, detail: { purpose: "draft", status: code } },
        { action: "ai.draft_failed", accountId: null, detail: { code: "account_disconnected" } },
      ]);
    }
  });

  it("W4: gone after proposeAiReply committed, before the finish: the item cascaded, the row keeps its usage and no item link", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    const provider: DraftProvider = { id: "anthropic-opus", draft: async () => okDraft() };
    // 1 startDraftCall, 2 ai.draft_requested, 3 proposeReply, 4 finishDraftCall.
    expect(await draftReply({ db: deleteBeforeTransaction(4), provider, caps: BIG }, draftInput(t.thread.id))).toEqual({ ok: false, code: "account_disconnected" });
    const calls = await database.select().from(schema.aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "ok", errorCode: "account_disconnected", costUsdMicros: DRAFT_COST, accountId: null, approvalItemId: null });
    const audits = await aiAudits();
    expect(audits.filter((a) => a.action === "ai.draft_failed")).toEqual([{ action: "ai.draft_failed", accountId: null, detail: { code: "account_disconnected" } }]);
    expect(audits.some((a) => a.action === "ai.draft_proposed")).toBe(false);
    expect(await database.select().from(schema.approvalItems)).toEqual([]);
  });

  it("startDraftCall finding the account gone answers account_disconnected, with no row and no audit", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    let called = 0;
    const provider: DraftProvider = { id: "anthropic-opus", draft: async () => (called++, okDraft()) };
    expect(await draftReply({ db: deleteBeforeTransaction(1), provider, caps: BIG }, draftInput(t.thread.id))).toEqual({ ok: false, code: "account_disconnected" });
    expect(called).toBe(0);
    expect(await database.select().from(schema.aiCalls)).toEqual([]);
    expect(await aiAudits()).toEqual([]);
  });

  it("with the account live, the draft is proposed and linked as before (AC-O2-4 sanity)", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    const provider: DraftProvider = { id: "anthropic-opus", draft: async () => okDraft() };
    const out = await draftReply({ db: database, provider, caps: BIG }, draftInput(t.thread.id));
    expect(out).toMatchObject({ ok: true });
    const itemId = (out as { itemId: string }).itemId;
    expect((await database.select().from(schema.aiCalls))[0]).toMatchObject({ status: "ok", errorCode: null, approvalItemId: itemId, accountId: accountA.id, costUsdMicros: DRAFT_COST });
    expect((await aiAudits()).map((a) => [a.action, a.accountId])).toEqual([
      ["ai.draft_requested", accountA.id],
      ["ai.draft_proposed", accountA.id],
    ]);
  });

  it("AC-O2-5: 30 staggered rounds of draftReply vs Disconnect (retries off, separate pool): no deadlock, FK error or throw", { timeout: 120_000 }, async () => {
    const outcomes: Record<string, number> = {};
    const errors: string[] = [];
    for (let round = 0; round < 30; round++) {
      const acc = await makeGoogleAccount(database, userId, { email: `r${round}@example.com` });
      const t = await thread(acc, [{ id: `p${round}`, at: Date.now() - HOUR }]);
      const provider: DraftProvider = {
        id: "anthropic-opus",
        draft: async () => {
          await sleep(round % 4);
          return okDraft();
        },
      };
      const [d, del] = await Promise.all([
        draftReply({ db: poolDb, provider, caps: BIG }, draftInput(t.thread.id)).then(
          (r) => (r.ok ? "proposed" : r.code),
          (err: unknown) => `throws:${pgCode(err)}`,
        ),
        (async () => {
          await sleep((round % 10) * 8);
          return deleteAccount(poolDb, userId, acc.id, { attempts: 1 }).then(
            () => "ok",
            (err: unknown) => `error:${pgCode(err)}`,
          );
        })(),
      ]);
      outcomes[d] = (outcomes[d] ?? 0) + 1;
      if (!["proposed", "account_disconnected", "not_found"].includes(d)) errors.push(`round ${round}: draft ${d}`);
      if (del !== "ok") errors.push(`round ${round}: disconnect ${del}`);
    }
    expect(errors).toEqual([]);
    const calls = await database.select().from(schema.aiCalls);
    expect(calls.filter((c) => c.status === "pending")).toEqual([]);
    expect(calls.every((c) => c.accountId === null && (c.errorCode === null || c.errorCode === "account_disconnected"))).toBe(true);
    // Every proposed round's item cascaded with its account later (the FK set the link null).
    expect(await database.select().from(schema.approvalItems)).toEqual([]);
    console.info("AC-O2-5 outcomes", outcomes);
  });

  // ---- O2 triage sibling (owner Q10 amendment) ------------------------------------------------------

  const okTriage = (): TriageOutcome => ({ status: "ok", result: { category: "fyi", needsReply: false, summary: "A note." }, errorCode: null, usage: TRIAGE_USAGE });

  it("on demand: gone during the call: account_disconnected, the billed call recorded with null ids, no triage row", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    const provider: TriageProvider = {
      id: "anthropic-haiku",
      triage: async () => {
        await deleteAccount(database, userId, accountA.id, { attempts: 1 });
        return okTriage();
      },
    };
    expect(await triageThreadNow({ db: database, provider, caps: BIG }, userId, t.thread.id)).toBe("account_disconnected");
    const calls = await database.select().from(schema.aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: "triage", status: "ok", errorCode: "account_disconnected", costUsdMicros: TRIAGE_COST, accountId: null, messageId: null });
    expect(await database.select().from(schema.mailTriage)).toEqual([]);
    expect(await aiAudits()).toEqual([{ action: "ai.triage_run", accountId: null, detail: { triaged: 1, failed: 0, skipped_cap: 0, costUsdMicros: TRIAGE_COST } }]);
  });

  it("on demand: a failed call keeps the provider's code and reserve when the account is gone", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    const provider: TriageProvider = {
      id: "anthropic-haiku",
      triage: async () => {
        await deleteAccount(database, userId, accountA.id, { attempts: 1 });
        return { status: "error", result: null, errorCode: "timeout", usage: emptyUsage("anthropic-haiku", "claude-haiku-5-5", 30_000) };
      },
    };
    expect(await triageThreadNow({ db: database, provider, caps: BIG }, userId, t.thread.id)).toBe("account_disconnected");
    expect((await database.select().from(schema.aiCalls))[0]).toMatchObject({ status: "error", errorCode: "timeout", costUsdMicros: TRIAGE_RESERVED_COST_MICROS, accountId: null, messageId: null });
    expect((await aiAudits()).map((a) => [a.action, a.accountId])).toEqual([
      ["ai.provider_error", null],
      ["ai.triage_run", null],
    ]);
  });

  it("ingest stage: gone during the first call: the stage resolves, records that call, writes no triage row and stops", async () => {
    await thread(accountA, [{ id: "a1", at: Date.now() - HOUR }]);
    await thread(accountA, [{ id: "b1", at: Date.now() - 2 * HOUR }]);
    let called = 0;
    const provider: TriageProvider = {
      id: "anthropic-haiku",
      triage: async () => {
        called++;
        await deleteAccount(database, userId, accountA.id, { attempts: 1 });
        return okTriage();
      },
    };
    const r = await runTriageStage({ db: database, provider, caps: BIG }, accountA);
    expect(r).toEqual({ triaged: 1, failed: 0, skippedCap: 0, costUsdMicros: TRIAGE_COST });
    expect(called).toBe(1);
    expect(await database.select().from(schema.aiCalls)).toMatchObject([{ status: "ok", errorCode: "account_disconnected", accountId: null, messageId: null }]);
    expect(await database.select().from(schema.mailTriage)).toEqual([]);
    expect(await aiAudits()).toEqual([{ action: "ai.triage_run", accountId: null, detail: { triaged: 1, failed: 0, skipped_cap: 0, costUsdMicros: TRIAGE_COST } }]);
  });

  it("ingest stage: a message deleted on its own during the call: call recorded without it, no triage row, the account's other mail goes on", async () => {
    const a = await thread(accountA, [{ id: "a1", at: Date.now() - HOUR }]);
    await thread(accountA, [{ id: "b1", at: Date.now() - 2 * HOUR }]);
    let called = 0;
    const provider: TriageProvider = {
      id: "anthropic-haiku",
      triage: async () => {
        if (called++ === 0) await database.delete(schema.mailMessages).where(eq(schema.mailMessages.id, a.messages[0]!.id));
        return okTriage();
      },
    };
    const r = await runTriageStage({ db: database, provider, caps: BIG }, accountA);
    expect(r.triaged).toBe(2);
    const calls = await database.select().from(schema.aiCalls);
    expect(calls.map((c) => [c.accountId, c.messageId === null, c.errorCode]).sort()).toEqual([
      [accountA.id, false, null],
      [accountA.id, true, null],
    ]);
    expect((await database.select().from(schema.mailTriage)).length).toBe(1);
  });

  it("with the account live, triage writes its row and links the call as before", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    const provider: TriageProvider = { id: "anthropic-haiku", triage: async () => okTriage() };
    expect(await triageThreadNow({ db: database, provider, caps: BIG }, userId, t.thread.id)).toBe("triaged");
    expect((await database.select().from(schema.aiCalls))[0]).toMatchObject({ accountId: accountA.id, messageId: t.messages[0]!.id, errorCode: null });
    expect(await database.select().from(schema.mailTriage)).toMatchObject([{ status: "ok", messageId: t.messages[0]!.id }]);
  });

  it("skipped_cap rows are still written (now in one lock-first transaction)", async () => {
    await thread(accountA, [{ id: "a1", at: Date.now() - HOUR }]);
    await thread(accountA, [{ id: "b1", at: Date.now() - 2 * HOUR }]);
    const provider: TriageProvider = { id: "anthropic-haiku", triage: async () => okTriage() };
    const capped: Caps = { ...BIG, triageCalls: 0 };
    expect(await runTriageStage({ db: database, provider, caps: capped }, accountA)).toMatchObject({ skippedCap: 2 });
    expect((await database.select().from(schema.mailTriage)).map((m) => m.status)).toEqual(["skipped_cap", "skipped_cap"]);
  });

  // ---- SF2 (owner Q1 option c) ---------------------------------------------------------------------

  /** Top-level (non-transaction) UPDATEs of approval_items throw: exactly the post-commit re-flag steps. */
  const brokenPostCommit = (base: Database) =>
    new Proxy(base, {
      get(t, p, r) {
        if (p === "update")
          return (table: unknown) => {
            if (table === schema.approvalItems) throw Object.assign(new Error("Failed query: update approval_items"), { cause: { code: "57014" } });
            return t.update(table as never);
          };
        return Reflect.get(t, p, r);
      },
    }) as Database;
  /** Holds the first transaction open after its body ran (before COMMIT) until released. */
  const holdFirstCommit = (base: Database) => {
    let first = true;
    let onHeld!: () => void;
    const held = new Promise<void>((r) => (onHeld = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const db = new Proxy(base, {
      get(t, p, r) {
        if (p === "transaction")
          return (fn: (tx: unknown) => Promise<unknown>, cfg?: unknown) => {
            const hold = first;
            first = false;
            return (t.transaction as (f: unknown, c?: unknown) => Promise<unknown>)(async (tx: unknown) => {
              const v = await fn(tx);
              if (hold) {
                onHeld();
                await released;
              }
              return v;
            }, cfg);
          };
        return Reflect.get(t, p, r);
      },
    }) as Database;
    return { db, held, release };
  };

  it("AC-SF2-1: the item saved while M was uncommitted, then M's post-commit re-check fails: approve needs the re-rendered page", { timeout: 20_000 }, async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    const m = holdFirstCommit(brokenPostCommit(poolDb));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = storeMessage(m.db, storeInput(accountA, "m2", t.gmailThreadId, Date.now() - MIN));
      await m.held; // M's in-transaction flag ran (no item yet); M isn't committed.
      const r = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
      const itemId = (r as { itemId: string }).itemId;
      const shown = await view(itemId);
      expect([shown.item.threadChangedAt, shown.newerCount, shown.newerDigest]).toEqual([null, 0, ""]);
      m.release();
      await store;
      // The residual: nothing flagged the item, and the failure was only audited.
      expect((await reload(itemId)).threadChangedAt).toBeNull();
      expect((await database.select().from(schema.auditLog).where(eq(schema.auditLog.action, "approval.recheck_failed"))).length).toBe(1);
      // Approving what the old page showed is refused...
      expect(await approveItem(database, approveFrom(shown.item, shown.newerDigest))).toEqual({ kind: "blocked", reason: "ack_required" });
      // ...the re-rendered page shows the warning and asks for the tick...
      const again = await view(itemId);
      expect(again.newerCount).toBe(1);
      expect(again.newerDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(await approveItem(database, approveFrom(again.item, again.newerDigest, { ackThreadChange: false }))).toEqual({ kind: "blocked", reason: "ack_required" });
      // ...and with its digest and the tick it is approved.
      expect(await approveItem(database, approveFrom(again.item, again.newerDigest))).toEqual({ kind: "approved" });
    } finally {
      quiet.mockRestore();
    }
  });

  it("AC-SF2-2: a crash after M committed (no post-commit step at all) behaves the same", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    const r = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
    const itemId = (r as { itemId: string }).itemId;
    const shown = await view(itemId);
    // M's own transaction ran before the item existed (so it flagged nothing) and its post-commit step never ran.
    const msg = await addMessage(accountA, t.thread.id, t.gmailThreadId, { id: "m2", at: Date.now() - MIN });
    expect((await reload(itemId)).threadChangedAt).toBeNull();
    expect(await newerMessageIds(database, await reload(itemId))).toEqual([msg.id]);
    expect(await approveItem(database, approveFrom(shown.item, shown.newerDigest))).toEqual({ kind: "blocked", reason: "ack_required" });
    const again = await view(itemId);
    expect(again.newerDigest).toBe(newerDigest([msg.id]));
    expect(await approveItem(database, approveFrom(again.item, again.newerDigest))).toEqual({ kind: "approved" });
  });

  it("AC-SF2-3: Alex's own SENT copy in the thread doesn't count; an inbound message reusing the header does", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    const r1 = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
    const i1 = await reload((r1 as { itemId: string }).itemId);
    expect(await approveItem(database, approveFrom(i1, ""))).toEqual({ kind: "approved" });
    const header = (await reload(i1.id)).messageIdHeader!;
    const r2 = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
    const i2Id = (r2 as { itemId: string }).itemId;
    await addMessage(accountA, t.thread.id, t.gmailThreadId, { id: "s1", at: Date.now() - MIN, sent: true, rfc822: header });
    const v = await view(i2Id);
    expect([v.newerCount, v.newerDigest]).toEqual([0, ""]);
    expect(await approveItem(database, approveFrom(v.item, ""))).toEqual({ kind: "approved" });
    // The same header on a non-SENT message is a new message like any other (security review S1).
    const r3 = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
    await addMessage(accountA, t.thread.id, t.gmailThreadId, { id: "x1", at: Date.now() - MIN + 1, rfc822: header });
    expect((await view((r3 as { itemId: string }).itemId)).newerCount).toBe(1);
  });

  it("AC-SF2-4: an empty or missing digest with newer messages is refused; with none, approve is unchanged", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    const r = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
    const itemId = (r as { itemId: string }).itemId;
    const quiet = await view(itemId);
    expect([quiet.newerCount, quiet.newerDigest]).toEqual([0, ""]);
    await addMessage(accountA, t.thread.id, t.gmailThreadId, { id: "m2", at: Date.now() - MIN });
    expect(await approveItem(database, approveFrom(quiet.item, "", { ackThreadChange: true }))).toEqual({ kind: "blocked", reason: "ack_required" });
    // A digest of some other set is refused too.
    expect(await approveItem(database, approveFrom(quiet.item, newerDigest(["00000000-0000-4000-8000-000000000000"]), { ackThreadChange: true }))).toEqual({ kind: "blocked", reason: "ack_required" });
    const t2 = await thread(accountA, [{ id: "q1", at: Date.now() - HOUR }]);
    const r2 = await proposeReply(database, replyInput(t2.thread.id, t2.messages[0]!.id));
    expect(await approveItem(database, approveFrom(await reload((r2 as { itemId: string }).itemId), ""))).toEqual({ kind: "approved" });
  });

  it("AC-SF2-6: a new message (no thread) has no digest and approves as before", async () => {
    const r = await proposeNewMessage(database, { userId, accountId: accountA.id, to: "bob@example.org", cc: "", subject: "Hello", bodyText: "Hi" });
    const itemId = (r as { itemId: string }).itemId;
    const v = await view(itemId);
    expect([v.newerCount, v.newerDigest]).toEqual([0, ""]);
    expect(await approveItem(database, approveFrom(v.item, "", { confirmedRecipients: ["bob@example.org"] }))).toEqual({ kind: "approved" });
  });

  it("the digest uses the hook's baseline: a message older than the parent, and the parent itself, don't count", async () => {
    const t = await thread(accountA, [
      { id: "o1", at: Date.now() - 2 * HOUR },
      { id: "p1", at: Date.now() - HOUR },
    ]);
    const r = await proposeReply(database, replyInput(t.thread.id, t.messages[1]!.id));
    const item = await reload((r as { itemId: string }).itemId);
    expect(await newerMessageIds(database, item)).toEqual([]);
    const later = await addMessage(accountA, t.thread.id, t.gmailThreadId, { id: "n1", at: Date.now() - MIN });
    expect(await newerMessageIds(database, item)).toEqual([later.id]);
    expect((await database.select().from(schema.mailMessages).where(and(eq(schema.mailMessages.threadId, t.thread.id)))).length).toBe(3);
  });
});
