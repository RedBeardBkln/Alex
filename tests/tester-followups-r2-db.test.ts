import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ApprovalItem, ConnectedAccount } from "@/db/schema";
import { emailSendPayload } from "@/lib/approvals/payload";
import { approveItem, getOwnItem, proposeReply } from "@/lib/approvals/service";
import { parseMessage } from "@/lib/gmail/mime";
import { storeMessage, type StoreMessageInput } from "@/lib/gmail/store";
import { toFull } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester, phase-2-followups-1 round 2 (Postgres only, a disposable local database): the D1 fix
// (strictly-later whole-millisecond flags, post-commit exclusion of the message's own ids) under
// frozen and backwards clocks, several messages racing on separate connections, exact round trips
// through the page's epoch ms, and no double write for a message's own items.

const HOST = "alex.example.com";
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!testDbUrl)("tester round 2: D1 strictly-later flags (Postgres, several connections)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;
  let userId: string;
  let account: ConnectedAccount;

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
    account = await makeGoogleAccount(database, userId, { email: "work@example.com" });
  });

  const reload = async (id: string) => (await getOwnItem(database, userId, id))!;
  const approveInput = (item: ApprovalItem, shown: Date | null): Parameters<typeof approveItem>[1] => {
    emailSendPayload.parse(item.payload);
    return {
      userId,
      itemId: item.id,
      revision: item.revision,
      contentHash: item.contentHash,
      ackThreadChange: shown !== null,
      shownThreadChangedAt: shown ? shown.getTime() : null,
      messageIdHost: HOST,
      newRecipientLimit: 1_000_000,
    };
  };
  async function thread(messages: { id: string; at: number }[]) {
    const gt = `gt-${Math.random().toString(36).slice(2)}`;
    const [t] = await database
      .insert(schema.mailThreads)
      .values({ userId, accountId: account.id, gmailThreadId: gt, subject: "Lunch", lastMessageAt: new Date(), messageCount: messages.length, inInbox: true, hasUnread: false })
      .returning();
    const rows = [];
    for (const m of messages) {
      const [row] = await database
        .insert(schema.mailMessages)
        .values({
          userId,
          accountId: account.id,
          threadId: t!.id,
          gmailMessageId: m.id,
          gmailThreadId: gt,
          internalDate: new Date(m.at),
          labelIds: ["INBOX"],
          isSent: false,
          subject: "Lunch",
          fromHeader: "Alice <alice@example.org>",
          toHeader: account.email,
          rfc822MessageId: `<${m.id}@mail.example.org>`,
          headers: [],
          bodyText: "Hello",
        })
        .returning();
      rows.push(row!);
    }
    return { thread: t!, gmailThreadId: gt, messages: rows };
  }
  const reply = async (threadId: string, parentId: string) => {
    const r = await proposeReply(database, { userId, threadId, parentMessageId: parentId, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "Sounds good", includeQuote: false });
    if (!r.ok) throw new Error(r.error);
    return r.itemId;
  };
  const storeInput = (id: string, gmailThreadId: string, at: number): StoreMessageInput => {
    const full = toFull({ id, threadId: gmailThreadId, labelIds: ["INBOX"], internalDate: at, from: "Alice <alice@example.org>" });
    return {
      account,
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
  const raw = async (itemId: string) =>
    (await database.execute<{ us: string; xmin: string; v: string | null }>(sql`select (extract(epoch from thread_changed_at) * 1000000)::bigint::text as us, xmin::text as xmin, thread_changed_at::text as v from approval_items where id = ${itemId}`))[0]!;
  const wholeMs = (us: string) => BigInt(us) % 1000n === 0n;

  it("three messages on three connections flag one item in the same frozen millisecond (clock never moves): X, X+1, X+2; every older page is blocked, the newest approves", { timeout: 30_000 }, async () => {
    const now = Date.now();
    const t = await thread([{ id: "p1", at: now - 60 * MIN }]);
    const itemId = await reply(t.thread.id, t.messages[0]!.id);
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      // M2 flags and is held before commit; M3 and M4 start meanwhile and must wait on its row locks.
      const m2 = holdBeforeCommit(poolDb);
      const s2 = storeMessage(m2.db, storeInput("m2", t.gmailThreadId, now - 3 * MIN));
      await m2.ran;
      const s3 = storeMessage(poolDb, storeInput("m3", t.gmailThreadId, now - 2 * MIN));
      const s4 = storeMessage(poolDb, storeInput("m4", t.gmailThreadId, now - MIN));
      const seen = new Set<number>();
      let done = false;
      const poll = (async () => {
        while (!done) {
          const v = (await reload(itemId)).threadChangedAt;
          if (v) seen.add(v.getTime());
          await sleep(2);
        }
      })();
      await sleep(150);
      m2.release();
      await Promise.all([s2, s3, s4]);
      done = true;
      await poll;
      const final = (await reload(itemId)).threadChangedAt!;
      const r = await raw(itemId);
      expect(wholeMs(r.us), `stored ${r.v}`).toBe(true);
      expect(final.getTime()).toBe(now + 2); // three strictly-later whole-ms values from one frozen clock
      for (const v of seen) expect(v).toBeLessThanOrEqual(final.getTime());
      const item = await reload(itemId);
      for (const old of [null, now, now + 1, ...seen].filter((v) => v !== final.getTime())) {
        expect(await approveItem(database, approveInput(item, old === null ? null : new Date(old))), `page showing ${old === null ? "nothing" : old - now}`).toEqual({ kind: "blocked", reason: "ack_required" });
      }
      expect(await approveItem(database, approveInput(item, final))).toEqual({ kind: "approved" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the clock jumps backwards between flags: each new flag is still strictly later than the stored one, a whole millisecond, and old pages are blocked", { timeout: 30_000 }, async () => {
    const now = Date.now();
    const t = await thread([{ id: "p1", at: now - 60 * MIN }]);
    const itemId = await reply(t.thread.id, t.messages[0]!.id);
    vi.useFakeTimers({ toFake: ["Date"], now });
    const values: number[] = [];
    try {
      const clocks = [0, -10_000, -10_000, 5, -1, 3_600_000, 0];
      for (let i = 0; i < clocks.length; i++) {
        vi.setSystemTime(now + clocks[i]!);
        await storeMessage(poolDb, storeInput(`b${i}`, t.gmailThreadId, now - (30 - i) * MIN));
        const r = await raw(itemId);
        expect(wholeMs(r.us), `stored ${r.v}`).toBe(true);
        values.push((await reload(itemId)).threadChangedAt!.getTime());
      }
    } finally {
      vi.useRealTimers();
    }
    for (let i = 1; i < values.length; i++) expect(values[i]!, `flag ${i}`).toBeGreaterThan(values[i - 1]!);
    expect(values.map((v) => v - now)).toEqual([0, 1, 2, 5, 6, 3_600_000, 3_600_001]);
    const item = await reload(itemId);
    for (const old of values.slice(0, -1)) expect(await approveItem(database, approveInput(item, new Date(old)))).toEqual({ kind: "blocked", reason: "ack_required" });
    expect(await approveItem(database, approveInput(item, new Date(values.at(-1)!)))).toEqual({ kind: "approved" });
  });

  it("a normally flagged item (real clock) round-trips exactly through the page's epoch ms and approves with the tick; without the tick it asks", async () => {
    const now = Date.now();
    const t = await thread([{ id: "p1", at: now - 60 * MIN }]);
    const itemId = await reply(t.thread.id, t.messages[0]!.id);
    await storeMessage(database, storeInput("n1", t.gmailThreadId, now - MIN));
    await storeMessage(database, storeInput("n2", t.gmailThreadId, now - MIN / 2));
    const r = await raw(itemId);
    expect(wholeMs(r.us), `stored ${r.v}`).toBe(true);
    const item = await reload(itemId);
    expect(BigInt(item.threadChangedAt!.getTime()) * 1000n).toBe(BigInt(r.us)); // the page value is the stored value
    expect(await approveItem(database, { ...approveInput(item, item.threadChangedAt), ackThreadChange: false })).toEqual({ kind: "blocked", reason: "ack_required" });
    expect(await approveItem(database, approveInput(item, item.threadChangedAt))).toEqual({ kind: "approved" });
  });

  it("AC-E5-4 round 2: M2's post-commit step moves its own item once and re-flags an item created between its two steps", { timeout: 20_000 }, async () => {
    const now = Date.now();
    const t = await thread([
      { id: "p1", at: now - 60 * MIN },
      { id: "p2", at: now - 50 * MIN },
    ]);
    const ownA = await reply(t.thread.id, t.messages[0]!.id); // flagged by p2 already
    const before = await raw(ownA);
    const m2 = holdBeforeCommit(poolDb);
    const s2 = storeMessage(m2.db, storeInput("m2", t.gmailThreadId, now - 10 * MIN));
    await m2.ran;
    // Created while M2 is uncommitted: M2's in-transaction UPDATE can't see it.
    const between = await reply(t.thread.id, t.messages[1]!.id);
    const betweenShown = (await reload(between)).threadChangedAt;
    m2.release();
    await s2;
    const a = await raw(ownA);
    expect(a.v).not.toBe(before.v); // M2's in-transaction step moved it once
    const b = await reload(between);
    expect(b.threadChangedAt).not.toBeNull();
    expect(b.threadChangedAt!.getTime()).not.toBe(betweenShown?.getTime() ?? null);
    expect(await approveItem(database, approveInput(b, betweenShown))).toEqual({ kind: "blocked", reason: "ack_required" });
  });

  it("AC-E5-4 round 2, xmin across the post-commit step: an own item's row version is the one M2's transaction committed", { timeout: 20_000 }, async () => {
    const now = Date.now();
    const t = await thread([{ id: "p1", at: now - 60 * MIN }]);
    const own = await reply(t.thread.id, t.messages[0]!.id);
    let atCommit: string | null = null;
    const observed = new Proxy(poolDb, {
      get(tt, p) {
        if (p === "transaction")
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            const out = await tt.transaction(fn as never);
            atCommit = (await raw(own)).xmin;
            return out;
          };
        const v = Reflect.get(tt, p, tt);
        return typeof v === "function" ? v.bind(tt) : v;
      },
    }) as Database;
    await storeMessage(observed, storeInput("m2", t.gmailThreadId, now - MIN));
    expect(atCommit).not.toBeNull();
    expect((await raw(own)).xmin, "the post-commit UPDATE didn't rewrite the message's own item").toBe(atCommit);
  });

  it("the reply-side post-commit re-check still writes only where thread_changed_at IS NULL (static, CRLF-tolerant)", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "..", "src", "lib", "approvals", "service.ts"), "utf8").split(String.fromCharCode(13)).join("");
    const body = src.slice(src.indexOf("export async function proposeReply"), src.indexOf("export async function proposeNewMessage"));
    expect(body).toMatch(/\.set\(\{ threadChangedAt: new Date\(\) \}\)\s*\.where\(and\(eq\(approvalItems\.id, itemId\), isNull\(approvalItems\.threadChangedAt\)/);
  });
});
