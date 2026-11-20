import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import type { Caps } from "@/lib/ai-ledger/config";
import { emptyUsage, type AiUsage } from "@/lib/ai-ledger/ledger";
import { costUsdMicros, DRAFT_RESERVED_COST_MICROS } from "@/lib/ai-ledger/pricing";
import { draftReply } from "@/lib/ai/draft";
import { cleanDraftBody } from "@/lib/ai/parse";
import { DRAFT_MAX_TOKENS, THREAD_TEXT_CAP } from "@/lib/ai/prompts";
import type { DraftInput, DraftOutcome, DraftProvider } from "@/lib/ai/types";
import { emailSendPayload } from "@/lib/approvals/payload";
import { getOwnItem, proposeReply } from "@/lib/approvals/service";
import { invisibleCharacters } from "@/lib/approvals/warnings";
import { getSyncState } from "@/lib/gmail/store";
import { syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { FakeGmail, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Phase 2c round 3: E1 (C1 controls), E2 (the Q6 check vs a concurrently committed message) and E3
// (in-flight drafts reserve their worst-case cost). Fake Gmail and fake providers; no live calls.

const HOUR = 3_600_000;
const C1 = Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x80 + i)).join("");
const OPUS_USAGE = (): AiUsage => ({ ...emptyUsage("anthropic-opus", "claude-opus-5-5", 30), inputTokens: 8_000, outputTokens: 3_000, requestId: "r" }); // 92,000 micro-dollars

describe("E1 and E3 constants (unit)", () => {
  it("cleanDraftBody removes C1 controls; the warning lists C1 in any body", () => {
    expect(cleanDraftBody(`a${C1}b\n\tc`)).toBe("ab\n\tc");
    const f = invisibleCharacters(`x${String.fromCharCode(0x85)}y${String.fromCharCode(0x9b)}`);
    expect(f.items).toEqual([
      { codePoint: "U+0085", index: 1 },
      { codePoint: "U+009B", index: 3 },
    ]);
  });

  it("the reserved draft cost is Opus at max_tokens output plus the thread cap as input (one token per character + 2,000)", () => {
    expect(DRAFT_MAX_TOKENS).toBe(16_000);
    expect(THREAD_TEXT_CAP).toBe(30_000);
    expect(DRAFT_RESERVED_COST_MICROS).toBe(costUsdMicros("claude-opus-5-5", { inputTokens: THREAD_TEXT_CAP + 2_000, outputTokens: DRAFT_MAX_TOKENS, cacheWriteTokens: 0, cacheReadTokens: 0 }));
    expect(DRAFT_RESERVED_COST_MICROS).toBe(448_000);
  });
});

