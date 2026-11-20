import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ApprovalItem, ConnectedAccount } from "@/db/schema";
import { deleteAccount } from "@/lib/accounts";
import type { Caps } from "@/lib/ai-ledger/config";
import { emptyUsage, startDraftCall } from "@/lib/ai-ledger/ledger";
import { draftReply } from "@/lib/ai/draft";
import { buildTriageRequest, MESSAGE_TEXT_CAP } from "@/lib/ai/prompts";
import { runTriageStage } from "@/lib/ai/triage";
import type { DraftProvider, ThreadTextMessage, TriageInput, TriageProvider } from "@/lib/ai/types";
import { emailSendPayload } from "@/lib/approvals/payload";
import {
  approveItem,
  cancelItem,
  claimItem,
  editItem,
  getOwnItem,
  markNotSent,
  markReconciledSent,
  markStuckUnknown,
  proposeNewMessage,
  proposeReply,
  recordOutcome,
  rejectItem,
} from "@/lib/approvals/service";
import { parseMessage } from "@/lib/gmail/mime";
import { getSyncState, storeMessage, type StoreMessageInput } from "@/lib/gmail/store";
import { syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { FakeGmail, header, textPart, toFull, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester, phase-2-followups-1 (Postgres only: TEST_DATABASE_URL, a disposable local database).
// - E5: the Q4 flagAt guard under a same-millisecond interleaving; post-commit failures of other
//   statements and of the audit write itself, through a real sync run.
// - Deadlock: a real 40P01 with Disconnect as the victim (retry recovers; retries off rethrows), a
//   staggered race on both sides for every locked transition, and a transition after the account is gone.

const HOST = "alex.example.com";
const MIN = 60_000;
const HOUR = 60 * MIN;
const BIG: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 25, draftMicros: 3_000_000, totalMicros: 3_500_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pgCode = (err: unknown): string => {
  const e = err as { cause?: { code?: string }; code?: string };
  return e?.cause?.code ?? e?.code ?? (err instanceof Error ? err.name : "?");
};
const note = (s: string) => {
  if (process.env.TESTER_SCRATCH) appendFileSync(process.env.TESTER_SCRATCH, `${s}\n`);
};

describe.skipIf(!testDbUrl)("tester phase-2-followups-1 (Postgres, two connections)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;
  let userId: string;
  let accountA: ConnectedAccount;

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
    vi.useRealTimers();
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    accountA = await makeGoogleAccount(database, userId, { email: "work@example.com" });
  });

  const reload = async (id: string) => (await getOwnItem(database, userId, id))!;
  const auditRows = async (action: string) => database.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
  async function compose(accountId: string) {
    const r = await proposeNewMessage(database, { userId, accountId, to: "bob@example.org", cc: "", subject: "Hello", bodyText: "Hi" });
    if (!r.ok) throw new Error(r.error);
    return reload(r.itemId);
  }
  const approveInput = (item: ApprovalItem, over: Partial<Parameters<typeof approveItem>[1]> = {}): Parameters<typeof approveItem>[1] => {
    const p = emailSendPayload.parse(item.payload);
    return {
      userId,
      itemId: item.id,
      revision: item.revision,
      contentHash: item.contentHash,
      ackThreadChange: item.threadChangedAt !== null,
      shownThreadChangedAt: item.threadChangedAt ? item.threadChangedAt.getTime() : null,
      messageIdHost: HOST,
      confirmedRecipients: [...p.to, ...p.cc],
      newRecipientLimit: 1_000_000,
      ...over,
    };
  };
  async function thread(acc: ConnectedAccount, messages: { id: string; at: number; labels?: string[] }[]) {
    const gt = `gt-${Math.random().toString(36).slice(2)}`;
    const [t] = await database
      .insert(schema.mailThreads)
      .values({ userId, accountId: acc.id, gmailThreadId: gt, subject: "Lunch", lastMessageAt: new Date(), messageCount: messages.length, inInbox: true, hasUnread: false })
      .returning();
    const rows = [];
    for (const m of messages) {
      const [row] = await database
        .insert(schema.mailMessages)
        .values({
          userId,
          accountId: acc.id,
          threadId: t!.id,
          gmailMessageId: m.id,
          gmailThreadId: gt,
          internalDate: new Date(m.at),
          labelIds: m.labels ?? ["INBOX"],
          isSent: false,
          subject: "Lunch",
          fromHeader: "Alice <alice@example.org>",
          toHeader: acc.email,
          rfc822MessageId: `<${m.id}@mail.example.org>`,
          headers: [],
          bodyText: "Hello",
        })
        .returning();
      rows.push(row!);
    }
    return { thread: t!, gmailThreadId: gt, messages: rows };
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
  /** An executor whose transactions run `fn`, then signal and wait before committing. */
  function holdBeforeCommit(base: Database) {
    let ran!: () => void;
    const ranP = new Promise<void>((r) => (ran = r));
    let release!: () => void;
    const releaseP = new Promise<void>((r) => (release = r));
    const db = new Proxy(base, {
      get(tt, p) {
        if (p === "transaction")
          return (fn: (tx: unknown) => Promise<unknown>) =>
            tt.transaction(async (tx) => {
              const out = await fn(tx);
              ran();
              await releaseP;
              return out as never;
            });
        const v = Reflect.get(tt, p, tt);
        return typeof v === "function" ? v.bind(tt) : v;
      },
    }) as Database;
    return { db, ran: ranP, release };
  }

  // ---- E5 / Q4: the flagAt guard must never hide a concurrently arriving message ----------------

  it("Q4: a reply created with T1 in the same millisecond as M2's flagAt, while M2 is between its two steps, can't be approved from the T1 page", { timeout: 20_000 }, async () => {
    const realNow = Date.now();
    const t = await thread(accountA, [
      { id: "p1", at: realNow - 60 * MIN },
      { id: "m1", at: realNow - 40 * MIN },
    ]);
    // Two `new Date()` calls in the same millisecond (two requests in one Node process, or two
    // instances whose clocks agree to the millisecond): M2's flagAt and the reply's T1.
    vi.useFakeTimers({ toFake: ["Date"], now: realNow });
    try {
      const m2 = holdBeforeCommit(poolDb);
      const store = storeMessage(m2.db, storeInput(accountA, "m2", t.gmailThreadId, realNow - 20 * MIN));
      await m2.ran; // M2's in-transaction hook ran (no item yet); M2 isn't committed
      const r = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
      expect(r).toMatchObject({ ok: true });
      const itemId = (r as { itemId: string }).itemId;
      const shown = await reload(itemId); // the owner's page: T1, and m1 but not m2
      expect(shown.threadChangedAt).not.toBeNull();
      vi.setSystemTime(realNow + 50); // time moves on before M2's post-commit step
      m2.release();
      await store;
      const after = await reload(itemId);
      note(`q4-same-ms shown=${shown.threadChangedAt!.getTime() - realNow} after=${after.threadChangedAt!.getTime() - realNow}`);
      // M2 is now committed and was never on the owner's page: approving from that page must ask again.
      const res = await approveItem(database, approveInput(shown));
      expect(res, "approved from a page that never showed M2").toEqual({ kind: "blocked", reason: "ack_required" });
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- E5: post-commit failures of other statements, and of the audit write itself ---------------

  it("E5: proposeReply's post-commit SELECT throwing a non-Error value with content: saved, audited with a content-free code", async () => {
    const t = await thread(accountA, [
      { id: "p1", at: Date.now() - 60 * MIN },
      { id: "n1", at: Date.now() - 30 * MIN },
    ]);
    let inTx = 0;
    const broken = new Proxy(database, {
      get(tt, p, rr) {
        if (p === "transaction")
          return (fn: (tx: unknown) => Promise<unknown>) => {
            inTx++;
            return tt.transaction(fn as never).finally(() => inTx--);
          };
        if (p === "select")
          return (...a: unknown[]) => {
            // Only the post-commit newerMessageInThread (a top-level select after the item committed).
            if (inTx === 0 && a.length === 1 && "id" in (a[0] as object) && Object.keys(a[0] as object).length === 1 && seenTx) throw "subject Lunch from alice@example.org";
            return (tt.select as (...x: unknown[]) => unknown)(...a);
          };
        return Reflect.get(tt, p, rr);
      },
    }) as Database;
    let seenTx = false;
    const brokenAfterTx = new Proxy(broken, {
      get(tt, p, rr) {
        if (p === "transaction") return (fn: (tx: unknown) => Promise<unknown>) => (tt.transaction as (f: unknown) => Promise<unknown>)(fn).finally(() => (seenTx = true));
        return Reflect.get(tt, p, rr);
      },
    }) as Database;
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a));
    try {
      const r = await proposeReply(brokenAfterTx, replyInput(t.thread.id, t.messages[0]!.id));
      expect(r).toMatchObject({ ok: true });
      const itemId = (r as { itemId: string }).itemId;
      expect(await reload(itemId)).toBeTruthy();
      const rows = await auditRows("approval.recheck_failed");
      expect(rows.map((a) => a.detail)).toEqual([{ stage: "propose", threadId: t.thread.id, itemId, code: "unknown" }]);
      expect(JSON.stringify(logs)).not.toMatch(/alice|Lunch|subject/);
      expect(logs).toEqual([["approval re-check failed", { stage: "propose", accountId: accountA.id, threadId: t.thread.id, itemId, error: "unknown", code: null }]]);
    } finally {
      spy.mockRestore();
    }
  });

  it("E5: in a real sync run, the post-commit step AND its audit write both fail: every message is stored, the run is ok, logs are content-free", async () => {
    let clock = Date.now();
    const gmail = new FakeGmail();
    const msg = (over: Partial<FakeMessage> & { id: string }): FakeMessage => ({ threadId: `t-${over.id}`, labelIds: ["INBOX"], internalDate: clock - HOUR, from: "Alice <alice@example.org>", subject: "Lunch", ...over });
    const deps = (db: Database): SyncDeps => ({
      db,
      gmailFor: () => gmail,
      now: () => new Date(clock),
      sleep: async () => {},
      unitsPerMinute: 1e9,
      render: async (body, opts) => ({ renderKind: "none", renderReason: null, renderedHtml: null, renderedHtmlRemote: null, renderedText: body.text, renderTruncated: false, sanitizerVersion: opts.version, renderedAt: new Date(clock) }),
    });
    const fresh = async () => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, accountA.id)))[0]!;
    gmail.seed(msg({ id: "p1", threadId: "g1", internalDate: clock - 2 * HOUR }));
    for (let i = 0; i < 10; i++) {
      await syncAccount(deps(database), await fresh(), "cron");
      if ((await getSyncState(database, accountA.id))?.backfillStatus === "complete") break;
      clock += 5 * MIN;
    }
    const t = (await database.select().from(schema.mailThreads))[0]!;
    const p1 = (await database.select().from(schema.mailMessages))[0]!;
    const r = await proposeReply(database, replyInput(t.id, p1.id));
    expect(r).toMatchObject({ ok: true });
    for (let i = 1; i <= 4; i++) gmail.deliver(msg({ id: `n${i}`, threadId: i % 2 ? "g1" : `g${i}`, internalDate: Date.now() - (10 - i) * 1000 }));
    let updates = 0;
    let audits = 0;
    const broken = new Proxy(database, {
      get(tt, p, rr) {
        if (p === "update")
          return (table: unknown) => {
            if (table === schema.approvalItems) {
              updates++;
              throw Object.assign(new Error("update approval_items for alice@example.org"), { cause: { code: "08006" } });
            }
            return tt.update(table as never);
          };
        if (p === "insert")
          return (table: unknown) => {
            const b = tt.insert(table as never);
            if (table !== schema.auditLog) return b;
            return new Proxy(b, {
              get(bt, bp) {
                const v = Reflect.get(bt, bp, bt);
                if (bp === "values")
                  return (vals: { action?: string }) => {
                    if (vals.action === "approval.recheck_failed") {
                      audits++;
                      throw Object.assign(new Error("connection lost while writing Lunch"), { code: "08006" });
                    }
                    return (v as (x: unknown) => unknown).call(bt, vals);
                  };
                return typeof v === "function" ? v.bind(bt) : v;
              },
            });
          };
        return Reflect.get(tt, p, rr);
      },
    }) as Database;
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a));
    try {
      const res = await syncAccount(deps(broken), await fresh(), "push");
      expect(res.outcome).toBe("ok");
      const ids = (await database.select().from(schema.mailMessages)).map((m) => m.gmailMessageId).sort();
      expect(ids).toEqual(["n1", "n2", "n3", "n4", "p1"]);
      expect(updates).toBeGreaterThanOrEqual(4);
      expect(audits).toBe(updates);
      // The in-transaction flag committed with n1.
      expect((await reload((r as { itemId: string }).itemId)).threadChangedAt).not.toBeNull();
      expect(await auditRows("approval.recheck_failed")).toEqual([]);
      const recheckLogs = logs.filter((l) => typeof l[0] === "string" && (l[0] as string).startsWith("approval re-check"));
      expect(recheckLogs.length).toBe(2 * updates);
      for (const l of recheckLogs) {
        const keys = Object.keys(l[1] as object).sort();
        expect([["accountId", "code", "error", "itemId", "stage", "threadId"], ["code", "error", "stage"]]).toContainEqual(keys);
      }
      expect(JSON.stringify(recheckLogs)).not.toMatch(/alice|Lunch|connection lost/);
    } finally {
      spy.mockRestore();
    }
  });

  // ---- E4 end to end: triage of hostile stored headers ---------------------------------------------

  it("E4 triage: INBOX messages with 10K '<' subjects, 10K '&' Date headers, long From and '<'-heavy bodies reach the model within 6,000 (tool result) through real 2a ingest", { timeout: 60_000 }, async () => {
    const clock = Date.now();
    const gmail = new FakeGmail();
    for (let i = 0; i < 3; i++)
      gmail.seed({
        id: `h${i}`,
        threadId: `gh${i}`,
        labelIds: ["INBOX"],
        internalDate: clock - (i + 1) * MIN,
        from: `${"M<".repeat(3_000)} <mallory${i}@example.test>`,
        subject: (i === 2 ? "\u{1F35C}" : "<").repeat(10_000),
        payload: { ...textPart("text/plain", "<&>\n".repeat(10_000)), headers: [header("Date", "&".repeat(10_000))] },
      });
    const deps: SyncDeps = {
      db: database,
      gmailFor: () => gmail,
      now: () => new Date(clock),
      sleep: async () => {},
      unitsPerMinute: 1e9,
      render: async (body, opts) => ({ renderKind: "none", renderReason: null, renderedHtml: null, renderedHtmlRemote: null, renderedText: body.text, renderTruncated: false, sanitizerVersion: opts.version, renderedAt: new Date(clock) }),
    };
    for (let i = 0; i < 10; i++) {
      const fresh = (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, accountA.id)))[0]!;
      await syncAccount(deps, fresh, "cron");
      if ((await getSyncState(database, accountA.id))?.backfillStatus === "complete") break;
    }
    const stored = await database.select().from(schema.mailMessages);
    expect(stored).toHaveLength(3);
    expect(Math.max(...stored.map((m) => (m.subject ?? "").length))).toBeGreaterThanOrEqual(10_000); // 2a stores headers uncapped
    const inputs: TriageInput[] = [];
    const provider: TriageProvider = {
      id: "anthropic-haiku",
      triage: async (input) => {
        inputs.push(input);
        return { status: "ok", result: { category: "fyi", needsReply: false, summary: "A note." }, errorCode: null, usage: { ...emptyUsage("anthropic-haiku", "claude-haiku-5-5", 5), inputTokens: 100, outputTokens: 10 } };
      },
    };
    await runTriageStage({ db: database, provider, now: () => new Date(clock), caps: BIG }, accountA);
    expect(inputs).toHaveLength(3);
    for (const input of inputs) {
      const req = buildTriageRequest(input);
      const content = (req.messages[2]!.content as { type: string; content?: string }[])[0]!.content!;
      expect(content.length).toBeLessThanOrEqual(MESSAGE_TEXT_CAP);
      const m = JSON.parse(content).message as ThreadTextMessage;
      expect(m.subject!.length).toBeLessThanOrEqual(300);
      expect(m.subject!.isWellFormed()).toBe(true);
      expect(m.date!.length).toBeLessThanOrEqual(100);
      expect(m.text.length).toBeGreaterThan(0);
      expect(m.truncated).toBe(true);
      // Everything else in the request is the fixed part (measured at ~3,419 JSON characters with an empty message).
      expect(JSON.stringify(req).length - JSON.stringify(content).length).toBeLessThan(4_000);
    }
    note(`e4-triage requestChars=${JSON.stringify(inputs.map((i) => JSON.stringify(buildTriageRequest(i)).length))}`);
  });

  // ---- Deadlock: Disconnect as the real deadlock victim ----------------------------------------

  /**
   * Builds a real deadlock in which Disconnect's DELETE is the victim: a transaction locks the item
   * row (no account pre-lock, like a future transition that forgets it), the DELETE then waits on it
   * in its cascade, and the transaction's audit insert waits on the account row. This session's
   * deadlock_timeout is raised so the DELETE's (default 1 s) check fires first.
   */
  async function deadlockDisconnect(opts: Parameters<typeof deleteAccount>[3]) {
    const b = await makeGoogleAccount(database, userId, { email: `dl${Math.random().toString(36).slice(2, 8)}@example.com` });
    const item = await compose(b.id);
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    let go!: () => void;
    const goP = new Promise<void>((r) => (go = r));
    const holder = poolDb.transaction(async (tx) => {
      await tx.execute(sql`set local deadlock_timeout = '20s'`);
      await tx.execute(sql`update approval_items set updated_at = now() where id = ${item.id}`);
      locked();
      await goP;
      await tx.insert(schema.auditLog).values({ userId, accountId: b.id, action: "tester.hold", detail: {} });
    });
    await lockedP;
    const started = Date.now();
    const disc = deleteAccount(poolDb, userId, b.id, opts).then(
      () => "ok",
      (err: unknown) => `error:${pgCode(err)}`,
    );
    await sleep(200);
    go();
    const [h, d] = await Promise.all([holder.then(() => "ok", (err: unknown) => `error:${pgCode(err)}`), disc]);
    const gone = (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, b.id))).length === 0;
    return { holder: h, disconnect: d, gone, ms: Date.now() - started };
  }

  it("Disconnect retry: a real 40P01 with the DELETE as victim is retried and succeeds; with retries off it is rethrown; the log has ids only", { timeout: 30_000 }, async () => {
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a));
    try {
      const off = await deadlockDisconnect({ attempts: 1 });
      expect(off).toMatchObject({ holder: "ok", disconnect: "error:40P01", gone: false });
      const waits: number[] = [];
      const on = await deadlockDisconnect({ sleep: async (ms) => void waits.push(ms) });
      note(`retry-real off=${JSON.stringify(off)} on=${JSON.stringify(on)} waits=${JSON.stringify(waits)}`);
      expect(on).toMatchObject({ holder: "ok", disconnect: "ok", gone: true });
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThanOrEqual(50);
      expect(waits[0]).toBeLessThan(250);
      const retryLogs = logs.filter((l) => l[0] === "disconnect deadlocked, retrying");
      expect(retryLogs).toHaveLength(1);
      expect(Object.keys(retryLogs[0]![1] as object).sort()).toEqual(["accountId", "attempt"]);
    } finally {
      spy.mockRestore();
    }
  });

  // ---- Deadlock: staggered races on both sides, every locked transition -------------------------

  type Kind = "approve" | "edit" | "reject" | "cancel" | "markNotSent" | "claim+outcome" | "stuck" | "reconciled" | "proposeNew" | "proposeReply" | "startDraftCall";

  async function prepare(kind: Kind, b: ConnectedAccount, round: number): Promise<() => Promise<string>> {
    if (kind === "proposeNew")
      return async () => {
        const r = await proposeNewMessage(poolDb, { userId, accountId: b.id, to: "bob@example.org", cc: "", subject: "Hello", bodyText: "Hi" });
        return r.ok ? "ok" : r.error;
      };
    if (kind === "proposeReply" || kind === "startDraftCall") {
      const t = await thread(b, [{ id: `p${round}`, at: Date.now() - 60 * MIN }]);
      if (kind === "proposeReply")
        return async () => {
          const r = await proposeReply(poolDb, replyInput(t.thread.id, t.messages[0]!.id));
          return r.ok ? "ok" : r.error;
        };
      // A stale pending row from an earlier call so the sweep UPDATE locks a row first (earlier rounds' rows are removed so the caps never stop the insert).
      await database.delete(schema.aiCalls);
      await database.insert(schema.aiCalls).values({ userId, accountId: b.id, threadId: t.thread.id, purpose: "draft", status: "pending", provider: "anthropic-opus", model: "claude-opus-5-5", createdAt: new Date(Date.now() - 2 * HOUR) });
      return async () => (await startDraftCall(poolDb, { userId, accountId: b.id, threadId: t.thread.id, provider: "anthropic-opus", model: "claude-opus-5-5", now: new Date(), caps: BIG })).kind;
    }
    let item = await compose(b.id);
    if (kind === "claim+outcome" || kind === "stuck" || kind === "reconciled") {
      expect((await approveItem(database, approveInput(item))).kind).toBe("approved");
      item = await reload(item.id);
    }
    if (kind === "stuck" || kind === "reconciled") {
      const c = await claimItem(database, userId, item.id);
      expect(c).not.toBeNull();
      item = await reload(item.id);
    }
    if (kind === "markNotSent") {
      await database.update(schema.approvalItems).set({ status: "unknown", executingSince: new Date(Date.now() - 2 * 24 * HOUR) }).where(eq(schema.approvalItems.id, item.id));
      item = await reload(item.id);
    }
    const it = item;
    switch (kind) {
      case "approve":
        return async () => (await approveItem(poolDb, approveInput(it))).kind;
      case "edit":
        return async () => {
          const r = await editItem(poolDb, { userId, itemId: it.id, revision: it.revision, to: "dave@example.org", cc: "", subject: "Hello", bodyText: "Edited", includeQuote: false });
          return r.ok ? "ok" : r.error;
        };
      case "reject":
        return async () => String(await rejectItem(poolDb, userId, it.id));
      case "cancel":
        return async () => String(await cancelItem(poolDb, userId, it.id));
      case "markNotSent":
        return async () => String(await markNotSent(poolDb, userId, it.id, new Date()));
      case "claim+outcome":
        return async () => {
          const c = await claimItem(poolDb, userId, it.id);
          if (!c) return "noclaim";
          const fresh = (await getOwnItem(poolDb, userId, it.id)) ?? it;
          return String(await recordOutcome(poolDb, fresh, c.executionId, { kind: "succeeded", gmailMessageId: `s${round}`, gmailThreadId: `t${round}` }));
        };
      case "stuck":
        return async () => String(await markStuckUnknown(poolDb, it, new Date(Date.now() + 2 * 24 * HOUR)));
      case "reconciled":
        return async () => String(await markReconciledSent(poolDb, it, { gmailMessageId: `s${round}`, gmailThreadId: `t${round}` }, "list_found"));
      default:
        throw new Error(kind);
    }
  }

  async function race(kind: Kind, rounds: number) {
    const tally = { deadlocks: 0, other: [] as string[], outcomes: {} as Record<string, number> };
    for (let round = 0; round < rounds; round++) {
      const b = await makeGoogleAccount(database, userId, { email: `r${round}-${kind.replace(/[^a-z]/gi, "")}@example.com` });
      const run = await prepare(kind, b, round);
      // Stagger both sides: odd rounds delay the transition, even rounds delay the Disconnect.
      const d = (round >> 1) % 15;
      const [res, disc] = await Promise.all([
        (async () => {
          if (round % 2) await sleep(d);
          try {
            return await run();
          } catch (err) {
            return `error:${pgCode(err)}`;
          }
        })(),
        (async () => {
          if (!(round % 2)) await sleep(d);
          try {
            await deleteAccount(poolDb, userId, b.id, { attempts: 1 });
            return "ok";
          } catch (err) {
            return `error:${pgCode(err)}`;
          }
        })(),
      ]);
      for (const r of [res, disc]) {
        if (r === "error:40P01") tally.deadlocks++;
        else if (r.startsWith("error:")) tally.other.push(`${round}:${r}`);
      }
      tally.outcomes[res] = (tally.outcomes[res] ?? 0) + 1;
      expect((await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, b.id))).length, `${kind} ${round}: account gone`).toBe(0);
      expect((await database.select().from(schema.approvalItems).where(eq(schema.approvalItems.accountId, b.id))).length, `${kind} ${round}: no item left`).toBe(0);
    }
    note(`race ${kind} rounds=${rounds} ${JSON.stringify(tally)}`);
    return tally;
  }

  it("approve vs Disconnect, 4 × 30 rounds staggered on both sides, retries off: 0 deadlocks, both outcomes, charge ⇔ approved audit", { timeout: 300_000 }, async () => {
    const all = { deadlocks: 0, other: [] as string[], approved: 0, stale: 0 };
    for (let rep = 0; rep < 4; rep++) {
      const t = await race("approve", 30);
      all.deadlocks += t.deadlocks;
      all.other.push(...t.other);
      all.approved += t.outcomes.approved ?? 0;
      all.stale += t.outcomes.stale ?? 0;
    }
    // Every approved audit has its charge (D1: charges survive the cascade).
    const approved = await auditRows("approval.approved");
    const charges = await database.select().from(schema.approvalRecipientCharges);
    const chargedItems = new Set(charges.map((c) => c.itemId));
    for (const a of approved) expect(chargedItems.has((a.detail as { itemId: string }).itemId)).toBe(true);
    note(`approve-race total ${JSON.stringify(all)} approvedAudits=${approved.length} charges=${charges.length}`);
    expect(all.deadlocks).toBe(0);
    expect(all.other).toEqual([]);
    expect(all.approved).toBeGreaterThan(0);
    expect(all.stale).toBeGreaterThan(0);
  });

  for (const kind of ["edit", "reject", "cancel", "markNotSent", "claim+outcome", "stuck", "reconciled", "proposeNew", "proposeReply", "startDraftCall"] as const) {
    it(`${kind} vs Disconnect, 30 rounds staggered on both sides, retries off: no deadlock and no FK error`, { timeout: 240_000 }, async () => {
      const t = await race(kind, 30);
      expect(t.deadlocks).toBe(0);
      // Round 2 (O1): startDraftCall returns not_found when the Disconnect wins, so no FK error anywhere.
      expect(t.other).toEqual([]);
      if (kind === "startDraftCall") expect(t.outcomes.not_found ?? 0, "the Disconnect won some rounds").toBeGreaterThan(0);
    });
  }

  // ---- After the account is gone ---------------------------------------------------------------

  it("approve after the account was disconnected: not_found (the item cascaded) with any recipient limit, no FK error, no audit or charge written", async () => {
    for (const limit of [0, 10]) {
      const b = await makeGoogleAccount(database, userId, { email: `gone${limit}@example.com` });
      const item = await compose(b.id);
      await deleteAccount(database, userId, b.id);
      const before = (await database.select().from(schema.auditLog)).length;
      expect(await approveItem(database, approveInput(item, { newRecipientLimit: limit }))).toEqual({ kind: "blocked", reason: "not_found" });
      expect((await database.select().from(schema.auditLog)).length).toBe(before);
      expect(await database.select().from(schema.approvalRecipientCharges).where(eq(schema.approvalRecipientCharges.itemId, item.id))).toEqual([]);
    }
  });

  it("every other transition after the account was disconnected: a clean false/null/not_found, no FK error", async () => {
    const b = await makeGoogleAccount(database, userId, { email: "gone@example.com" });
    const item = await compose(b.id);
    const t = await thread(b, [{ id: "pg", at: Date.now() - HOUR }]);
    await deleteAccount(database, userId, b.id);
    expect(await editItem(database, { userId, itemId: item.id, revision: item.revision, to: "dave@example.org", cc: "", subject: "Hello", bodyText: "x", includeQuote: false })).toMatchObject({ ok: false });
    expect(await rejectItem(database, userId, item.id)).toBe(false);
    expect(await cancelItem(database, userId, item.id)).toBe(false);
    expect(await markNotSent(database, userId, item.id, new Date())).toBe(false);
    expect(await claimItem(database, userId, item.id)).toBeNull();
    expect(await recordOutcome(database, item, "00000000-0000-4000-8000-000000000000", { kind: "succeeded", gmailMessageId: "s", gmailThreadId: "t" })).toBe(false);
    expect(await markStuckUnknown(database, item, new Date())).toBe(false);
    expect(await proposeNewMessage(database, { userId, accountId: b.id, to: "bob@example.org", cc: "", subject: "Hello", bodyText: "Hi" })).toMatchObject({ ok: false });
    expect(await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id))).toMatchObject({ ok: false, error: "not_found" });
  });

  // ---- Probes (not part of the suite): the open item and a pre-existing gap ---------------------

  it("O1: draftReply when the account is disconnected right before startDraftCall: not_found, no provider call, no ai_calls row, no audit", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    let called = 0;
    const provider: DraftProvider = { id: "anthropic-opus", draft: async () => (called++, { status: "ok", body: "x", notes: "", errorCode: null, usage: emptyUsage("anthropic-opus", "claude-opus-5-5") }) };
    let deleted = false;
    const db = new Proxy(database, {
      get(tt, p, rr) {
        if (p === "transaction" && !deleted)
          return async (fn: never) => {
            deleted = true;
            await deleteAccount(database, userId, accountA.id);
            return tt.transaction(fn);
          };
        return Reflect.get(tt, p, rr);
      },
    }) as Database;
    const out = await draftReply({ db, provider, caps: BIG }, { userId, threadId: t.thread.id, mode: "reply", instruction: null }).then(
      (v) => JSON.stringify(v),
      (err: unknown) => `throws:${pgCode(err)}`,
    );
    note(`startDraftCall-after-disconnect: ${out} providerCalls=${called}`);
    expect(out).toBe(JSON.stringify({ ok: false, code: "not_found" }));
    expect(called).toBe(0);
    expect(await database.select().from(schema.aiCalls)).toEqual([]);
    expect((await database.select().from(schema.auditLog)).filter((a) => a.action.startsWith("ai."))).toEqual([]);
  });

  it.runIf(!!process.env.TESTER_PROBE)("probe: draftReply when the account is disconnected during the model call", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - HOUR }]);
    const provider: DraftProvider = {
      id: "anthropic-opus",
      draft: async () => {
        await deleteAccount(database, userId, accountA.id);
        return { status: "ok", body: "Sounds good.", notes: "", errorCode: null, usage: { ...emptyUsage("anthropic-opus", "claude-opus-5-5", 5), inputTokens: 1_000, outputTokens: 100 } };
      },
    };
    const out = await draftReply({ db: database, provider, caps: BIG }, { userId, threadId: t.thread.id, mode: "reply", instruction: null }).then(
      (v) => JSON.stringify(v),
      (err: unknown) => `throws:${pgCode(err)}`,
    );
    const calls = await database.select().from(schema.aiCalls);
    note(`probe disconnect-during-draft: ${out} aiCalls=${JSON.stringify(calls.map((c) => ({ status: c.status, errorCode: c.errorCode, accountId: c.accountId })))}`);
  });

  it("sanity: the T1 test's setup without the same-millisecond collision is flagged (the guard works in the ordinary case)", { timeout: 20_000 }, async () => {
    const realNow = Date.now();
    const t = await thread(accountA, [
      { id: "p1", at: realNow - 60 * MIN },
      { id: "m1", at: realNow - 40 * MIN },
    ]);
    const m2 = holdBeforeCommit(poolDb);
    const store = storeMessage(m2.db, storeInput(accountA, "m2", t.gmailThreadId, realNow - 20 * MIN));
    await m2.ran;
    await sleep(5);
    const r = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
    const itemId = (r as { itemId: string }).itemId;
    const shown = await reload(itemId);
    m2.release();
    await store;
    expect(await approveItem(database, approveInput(shown))).toEqual({ kind: "blocked", reason: "ack_required" });
    expect(await approveItem(database, approveInput(await reload(itemId)))).toEqual({ kind: "approved" });
    expect((await database.select().from(schema.mailMessages).where(and(eq(schema.mailMessages.threadId, t.thread.id), eq(schema.mailMessages.gmailMessageId, "m2")))).length).toBe(1);
  });
});
