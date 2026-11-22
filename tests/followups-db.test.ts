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
import type { DraftProvider } from "@/lib/ai/types";
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
import { storeMessage, type StoreMessageInput } from "@/lib/gmail/store";
import { toFull } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// phase-2-followups-1 (coder), Postgres only (TEST_DATABASE_URL, a disposable local database):
// - Disconnect vs every audited transition on two real connections, paused right before the
//   transition's first FK-checked insert (AC-DL-2), and a staggered race with retries off (AC-DL-3);
// - E5: post-commit re-check failures are advisory and audited (AC-E5-2/3), and the re-flag guard
//   (AC-E5-4/5) as deterministic interleavings.

const HOST = "alex.example.com";
const MIN = 60_000;
const BIG: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 25, draftMicros: 3_000_000, totalMicros: 3_500_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pgCode = (err: unknown): string => {
  const e = err as { cause?: { code?: string }; code?: string };
  return e?.cause?.code ?? e?.code ?? (err instanceof Error ? err.name : "?");
};

/**
 * An executor whose transactions pause right before their first insert into one of `tables`, until
 * released. Used to hold a transition after its row UPDATE (or its account lock) and before the
 * insert whose FK check needs the account row.
 */
function pauseBeforeFirstInsert(base: Database, tables: unknown[]) {
  let hit = false;
  let onPaused!: () => void;
  const paused = new Promise<void>((r) => (onPaused = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const wrap = (b: object): object => {
    const proxy: object = new Proxy(b, {
      get(t, p) {
        if (p === "then") {
          const then = (t as PromiseLike<unknown>).then.bind(t);
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            (async () => {
              onPaused();
              await released;
            })().then(() => then(res, rej), rej);
        }
        const v = Reflect.get(t, p, t);
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          const out = (v as (...x: unknown[]) => unknown).apply(t, a);
          if (out === t) return proxy;
          return out && typeof out === "object" ? wrap(out) : out;
        };
      },
    });
    return proxy;
  };
  const wrapTx = (tx: object): object =>
    new Proxy(tx, {
      get(t, p) {
        const v = Reflect.get(t, p, t);
        if (p === "insert")
          return (table: unknown) => {
            const b = (v as (x: unknown) => object).call(t, table);
            if (!hit && tables.includes(table)) {
              hit = true;
              return wrap(b);
            }
            return b;
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  const db = new Proxy(base, {
    get(t, p) {
      if (p === "transaction") return (fn: (tx: unknown) => Promise<unknown>, cfg?: unknown) => (t.transaction as (f: unknown, c?: unknown) => Promise<unknown>)((tx: object) => fn(wrapTx(tx)), cfg);
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Database;
  return { db, paused, release, hit: () => hit };
}

describe.skipIf(!testDbUrl)("phase-2-followups-1 (Postgres, two connections)", () => {
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
  const auditActions = async (itemId: string) =>
    (await database.select().from(schema.auditLog).where(sql`${schema.auditLog.detail}->>'itemId' = ${itemId}`)).map((a) => a.action);
  async function compose(accountId: string, ex: Database = database) {
    const r = await proposeNewMessage(ex, { userId, accountId, to: "bob@example.org\ncarol@example.org", cc: "", subject: "Hello", bodyText: "Hi" });
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
      newRecipientLimit: 10,
      ...over,
    };
  };
  /** A stored thread with one message (and optionally more), inserted directly. */
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

  // ---- Disconnect vs audited transitions (AC-DL-2) ------------------------------------------------

  type Race = { transition: { ok: true; value: unknown } | { ok: false; code: string }; disconnect: string; disconnectWaited: boolean; paused: boolean };
  async function raceDisconnect(accountId: string, tables: unknown[], run: (db: Database) => Promise<unknown>): Promise<Race> {
    const g = pauseBeforeFirstInsert(poolDb, tables);
    const transition = run(g.db).then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, code: pgCode(err) }),
    );
    await Promise.race([g.paused, transition]);
    let done = false;
    // Retries off: a deadlock would surface here as 40P01.
    const disconnect = deleteAccount(poolDb, userId, accountId, { attempts: 1 }).then(
      () => ((done = true), "ok"),
      (err: unknown) => ((done = true), `error:${pgCode(err)}`),
    );
    await sleep(250);
    const disconnectWaited = !done;
    g.release();
    return { transition: await transition, disconnect: await disconnect, disconnectWaited, paused: g.hit() };
  }
  const expectClean = (r: Race) => {
    expect(r.paused, "the transition reached its paused insert").toBe(true);
    expect(r.transition).toMatchObject({ ok: true });
    expect(r.disconnect).toBe("ok");
    // The account lock was taken first, so the Disconnect waited for the transition to commit.
    expect(r.disconnectWaited).toBe(true);
  };

  const cases: { name: string; tables: unknown[]; setup: (b: ConnectedAccount) => Promise<(db: Database) => Promise<unknown>>; check: (value: unknown, ctx: { b: ConnectedAccount }) => Promise<void> }[] = [
    {
      name: "approve (item UPDATE, then the charge and audit inserts)",
      tables: [schema.approvalRecipientCharges, schema.auditLog],
      setup: async (b) => {
        const item = await compose(b.id);
        return (db) => approveItem(db, approveInput(item)).then((r) => ({ r, itemId: item.id }));
      },
      check: async (v) => {
        const { r, itemId } = v as { r: { kind: string }; itemId: string };
        expect(r).toEqual({ kind: "approved" });
        expect(await auditActions(itemId)).toContain("approval.approved");
        const charges = await database.select().from(schema.approvalRecipientCharges).where(eq(schema.approvalRecipientCharges.itemId, itemId));
        expect(charges.map((c) => c.newRecipients)).toEqual([2]); // D1: the charge survives the disconnect
        expect(await getOwnItem(database, userId, itemId)).toBeNull();
      },
    },
    {
      name: "edit",
      tables: [schema.auditLog],
      setup: async (b) => {
        const item = await compose(b.id);
        return (db) => editItem(db, { userId, itemId: item.id, revision: item.revision, to: "dave@example.org", cc: "", subject: "Hello", bodyText: "Edited", includeQuote: false }).then((r) => ({ r, itemId: item.id }));
      },
      check: async (v) => {
        const { r, itemId } = v as { r: unknown; itemId: string };
        expect(r).toEqual({ ok: true, revision: 2 });
        expect(await auditActions(itemId)).toContain("approval.edited");
      },
    },
    ...(["reject", "cancel"] as const).map((kind) => ({
      name: kind,
      tables: [schema.auditLog],
      setup: async (b: ConnectedAccount) => {
        const item = await compose(b.id);
        return (db: Database) => (kind === "reject" ? rejectItem : cancelItem)(db, userId, item.id).then((r) => ({ r, itemId: item.id }));
      },
      check: async (v: unknown) => {
        const { r, itemId } = v as { r: boolean; itemId: string };
        expect(r).toBe(true);
        expect(await auditActions(itemId)).toContain(kind === "reject" ? "approval.rejected" : "approval.cancelled");
      },
    })),
    {
      name: "mark not sent",
      tables: [schema.auditLog],
      setup: async (b) => {
        const item = await compose(b.id);
        await database.update(schema.approvalItems).set({ status: "unknown", executingSince: new Date(Date.now() - 60 * MIN) }).where(eq(schema.approvalItems.id, item.id));
        return (db) => markNotSent(db, userId, item.id, new Date()).then((r) => ({ r, itemId: item.id }));
      },
      check: async (v) => {
        const { r, itemId } = v as { r: boolean; itemId: string };
        expect(r).toBe(true);
        expect(await auditActions(itemId)).toContain("approval.marked_not_sent");
      },
    },
    {
      name: "claim",
      tables: [schema.auditLog],
      setup: async (b) => {
        const item = await compose(b.id);
        expect((await approveItem(database, approveInput(item))).kind).toBe("approved");
        return (db) => claimItem(db, userId, item.id).then((r) => ({ r, itemId: item.id }));
      },
      check: async (v) => {
        const { r, itemId } = v as { r: unknown; itemId: string };
        expect(r).toMatchObject({ executionId: expect.any(String) });
        expect(await auditActions(itemId)).toContain("approval.execution_started");
      },
    },
    {
      name: "record outcome (audit, then the outbound queue insert)",
      tables: [schema.auditLog, schema.mailFetchQueue],
      setup: async (b) => {
        const item = await compose(b.id);
        expect((await approveItem(database, approveInput(item))).kind).toBe("approved");
        const claim = (await claimItem(database, userId, item.id))!;
        const claimed = await reload(item.id);
        return (db) => recordOutcome(db, claimed, claim.executionId, { kind: "succeeded", gmailMessageId: "s1", gmailThreadId: "t1" }).then((r) => ({ r, itemId: item.id }));
      },
      check: async (v) => {
        const { r, itemId } = v as { r: boolean; itemId: string };
        expect(r).toBe(true);
        expect(await auditActions(itemId)).toContain("approval.executed");
        expect(await database.select().from(schema.mailFetchQueue)).toEqual([]); // cascaded with the account
      },
    },
    {
      name: "reconciled sent",
      tables: [schema.auditLog],
      setup: async (b) => {
        const item = await compose(b.id);
        await database.update(schema.approvalItems).set({ status: "unknown", messageIdHeader: "<alex.x@alex.example.com>" }).where(eq(schema.approvalItems.id, item.id));
        return (db) => markReconciledSent(db, { id: item.id, userId, accountId: b.id }, { gmailMessageId: "s1", gmailThreadId: "t1" }, "ingest_match").then((r) => ({ r, itemId: item.id }));
      },
      check: async (v) => {
        const { r, itemId } = v as { r: boolean; itemId: string };
        expect(r).toBe(true);
        expect(await auditActions(itemId)).toContain("approval.reconciled");
      },
    },
    {
      name: "stuck to unknown",
      tables: [schema.auditLog],
      setup: async (b) => {
        const item = await compose(b.id);
        await database.update(schema.approvalItems).set({ status: "executing", executingSince: new Date(Date.now() - 60 * MIN) }).where(eq(schema.approvalItems.id, item.id));
        return (db) => markStuckUnknown(db, { id: item.id, userId, accountId: b.id }, new Date()).then((r) => ({ r, itemId: item.id }));
      },
      check: async (v) => {
        const { r, itemId } = v as { r: boolean; itemId: string };
        expect(r).toBe(true);
        expect(await auditActions(itemId)).toContain("approval.reconciled");
      },
    },
    {
      name: "propose a new message (item insert)",
      tables: [schema.approvalItems],
      setup: async (b) => (db) => proposeNewMessage(db, { userId, accountId: b.id, to: "bob@example.org", cc: "", subject: "Hello", bodyText: "Hi" }),
      check: async (v) => {
        const r = v as { ok: boolean; itemId: string };
        expect(r.ok).toBe(true);
        expect(await auditActions(r.itemId)).toContain("approval.proposed");
        expect(await getOwnItem(database, userId, r.itemId)).toBeNull();
      },
    },
    {
      name: "propose a reply (item insert)",
      tables: [schema.approvalItems],
      setup: async (b) => {
        const t = await thread(b, [{ id: "p1", at: Date.now() - 60 * MIN }]);
        return (db) => proposeReply(db, replyInput(t.thread.id, t.messages[0]!.id));
      },
      check: async (v) => {
        const r = v as { ok: boolean; itemId: string };
        expect(r.ok).toBe(true);
        expect(await auditActions(r.itemId)).toContain("approval.proposed");
      },
    },
    {
      name: "start a draft call (abandoned-row sweep UPDATE, then the ai_calls insert)",
      tables: [schema.aiCalls],
      setup: async (b) => {
        const t = await thread(b, [{ id: "p1", at: Date.now() - 60 * MIN }]);
        // A stale pending draft row of this account, so the sweep locks a row the disconnect sets null.
        await database.insert(schema.aiCalls).values({ userId, accountId: b.id, threadId: t.thread.id, purpose: "draft", provider: "fake", model: "claude-opus-5-5", status: "pending", createdAt: new Date(Date.now() - 30 * MIN) });
        return (db) => startDraftCall(db, { userId, accountId: b.id, threadId: t.thread.id, provider: "fake", model: "claude-opus-5-5", now: new Date(), caps: BIG });
      },
      check: async (v) => {
        expect(v).toMatchObject({ kind: "started" });
        const rows = await database.select().from(schema.aiCalls);
        expect(rows.map((r) => [r.status, r.errorCode, r.accountId]).sort()).toEqual([
          ["error", "abandoned", null],
          ["pending", null, null],
        ]);
      },
    },
  ];

  for (const c of cases) {
    it(`AC-DL-2: Disconnect while "${c.name}" is paused before its insert: no deadlock, both complete, consistent`, { timeout: 20_000 }, async () => {
      const b = await makeGoogleAccount(database, userId, { email: "home@example.com" });
      const run = await c.setup(b);
      const r = await raceDisconnect(b.id, c.tables, run);
      expectClean(r);
      await c.check((r.transition as { value: unknown }).value, { b });
      expect(await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, b.id))).toEqual([]);
    });
  }

  it("a transition that starts after a Disconnect has deleted the account finds nothing (no FK error): propose returns not_found, approve (even over the cap) is stale", async () => {
    const b = await makeGoogleAccount(database, userId, { email: "home@example.com" });
    const t = await thread(b, [{ id: "p1", at: Date.now() - 60 * MIN }]);
    const item = await compose(b.id);
    // Disconnect holds the account (its transaction open) while the propose and the approve start.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let deleted!: () => void;
    const deletedP = new Promise<void>((r) => (deleted = r));
    const disc = poolDb.transaction(async (tx) => {
      await tx.delete(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, b.id));
      deleted();
      await held;
    });
    await deletedP;
    const propose = proposeReply(poolDb, replyInput(t.thread.id, t.messages[0]!.id));
    // Limit 0: the approve would be over the daily cap, and must not write a limit audit for a deleted account (FK).
    const approve = approveItem(poolDb, approveInput(item, { newRecipientLimit: 0 }));
    await sleep(150);
    release();
    await disc;
    expect(await propose).toEqual({ ok: false, error: "not_found" });
    expect(await approve).toMatchObject({ kind: "stale" });
  });

  // ---- Staggered race (AC-DL-3) --------------------------------------------------------------------

  it("AC-DL-3: approve vs Disconnect, 4 × 30 staggered rounds with retries off: 0 deadlocks; approved ⇔ charge", { timeout: 240_000 }, async () => {
    const tally = { approved: 0, notApproved: 0, deadlocks: 0, other: [] as string[] };
    for (let round = 0; round < 120; round++) {
      const b = await makeGoogleAccount(database, userId, { email: `b${round}@example.com` });
      const item = await compose(b.id);
      const [res, disc] = await Promise.all([
        (async () => {
          if (round % 4 === 3) await sleep(round % 3);
          try {
            return (await approveItem(poolDb, approveInput(item, { newRecipientLimit: 1_000_000 }))).kind;
          } catch (err) {
            return `error:${pgCode(err)}`;
          }
        })(),
        (async () => {
          await sleep(round % 30);
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
        else if (r.startsWith("error:")) tally.other.push(r);
      }
      const charges = await database.select().from(schema.approvalRecipientCharges).where(eq(schema.approvalRecipientCharges.itemId, item.id));
      const approvedAudit = (await auditActions(item.id)).includes("approval.approved");
      expect(res === "approved", `round ${round}`).toBe(approvedAudit);
      expect(charges.length, `round ${round}`).toBe(approvedAudit ? 1 : 0);
      if (approvedAudit) tally.approved++;
      else tally.notApproved++;
      expect(await getOwnItem(database, userId, item.id)).toBeNull();
    }
    expect(tally.deadlocks).toBe(0);
    expect(tally.other).toEqual([]);
    expect(tally.approved).toBeGreaterThan(0);
    expect(tally.notApproved).toBeGreaterThan(0);
  });

  it("AC-DL-3 (shorter): edit, reject and claim + record outcome vs Disconnect, 20 rounds each: 0 deadlocks", { timeout: 240_000 }, async () => {
    const errors: string[] = [];
    for (const kind of ["edit", "reject", "claim"] as const) {
      for (let round = 0; round < 20; round++) {
        const b = await makeGoogleAccount(database, userId, { email: `${kind}${round}@example.com` });
        let item = await compose(b.id);
        if (kind === "claim") {
          expect((await approveItem(database, approveInput(item, { newRecipientLimit: 1_000_000 }))).kind).toBe("approved");
          item = await reload(item.id);
        }
        const results = await Promise.all([
          (async () => {
            try {
              if (kind === "edit") await editItem(poolDb, { userId, itemId: item.id, revision: item.revision, to: "dave@example.org", cc: "", subject: "Hello", bodyText: "Edited", includeQuote: false });
              else if (kind === "reject") await rejectItem(poolDb, userId, item.id);
              else {
                const c = await claimItem(poolDb, userId, item.id);
                if (c) await recordOutcome(poolDb, (await getOwnItem(poolDb, userId, item.id)) ?? item, c.executionId, { kind: "succeeded", gmailMessageId: `s${round}`, gmailThreadId: `t${round}` });
              }
              return "ok";
            } catch (err) {
              return `error:${pgCode(err)}`;
            }
          })(),
          (async () => {
            await sleep(round % 20);
            try {
              await deleteAccount(poolDb, userId, b.id, { attempts: 1 });
              return "ok";
            } catch (err) {
              return `error:${pgCode(err)}`;
            }
          })(),
        ]);
        for (const r of results) if (r !== "ok") errors.push(`${kind} ${round} ${r}`);
      }
    }
    expect(errors).toEqual([]);
  });

  // ---- E5: advisory post-commit re-checks (AC-E5-2, AC-E5-3) ----------------------------------------

  /** Top-level (non-transaction) UPDATEs of approval_items throw: exactly the post-commit re-flag steps. */
  const brokenPostCommit = (base: Database) =>
    new Proxy(base, {
      get(t, p, r) {
        if (p === "update")
          return (table: unknown) => {
            if (table === schema.approvalItems) throw Object.assign(new Error("Failed query: update approval_items <alice@example.org>"), { cause: { code: "57014" } });
            return t.update(table as never);
          };
        return Reflect.get(t, p, r);
      },
    }) as Database;
  const recheckAudits = async () => (await database.select().from(schema.auditLog).where(eq(schema.auditLog.action, "approval.recheck_failed"))).map((a) => ({ userId: a.userId, accountId: a.accountId, detail: a.detail }));

  it("AC-E5-2/3: a failing post-commit re-check in proposeReply keeps the saved reply, logs and audits ids only", async () => {
    const t = await thread(accountA, [
      { id: "p1", at: Date.now() - 60 * MIN },
      { id: "n1", at: Date.now() - 30 * MIN },
    ]);
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a));
    try {
      const r = await proposeReply(brokenPostCommit(database), replyInput(t.thread.id, t.messages[0]!.id));
      expect(r).toMatchObject({ ok: true });
      const itemId = (r as { itemId: string }).itemId;
      // The in-transaction check already flagged it (a newer message was stored).
      expect((await reload(itemId)).threadChangedAt).not.toBeNull();
      expect(await recheckAudits()).toEqual([{ userId, accountId: accountA.id, detail: { stage: "propose", threadId: t.thread.id, itemId, code: "57014" } }]);
      expect(logs).toEqual([["approval re-check failed", { stage: "propose", accountId: accountA.id, threadId: t.thread.id, itemId, error: "Error", code: "57014" }]]);
      expect(JSON.stringify(logs)).not.toMatch(/alice|Lunch|Hello|Sounds/);
    } finally {
      spy.mockRestore();
    }
  });

  it("AC-E5-2: an AI draft whose post-commit re-check fails is still linked to its ai_calls row and audited as proposed", async () => {
    // A newer message in Trash: not the parent (drafts reply to the newest visible message), but newer.
    const t = await thread(accountA, [
      { id: "p1", at: Date.now() - 60 * MIN },
      { id: "n1", at: Date.now() - 30 * MIN, labels: ["TRASH"] },
    ]);
    const provider: DraftProvider = {
      id: "anthropic-opus",
      draft: async () => ({ status: "ok", body: "Sounds good.", notes: "", errorCode: null, usage: { ...emptyUsage("anthropic-opus", "claude-opus-5-5", 5), inputTokens: 1_000, outputTokens: 100 } }),
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await draftReply({ db: brokenPostCommit(database), provider, caps: BIG }, { userId, threadId: t.thread.id, mode: "reply", instruction: null });
      expect(r).toMatchObject({ ok: true });
      const itemId = (r as { itemId: string }).itemId;
      const [call] = await database.select().from(schema.aiCalls);
      expect(call).toMatchObject({ status: "ok", approvalItemId: itemId, errorCode: null });
      const actions = (await database.select().from(schema.auditLog)).map((a) => a.action);
      expect(actions).toContain("ai.draft_proposed");
      expect(await recheckAudits()).toEqual([{ userId, accountId: accountA.id, detail: { stage: "propose", threadId: t.thread.id, itemId, code: "57014" } }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("AC-E5-3 (ingest): a failing post-commit step after storeMessage keeps the message and audits ids only", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - 60 * MIN }]);
    const r = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a));
    try {
      const stored = await storeMessage(brokenPostCommit(database), storeInput(accountA, "m2", t.gmailThreadId, Date.now() - MIN));
      expect(stored).toMatchObject({ threadId: t.thread.id, inserted: true });
      // The in-transaction flag still ran (and committed with the message).
      expect((await reload((r as { itemId: string }).itemId)).threadChangedAt).not.toBeNull();
      expect(await recheckAudits()).toEqual([{ userId, accountId: accountA.id, detail: { stage: "ingest", threadId: t.thread.id, code: "57014" } }]);
      expect(logs).toEqual([["approval re-check failed", { stage: "ingest", accountId: accountA.id, threadId: t.thread.id, itemId: null, error: "Error", code: "57014" }]]);
    } finally {
      spy.mockRestore();
    }
  });

  // ---- E5: the re-flag guard (AC-E5-4, AC-E5-5) -----------------------------------------------------

  it("AC-E5-4: the post-commit step doesn't touch an item its own in-transaction step flagged; a page rendered in between approves", async () => {
    const t = await thread(accountA, [{ id: "p1", at: Date.now() - 60 * MIN }]);
    const r = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
    const itemId = (r as { itemId: string }).itemId;
    const xmin = async () => (await database.execute<{ x: string }>(sql`select xmin::text as x from approval_items where id = ${itemId}`))[0]!.x;
    let between: { shown: Date | null; xmin: string } | null = null;
    // Runs storeMessage normally, but reads the item after its transaction commits and before the post-commit step.
    const observed = new Proxy(poolDb, {
      get(tt, p) {
        if (p === "transaction")
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            const out = await tt.transaction(fn as never);
            between = { shown: (await reload(itemId)).threadChangedAt, xmin: await xmin() };
            return out;
          };
        const v = Reflect.get(tt, p, tt);
        return typeof v === "function" ? v.bind(tt) : v;
      },
    }) as Database;
    await storeMessage(observed, storeInput(accountA, "m2", t.gmailThreadId, Date.now() - MIN));
    expect(between!.shown).not.toBeNull();
    const after = await reload(itemId);
    expect(after.threadChangedAt!.getTime()).toBe(between!.shown!.getTime());
    expect(await xmin(), "the post-commit UPDATE matched no row").toBe(between!.xmin);
    // The owner's page showed the flag set by the in-transaction step: approving with it (and the tick) works.
    expect(await approveItem(database, approveInput({ ...after, threadChangedAt: between!.shown }))).toEqual({ kind: "approved" });
  });

  it("AC-E5-5: an item created with an older flag (T1) while a newer message M2 is between its two steps is re-flagged by M2's post-commit step", { timeout: 20_000 }, async () => {
    const t = await thread(accountA, [
      { id: "p1", at: Date.now() - 60 * MIN },
      { id: "m1", at: Date.now() - 40 * MIN },
    ]);
    // M2's transaction runs its in-transaction hook (no item yet) and then waits before committing.
    let hookRan!: () => void;
    const hookRanP = new Promise<void>((r) => (hookRan = r));
    let release!: () => void;
    const releaseP = new Promise<void>((r) => (release = r));
    const holdCommit = new Proxy(poolDb, {
      get(tt, p) {
        if (p === "transaction")
          return (fn: (tx: unknown) => Promise<unknown>) =>
            tt.transaction(async (tx) => {
              const out = await fn(tx);
              hookRan();
              await releaseP;
              return out as never;
            });
        const v = Reflect.get(tt, p, tt);
        return typeof v === "function" ? v.bind(tt) : v;
      },
    }) as Database;
    const store = storeMessage(holdCommit, storeInput(accountA, "m2", t.gmailThreadId, Date.now() - 20 * MIN));
    await hookRanP;
    // The reply to p1 sees m1 (committed), so it is created with T1; its own re-check (IS NULL) leaves T1.
    const r = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
    const itemId = (r as { itemId: string }).itemId;
    const shown = await reload(itemId);
    const t1 = shown.threadChangedAt;
    expect(t1).not.toBeNull();
    release();
    await store;
    const after = await reload(itemId);
    expect(after.threadChangedAt!.getTime(), "M2's post-commit step moved the flag past T1").not.toBe(t1!.getTime());
    // The page that showed T1 (and not M2) can't approve: the owner sees the warning again.
    expect(await approveItem(database, approveInput(shown))).toEqual({ kind: "blocked", reason: "ack_required" });
    const ok = await approveItem(database, approveInput(after));
    expect(ok).toEqual({ kind: "approved" });
    expect((await database.select().from(schema.mailMessages).where(and(eq(schema.mailMessages.threadId, t.thread.id), eq(schema.mailMessages.gmailMessageId, "m2")))).length).toBe(1);
  });

  // ---- Round 2 ---------------------------------------------------------------------------------------

  it("round 2 (D1): with the clock frozen, M2's post-commit re-flag still moves T1 strictly forward (+1 ms), so the T1 page can't approve", { timeout: 20_000 }, async () => {
    const realNow = Date.now();
    const t = await thread(accountA, [
      { id: "p1", at: realNow - 60 * MIN },
      { id: "m1", at: realNow - 40 * MIN },
    ]);
    vi.useFakeTimers({ toFake: ["Date"], now: realNow });
    try {
      let hookRan!: () => void;
      const hookRanP = new Promise<void>((r) => (hookRan = r));
      let release!: () => void;
      const releaseP = new Promise<void>((r) => (release = r));
      const holdCommit = new Proxy(poolDb, {
        get(tt, p) {
          if (p === "transaction")
            return (fn: (tx: unknown) => Promise<unknown>) =>
              tt.transaction(async (tx) => {
                const out = await fn(tx);
                hookRan();
                await releaseP;
                return out as never;
              });
          const v = Reflect.get(tt, p, tt);
          return typeof v === "function" ? v.bind(tt) : v;
        },
      }) as Database;
      const store = storeMessage(holdCommit, storeInput(accountA, "m2", t.gmailThreadId, realNow - 20 * MIN));
      await hookRanP;
      const r = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
      const itemId = (r as { itemId: string }).itemId;
      const shown = await reload(itemId);
      expect(shown.threadChangedAt!.getTime()).toBe(realNow); // T1 = the frozen clock
      release(); // the clock does not move
      await store;
      const after = await reload(itemId);
      expect(after.threadChangedAt!.getTime()).toBe(realNow + 1);
      expect(await approveItem(database, approveInput(shown))).toEqual({ kind: "blocked", reason: "ack_required" });
      // The value stays on a whole millisecond, so a page showing it approves.
      expect(await approveItem(database, approveInput(after))).toEqual({ kind: "approved" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("round 2 (D1): two messages flagging the same item in the same millisecond each move it strictly forward", async () => {
    const realNow = Date.now();
    const t = await thread(accountA, [{ id: "p1", at: realNow - 60 * MIN }]);
    const r = await proposeReply(database, replyInput(t.thread.id, t.messages[0]!.id));
    const itemId = (r as { itemId: string }).itemId;
    vi.useFakeTimers({ toFake: ["Date"], now: realNow });
    try {
      await storeMessage(database, storeInput(accountA, "m2", t.gmailThreadId, realNow - 20 * MIN));
      const first = (await reload(itemId)).threadChangedAt!.getTime();
      await storeMessage(database, storeInput(accountA, "m3", t.gmailThreadId, realNow - 10 * MIN));
      const second = (await reload(itemId)).threadChangedAt!.getTime();
      expect(first).toBe(realNow);
      expect(second).toBe(realNow + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("round 2 (O1): a draft started after the account was deleted returns not_found, writes no ai_calls row and calls no provider", async () => {
    const b = await makeGoogleAccount(database, userId, { email: "home@example.com" });
    const t = await thread(b, [{ id: "p1", at: Date.now() - 60 * MIN }]);
    expect(await startDraftCall(database, { userId, accountId: b.id, threadId: t.thread.id, provider: "fake", model: "claude-opus-5-5", now: new Date(), caps: BIG })).toEqual({ kind: "started", callId: expect.any(String) });
    await database.delete(schema.aiCalls);
    // The thread page was loaded; the Disconnect commits between replyContext and startDraftCall.
    let calls = 0;
    const provider: DraftProvider = {
      id: "anthropic-opus",
      draft: async () => {
        calls++;
        return { status: "ok", body: "x", notes: "", errorCode: null, usage: emptyUsage("anthropic-opus", "claude-opus-5-5") };
      },
    };
    const deleteFirst = new Proxy(database, {
      get(tt, p) {
        if (p === "transaction")
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            await deleteAccount(poolDb, userId, b.id, { attempts: 1 });
            return tt.transaction(fn as never);
          };
        const v = Reflect.get(tt, p, tt);
        return typeof v === "function" ? v.bind(tt) : v;
      },
    }) as Database;
    // phase-2-followups-2 (O2, owner Q7): this case now answers account_disconnected (was not_found).
    expect(await draftReply({ db: deleteFirst, provider, caps: BIG }, { userId, threadId: t.thread.id, mode: "reply", instruction: null })).toEqual({ ok: false, code: "account_disconnected" });
    expect(calls).toBe(0);
    expect(await database.select().from(schema.aiCalls)).toEqual([]);
    expect(await startDraftCall(database, { userId, accountId: b.id, threadId: t.thread.id, provider: "fake", model: "claude-opus-5-5", now: new Date(), caps: BIG })).toEqual({ kind: "not_found" });
  });
});