describe.skipIf(!testDbUrl)("round 3 (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let otherClient: ReturnType<typeof postgres>;
  let other: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    // A second, independent pool: a sync that commits while proposeReply's transaction is open.
    otherClient = postgres(testDbUrl!, { max: 4, onnotice: () => {} });
    other = drizzle(otherClient, { schema });
  });
  afterAll(async () => {
    await otherClient.end();
    await client.end();
  });

  const syncDeps = (db: Database): SyncDeps => ({
    db,
    gmailFor: () => gmail,
    now: () => new Date(clock),
    sleep: async () => {},
    unitsPerMinute: 1e9,
    render: async (body, opts) => ({
      renderKind: body.html ? "text" : "none",
      renderReason: body.html ? "worker_unavailable" : null,
      renderedHtml: null,
      renderedHtmlRemote: null,
      renderedText: body.text,
      renderTruncated: false,
      sanitizerVersion: body.html ? null : opts.version,
      renderedAt: new Date(clock),
    }),
  });
  const reload = async () => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
  async function runUntilEmpty() {
    for (let i = 0; i < 20; i++) {
      await syncAccount(syncDeps(database), await reload(), "cron");
      const q = await database.select().from(schema.mailFetchQueue).where(eq(schema.mailFetchQueue.accountId, account.id));
      if ((await getSyncState(database, account.id))?.backfillStatus === "complete" && q.length === 0) return;
      clock += 5 * 60_000;
    }
  }
  const msg = (over: Partial<FakeMessage> & { id: string }): FakeMessage => ({ threadId: "gt1", labelIds: ["INBOX"], internalDate: clock - HOUR, from: "Alice <alice@example.org>", ...over });
  const threads = async () => database.select().from(schema.mailThreads).orderBy(asc(schema.mailThreads.gmailThreadId));
  const parentOf = async (threadId: string) =>
    (await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.threadId, threadId)).orderBy(asc(schema.mailMessages.internalDate)))[0]!;

  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com" });
    gmail = new FakeGmail();
    clock = Date.now();
  });

  it("E1: C1 controls never reach an AI body, even from a provider that doesn't clean; manual 2b text with C1 is kept but flagged", async () => {
    gmail.seed(msg({ id: "p1" }));
    await runUntilEmpty();
    const [thread] = await threads();
    const provider: DraftProvider = {
      id: "local",
      draft: async () => ({ status: "ok", body: `a${C1}b`, notes: "", errorCode: null, usage: OPUS_USAGE() }),
    };
    const r = await draftReply({ db: database, provider, now: () => new Date(clock) }, { userId, threadId: thread!.id, mode: "reply", instruction: null });
    const p = emailSendPayload.parse((await getOwnItem(database, userId, (r as { itemId: string }).itemId))!.payload);
    expect(p.bodyText).toBe("ab");
    // Manual reply: accepted as typed (2b rules), and the approval page's warning lists the C1 characters.
    const parent = await parentOf(thread!.id);
    const m = await proposeReply(database, { userId, threadId: thread!.id, parentMessageId: parent.id, to: "alice@example.org", cc: "", subject: "Re: x", bodyText: `hi${String.fromCharCode(0x85)}there`, includeQuote: false });
    const mp = emailSendPayload.parse((await getOwnItem(database, userId, (m as { itemId: string }).itemId))!.payload);
    expect(invisibleCharacters(mp.bodyText).count).toBe(1);
  });

  it("E2: a newer message committed by another connection while the reply is being saved is always flagged", { timeout: 30_000 }, async () => {
    gmail.seed(msg({ id: "p1", internalDate: clock - 2 * HOUR }));
    await runUntilEmpty();
    const [thread] = await threads();
    const parent = await parentOf(thread!.id);
    let concurrentSync: Promise<unknown> | null = null;
    let visibleDuringInsert: number | null = null;

    // Proxy the executor: just before proposeReply's INSERT, another pool delivers and syncs a
    // newer message (the tester's interleaving), and we look at what it has committed meanwhile.
    const sideEffect = async () => {
      clock += 60_000;
      gmail.deliver(msg({ id: "race1", internalDate: clock }));
      // The single-connection test client is inside the reply transaction: read through the other pool.
      const [acct] = await other.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id));
      concurrentSync = syncAccount(syncDeps(other), acct!, "push");
      await new Promise((r) => setTimeout(r, 400));
      visibleDuringInsert = (await other.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "race1"))).length;
    };
    const wrapInsert = (tx: unknown) =>
      new Proxy(tx as object, {
        get(t, prop, receiver) {
          const v = Reflect.get(t, prop, receiver);
          if (prop !== "insert") return typeof v === "function" ? v.bind(t) : v;
          return (table: unknown) => {
            const builder = (v as (x: unknown) => { values: (...a: unknown[]) => unknown }).call(t, table);
            if (table !== schema.approvalItems) return builder;
            return {
              values: (...a: unknown[]) => {
                const withValues = (builder.values as (...x: unknown[]) => { returning: (...r: unknown[]) => PromiseLike<unknown> })(...a);
                return {
                  returning: (...r: unknown[]) => {
                    const q = withValues.returning(...r);
                    return { then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => sideEffect().then(() => q).then(res, rej) };
                  },
                };
              },
            };
          };
        },
      });
    const proxied = new Proxy(database, {
      get(t, prop, receiver) {
        if (prop === "transaction") return (fn: (tx: unknown) => Promise<unknown>) => t.transaction((tx) => fn(wrapInsert(tx)) as never);
        const v = Reflect.get(t, prop, receiver);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Database;

    const r = await proposeReply(proxied, { userId, threadId: thread!.id, parentMessageId: parent.id, to: "alice@example.org", cc: "", subject: "Re: x", bodyText: "hi", includeQuote: false });
    expect(r.ok).toBe(true);
    await concurrentSync;
    // The concurrent sync committed while the reply's transaction was still open (its hook couldn't
    // see the item)...
    expect(visibleDuringInsert).toBe(1);
    // ...and proposeReply's post-commit re-check saw the message and raised the warning.
    expect((await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "race1"))).length).toBe(1);
    expect((await getOwnItem(database, userId, (r as { itemId: string }).itemId))!.threadChangedAt).not.toBeNull();
  });

  it("E2, the other interleaving: the message's transaction runs its hook first but commits after the reply's post-commit re-check", { timeout: 30_000 }, async () => {
    gmail.seed(msg({ id: "p1", internalDate: clock - 2 * HOUR }));
    await runUntilEmpty();
    const [thread] = await threads();
    const parent = await parentOf(thread!.id);

    // Hold the commit of the other pool's storeMessage transaction (the one that inserts the message)
    // until the reply has been saved and re-checked.
    let hookRan!: () => void;
    const hookRanP = new Promise<void>((r) => (hookRan = r));
    let release!: () => void;
    const releaseP = new Promise<void>((r) => (release = r));
    const gatedOther = new Proxy(other, {
      get(t, prop, receiver) {
        if (prop === "transaction") {
          return (fn: (tx: unknown) => Promise<unknown>) =>
            t.transaction(async (tx) => {
              let insertsMessage = false;
              const spy = new Proxy(tx as object, {
                get(tt, pp, rr) {
                  const v = Reflect.get(tt, pp, rr);
                  if (pp === "insert") return (table: unknown) => ((insertsMessage ||= table === schema.mailMessages), (v as (x: unknown) => unknown).call(tt, table));
                  return typeof v === "function" ? v.bind(tt) : v;
                },
              });
              const out = await fn(spy);
              if (insertsMessage) {
                hookRan(); // the in-transaction hook has run and saw no item
                await releaseP; // ...and the commit waits
              }
              return out as never;
            });
        }
        const v = Reflect.get(t, prop, receiver);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Database;

    clock += 60_000;
    gmail.deliver(msg({ id: "race2", internalDate: clock }));
    const [acct] = await other.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id));
    const sync = syncAccount(syncDeps(gatedOther), acct!, "push");
    await hookRanP;
    const r = await proposeReply(database, { userId, threadId: thread!.id, parentMessageId: parent.id, to: "alice@example.org", cc: "", subject: "Re: x", bodyText: "hi", includeQuote: false });
    // Neither the in-transaction check nor the post-commit re-check could see the uncommitted message.
    expect((await getOwnItem(database, userId, (r as { itemId: string }).itemId))!.threadChangedAt).toBeNull();
    release();
    await sync;
    // The message's post-commit step (afterMessageCommitted) saw the committed item and flagged it.
    expect((await getOwnItem(database, userId, (r as { itemId: string }).itemId))!.threadChangedAt).not.toBeNull();
  });

  it("E3: four parallel drafts against a nearly reached dollar cap make one call: no more overshoot than one sequential call (in-flight drafts reserve their worst case)", async () => {
    for (let i = 0; i < 4; i++) gmail.seed(msg({ id: `t${i}`, threadId: `gt${i}` }));
    await runUntilEmpty();
    const ts = await threads();
    expect(ts).toHaveLength(4);
    // Already spent today: $1.00, just under a $1.00001 cap (nearly reached).
    await database.insert(schema.aiCalls).values({ userId, accountId: account.id, purpose: "draft", provider: "anthropic-opus", model: "claude-opus-5-5", status: "ok", costUsdMicros: 1_000_000, createdAt: new Date(clock) });
    const cap = 1_000_010;
    const caps: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 25, draftMicros: cap, totalMicros: 10_000_000 };
    let calls = 0;
    const provider: DraftProvider = {
      id: "anthropic-opus",
      draft: async (_input: DraftInput): Promise<DraftOutcome> => {
        calls++;
        await new Promise((r) => setTimeout(r, 100));
        return { status: "ok", body: "Fine.", notes: "", errorCode: null, usage: OPUS_USAGE() };
      },
    };
    const results = await Promise.all(ts.map((t) => draftReply({ db: database, provider, now: () => new Date(clock), caps }, { userId, threadId: t.id, mode: "reply", instruction: null })));
    expect(calls).toBe(1);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok && x.code === "capped")).toHaveLength(3);
    // The one call that started (estimate below the cap) is the only overshoot, as for a sequential
    // call; without the reserve all four would have started (round 2 measured that overshoot).
    const spent = (await database.select().from(schema.aiCalls)).reduce((s, c) => s + (c.costUsdMicros ?? 0), 0);
    expect(spent).toBe(1_000_000 + 92_000);
    expect(spent - cap).toBeLessThanOrEqual(DRAFT_RESERVED_COST_MICROS);
    // At the cap now: still capped.
    expect(await draftReply({ db: database, provider, now: () => new Date(clock), caps }, { userId, threadId: ts[1]!.id, mode: "reply", instruction: null })).toEqual({ ok: false, code: "capped" });
  });
});
