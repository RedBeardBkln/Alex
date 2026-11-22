import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { appendFileSync } from "node:fs";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { deleteAccount, upsertGoogleAccount } from "@/lib/accounts";
import { utcDayStart } from "@/lib/ai-ledger/config";
import { executeClaimed, type ExecutorDeps, type Sender } from "@/lib/approvals/execute";
import { contentHash, emailSendPayload } from "@/lib/approvals/payload";
import {
  cancelItem,
  claimItem,
  editItem,
  getItemView,
  getOwnItem,
  markNotSent,
  proposeNewMessage,
  proposeReply,
  rejectItem,
  type NewMessageInput,
} from "@/lib/approvals/service";
import { approveAndSend, approveItem } from "./helpers/approve";
import { newRecipientsUsedToday, seenAddresses } from "@/lib/approvals/seen";
import type { SendOutcome } from "@/lib/gmail/send";
import { deferQueueRow, dropQueueRow, dueQueueRows, enqueueMessages, enqueueOutbound, failQueueRow, getSyncState, PARKED_AT } from "@/lib/gmail/store";
import { syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { FakeGmail } from "./mail-fixtures";
import { TEST_KEY } from "./setup-env";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester (phase 2d, compose) with Postgres and a fake sender. Attacks the account checks, the
// confirmation set, the daily cap (real races on a 12-connection pool, UTC boundaries, release,
// env wiring), the Q3 amendment, the R8 constraint gap, outbound ingestion races, the sent-thread
// link, the audit and the cost of the "seen" lookup. No live Google.

// Read once by newRecipientLimit() -> env(): an invalid value must fall back to the default 10.
process.env.EMAIL_NEW_RECIPIENTS_PER_DAY = "ten please";

const HOST = "alex.example.com";
const DAY = 86_400_000;
const SCRATCH = process.env.TESTER_SCRATCH;
const note = (s: string) => {
  if (SCRATCH) appendFileSync(SCRATCH, s + "\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause;
    return String(cause?.message ?? (err as Error).message);
  }
  return "no error";
}

describe.skipIf(!testDbUrl)("tester: compose (Postgres + fake sender)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;
  let userId: string;
  let accountA: ConnectedAccount;
  let accountB: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  let sends: { accountId: string; raw: string; threadId: string | null }[];
  let nextOutcome: (n: number) => SendOutcome;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    pool = postgres(testDbUrl!, { max: 12, onnotice: () => {} });
    poolDb = drizzle(pool, { schema }) as unknown as Database;
  });
  afterAll(async () => {
    await pool.end();
    await client.end();
  });

  const send: Sender = async (acc, req) => {
    sends.push({ accountId: acc.id, raw: req.raw, threadId: req.threadId });
    return nextOutcome(sends.length);
  };
  const deps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({ db: database, send, ...over });
  const audits = async () => await database.select().from(schema.auditLog).orderBy(asc(schema.auditLog.createdAt));
  const reload = async (id: string) => (await getOwnItem(database, userId, id))!;

  async function compose(over: Partial<NewMessageInput> = {}, ex: Database = database) {
    const r = await proposeNewMessage(ex, { userId, accountId: accountA.id, to: "bob@example.org", cc: "", subject: "Hello", bodyText: "Hi Bob", ...over });
    if (!r.ok) throw new Error(r.error);
    return (await getOwnItem(database, userId, r.itemId))!;
  }
  const recips = (item: schema.ApprovalItem) => {
    const p = emailSendPayload.parse(item.payload);
    return [...p.to, ...p.cc];
  };
  const approveInput = (item: schema.ApprovalItem, over: Partial<Parameters<typeof approveItem>[1]> = {}): Parameters<typeof approveItem>[1] => ({
    userId,
    itemId: item.id,
    revision: item.revision,
    contentHash: item.contentHash,
    ackThreadChange: false,
    shownThreadChangedAt: item.threadChangedAt ? item.threadChangedAt.getTime() : null,
    messageIdHost: HOST,
    confirmedRecipients: recips(item),
    newRecipientLimit: 10,
    ...over,
  });

  async function storedMessage(opts: {
    account?: ConnectedAccount;
    gmailThreadId?: string;
    from?: string | null;
    to?: string | null;
    cc?: string | null;
    replyTo?: string | null;
    labels?: string[];
    isSent?: boolean;
    owner?: string;
  } = {}) {
    const acc = opts.account ?? accountA;
    const gt = opts.gmailThreadId ?? `gt-${Math.random().toString(36).slice(2)}`;
    const [thread] = await database
      .insert(schema.mailThreads)
      .values({ userId: opts.owner ?? userId, accountId: acc.id, gmailThreadId: gt, subject: "Lunch", lastMessageAt: new Date(clock - DAY), messageCount: 1, inInbox: true, hasUnread: false })
      .returning();
    const [m] = await database
      .insert(schema.mailMessages)
      .values({
        userId: opts.owner ?? userId,
        accountId: acc.id,
        threadId: thread!.id,
        gmailMessageId: `m-${gt}`,
        gmailThreadId: gt,
        internalDate: new Date(clock - DAY),
        labelIds: opts.labels ?? ["INBOX"],
        isSent: opts.isSent ?? false,
        subject: "Lunch",
        fromHeader: opts.from === undefined ? "Alice <alice@example.org>" : opts.from,
        toHeader: opts.to === undefined ? acc.email : opts.to,
        ccHeader: opts.cc ?? null,
        replyToHeader: opts.replyTo ?? null,
        rfc822MessageId: `<m-${gt}@mail.example.org>`,
        headers: [],
        bodyText: "Hello",
      })
      .returning();
    return { thread: thread!, message: m! };
  }

  const syncDeps = (): SyncDeps => ({
    db: database,
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
  async function syncAcc(acc: ConnectedAccount) {
    for (let i = 0; i < 10; i++) {
      const fresh = (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, acc.id)))[0]!;
      await syncAccount(syncDeps(), fresh, "cron");
      const q = await database.select().from(schema.mailFetchQueue).where(eq(schema.mailFetchQueue.accountId, acc.id));
      if ((await getSyncState(database, acc.id))?.backfillStatus === "complete" && q.length === 0) return;
      clock += 5 * 60_000;
    }
  }

  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    accountA = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    accountB = await makeGoogleAccount(database, userId, { email: "home@example.com", label: "personal" });
    gmail = new FakeGmail();
    clock = Date.now();
    sends = [];
    nextOutcome = (n) => ({ kind: "succeeded", gmailMessageId: `sent${n}`, gmailThreadId: `newthread${n}` });
  });

  // ---- account checks (constraint 2) -------------------------------------------------------------

  describe("accounts", () => {
    it("another user can't approve, and an account reassigned after approve makes the executor refuse (nothing sent)", async () => {
      const item = await compose();
      const other = (await makeUser(database, "other@example.com")).id;
      expect(await approveItem(database, { ...approveInput(item), userId: other })).toEqual({ kind: "blocked", reason: "not_found" });
      expect((await approveItem(database, approveInput(item))).kind).toBe("approved");
      await database.update(schema.connectedAccounts).set({ userId: other }).where(eq(schema.connectedAccounts.id, accountA.id));
      const claim = (await claimItem(database, userId, item.id))!;
      expect(await executeClaimed(deps(), item.id, claim.executionId)).toEqual({ kind: "failed", code: "stale_account", status: null });
      expect(sends).toEqual([]);
    });

    it("reauth after approve fails execution with reauth_required; a provider flipped to slack is refused at approve and at execute", async () => {
      const i1 = await compose();
      expect((await approveItem(database, approveInput(i1))).kind).toBe("approved");
      await database.update(schema.connectedAccounts).set({ status: "reauth_required" }).where(eq(schema.connectedAccounts.id, accountA.id));
      const c1 = (await claimItem(database, userId, i1.id))!;
      expect(await executeClaimed(deps(), i1.id, c1.executionId)).toMatchObject({ kind: "failed", code: "reauth_required" });
      await database.update(schema.connectedAccounts).set({ status: "active" }).where(eq(schema.connectedAccounts.id, accountA.id));

      const i2 = await compose({ to: "amy@example.net" });
      await database.update(schema.connectedAccounts).set({ provider: "slack" }).where(eq(schema.connectedAccounts.id, accountA.id));
      expect(await approveItem(database, approveInput(i2))).toEqual({ kind: "blocked", reason: "account_mismatch" });
      await database.update(schema.connectedAccounts).set({ provider: "google" }).where(eq(schema.connectedAccounts.id, accountA.id));
      expect((await approveItem(database, approveInput(i2))).kind).toBe("approved");
      await database.update(schema.connectedAccounts).set({ provider: "slack" }).where(eq(schema.connectedAccounts.id, accountA.id));
      const c2 = (await claimItem(database, userId, i2.id))!;
      expect(await executeClaimed(deps(), i2.id, c2.executionId)).toMatchObject({ kind: "failed", code: "stale_account" });
      expect(sends).toEqual([]);
    });

    it("propose with an accountId that is not a uuid or is an injection string is refused cleanly", async () => {
      for (const accountId of ["x' or '1'='1", "", "00000000-0000-0000-0000-000000000000"]) {
        const r = await proposeNewMessage(database, { userId, accountId, to: "bob@example.org", cc: "", subject: "s", bodyText: "b" }).catch((e: Error) => ({ ok: false as const, error: `threw:${e.message.slice(0, 40)}` }));
        expect(r.ok, accountId).toBe(false);
      }
      expect(await database.select().from(schema.approvalItems)).toEqual([]);
    });
  });

  // ---- confirmation bound to revision and hash (Q2) ---------------------------------------------

  describe("confirmation", () => {
    it("an edit that changes the recipients after the page loaded: the old POST is stale; the new revision needs the new set", async () => {
      const item = await compose({ to: "bob@example.org" });
      const shownOld = approveInput(item); // what the owner's page had
      expect(await editItem(database, { userId, itemId: item.id, revision: 1, to: "bob@example.org\nevil@example.net", cc: "", subject: "Hello", bodyText: "Hi Bob", includeQuote: false })).toEqual({ ok: true, revision: 2 });
      const edited = await reload(item.id);
      expect(await approveItem(database, shownOld)).toMatchObject({ kind: "stale" });
      // New revision and hash but the old tick list: refused.
      expect(await approveItem(database, approveInput(edited, { confirmedRecipients: ["bob@example.org"] }))).toEqual({ kind: "blocked", reason: "recipients_unconfirmed" });
      // Old hash with the new revision: stale.
      expect(await approveItem(database, approveInput(edited, { contentHash: item.contentHash }))).toMatchObject({ kind: "stale" });
      expect((await approveItem(database, approveInput(edited))).kind).toBe("approved");
      const after = await reload(item.id);
      expect(emailSendPayload.parse(after.approvedPayload)).toMatchObject({ to: ["bob@example.org", "evil@example.net"] });
    });

    it("a stored payload changed behind the app (hash not updated) is refused; confirmations can't paper over it", async () => {
      const item = await compose({ to: "bob@example.org" });
      const p = emailSendPayload.parse(item.payload);
      await database.update(schema.approvalItems).set({ payload: { ...p, cc: ["evil@example.net"] } }).where(eq(schema.approvalItems.id, item.id));
      expect(await approveItem(database, approveInput(item, { confirmedRecipients: ["bob@example.org", "evil@example.net"] }))).toEqual({ kind: "blocked", reason: "hash_mismatch" });
      expect(sends).toEqual([]);
    });

    it("concurrent edit (adds a recipient) and approve (old ticks) on the pool, 20 staggered rounds: the approved payload always equals the ticked set", async () => {
      const tally = { approved: 0, editWon: 0 };
      for (let round = 0; round < 20; round++) {
        await database.delete(schema.approvalItems);
        const item = await compose({ to: "bob@example.org" });
        const [a, e] = await Promise.all([
          (async () => {
            if (round % 4 === 3) await sleep(round % 5);
            return approveItem(poolDb, approveInput(item));
          })(),
          (async () => {
            await sleep(round * 3);
            return editItem(poolDb, { userId, itemId: item.id, revision: 1, to: "bob@example.org\nevil@example.net", cc: "", subject: "Hello", bodyText: "Hi Bob", includeQuote: false });
          })(),
        ]);
        const row = await reload(item.id);
        if (a.kind === "approved") {
          tally.approved++;
          expect(e.ok, `round ${round}`).toBe(false);
          expect(emailSendPayload.parse(row.approvedPayload).cc).toEqual([]);
          expect(emailSendPayload.parse(row.approvedPayload).to).toEqual(["bob@example.org"]);
        } else {
          tally.editWon++;
          expect(row.status).toBe("pending");
          expect(row.approvedPayload).toBeNull();
        }
      }
      note(`edit-vs-approve tally ${JSON.stringify(tally)}`);
      expect(tally.approved).toBeGreaterThan(0);
      expect(tally.editWon).toBeGreaterThan(0);
    });
  });

  // ---- daily cap (Q3) ---------------------------------------------------------------------------

  describe("cap", () => {
    it("staggered races on a 12-connection pool: 2+2 under limit 3, 30 rounds, exactly one approved each round", async () => {
      const wins = { first: 0, second: 0 };
      for (let round = 0; round < 30; round++) {
        await database.delete(schema.approvalItems);
        const i1 = await compose({ to: `p${round}a@example.org\np${round}b@example.org` });
        const i2 = await compose({ to: `q${round}a@example.org\nq${round}b@example.org` });
        const go = async (it: schema.ApprovalItem, delay: number) => {
          if (delay) await sleep(delay);
          return approveItem(poolDb, approveInput(it, { newRecipientLimit: 3 }));
        };
        const d = round % 4;
        const [r1, r2] = await Promise.all([go(i1, round % 2 ? d : 0), go(i2, round % 2 ? 0 : d)]);
        expect([r1.kind, r2.kind].sort(), `round ${round}`).toEqual(["approved", "blocked"]);
        if (r1.kind === "approved") wins.first++;
        else wins.second++;
        const rows = await database.select().from(schema.approvalItems);
        expect(rows.reduce((n, r) => n + (r.newRecipientCount ?? 0), 0)).toBe(2);
      }
      note(`cap race wins ${JSON.stringify(wins)}`);
      expect(wins.first).toBeGreaterThan(0);
      expect(wins.second).toBeGreaterThan(0);
    });

    it("8 parallel approves of 1 new recipient each under limit 3: exactly 3 approved, 5 blocked", async () => {
      const items = [];
      for (let i = 0; i < 8; i++) items.push(await compose({ to: `solo${i}@example.org` }));
      const res = await Promise.all(items.map((it, i) => sleep(i % 3).then(() => approveItem(poolDb, approveInput(it, { newRecipientLimit: 3 })))));
      expect(res.filter((r) => r.kind === "approved")).toHaveLength(3);
      expect(res.filter((r) => r.kind === "blocked" && r.reason === "new_recipient_limit")).toHaveLength(5);
    });

    it("UTC day boundaries: 23:59:59.999 counts for that day, 00:00:00.000 is the next day", async () => {
      const day = Date.UTC(2026, 10, 20);
      const late = new Date(day - 1); // 2026-11-19T23:59:59.999Z
      const midnight = new Date(day); // 2026-11-20T00:00:00.000Z
      const i1 = await compose({ to: "d1@example.org\nd2@example.org" });
      const i2 = await compose({ to: "e1@example.org\ne2@example.org" });
      const i3 = await compose({ to: "f1@example.org\nf2@example.org" });
      expect((await approveItem(database, approveInput(i1, { newRecipientLimit: 2, now: late }))).kind).toBe("approved");
      expect(await approveItem(database, approveInput(i2, { newRecipientLimit: 2, now: late }))).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
      expect((await approveItem(database, approveInput(i2, { newRecipientLimit: 2, now: midnight }))).kind).toBe("approved");
      expect(await approveItem(database, approveInput(i3, { newRecipientLimit: 2, now: new Date(day + DAY - 1) }))).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
      expect((await approveItem(database, approveInput(i3, { newRecipientLimit: 2, now: new Date(day + DAY) }))).kind).toBe("approved");
    });

    it("statuses: approved/executing/unknown/succeeded count; failed, marked-not-sent and cancelled-after-failure don't", async () => {
      nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
      const u = await compose({ to: "u1@example.org" });
      await approveAndSend(deps(), approveInput(u));
      expect((await reload(u.id)).status).toBe("unknown");
      const probe = await compose({ to: "probe@example.org" });
      expect(await approveItem(database, approveInput(probe, { newRecipientLimit: 1 }))).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
      // Owner marks it not sent (after the wait): released.
      await database.update(schema.approvalItems).set({ executingSince: new Date(Date.now() - 2 * 3600_000) }).where(eq(schema.approvalItems.id, u.id));
      expect(await markNotSent(database, userId, u.id, new Date())).toBe(true);
      expect((await reload(u.id)).status).toBe("failed");
      expect((await approveItem(database, approveInput(probe, { newRecipientLimit: 1 }))).kind).toBe("approved");
      // Cancelling the failed item doesn't bring the count back.
      expect(await cancelItem(database, userId, u.id)).toBe(true);
      const used = (await getItemView(database, userId, probe.id, { newRecipientLimit: 1 }))!.cap;
      expect(used).toEqual({ limit: 1, usedToday: 1, remaining: 0 });
    });

    it("without an explicit limit, approve uses EMAIL_NEW_RECIPIENTS_PER_DAY; an invalid value falls back to 10", async () => {
      const eleven = Array.from({ length: 11 }, (_, i) => `n${i}@example.org`).join("\n");
      const big = await compose({ to: eleven });
      expect(await approveItem(database, approveInput(big, { newRecipientLimit: undefined }))).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
      const ten = await compose({ to: Array.from({ length: 10 }, (_, i) => `t${i}@example.org`).join("\n") });
      expect((await approveItem(database, approveInput(ten, { newRecipientLimit: undefined }))).kind).toBe("approved");
      const lim = (await audits()).filter((a) => a.action === "approval.new_recipient_limit").map((a) => a.detail);
      expect(lim).toEqual([{ itemId: big.id, newRecipients: 11, usedToday: 0, limit: 10 }]);
    });

    it("DEFECT probe: disconnecting an account deletes its items and with them today's counted first-time recipients", async () => {
      // Approve 2 first-time recipients from B (limit 2), then disconnect B the way the app does.
      const fromB = await compose({ accountId: accountB.id, to: "g1@example.org\ng2@example.org" });
      await approveAndSend(deps(), approveInput(fromB, { newRecipientLimit: 2 }));
      expect((await reload(fromB.id)).status).toBe("succeeded");
      const fromA = await compose({ to: "h1@example.org\nh2@example.org" });
      expect(await approveItem(database, approveInput(fromA, { newRecipientLimit: 2 }))).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
      await deleteAccount(database, userId, accountB.id);
      const r = await approveItem(database, approveInput(fromA, { newRecipientLimit: 2 }));
      note(`after disconnect, 2 more first-time recipients under limit 2: ${r.kind}`);
      // The owner approved 4 first-time recipients today under a limit of 2.
      expect(r.kind).toBe("blocked");
    });

    it("a single item with more first-time recipients than the limit can never be approved (records the notice text it gets)", async () => {
      const item = await compose({ to: Array.from({ length: 3 }, (_, i) => `over${i}@example.org`).join("\n") });
      expect(await approveItem(database, approveInput(item, { newRecipientLimit: 2, now: new Date(Date.UTC(2026, 10, 21, 0, 0, 1)) }))).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
    });
  });

  // ---- seen (Q4) and the Q3 amendment ------------------------------------------------------------

  describe("seen", () => {
    it("display-name, comment and group tricks in an inbound From/Reply-To don't plant a third address", async () => {
      await storedMessage({ from: '"carol@example.org" <attacker@example.net>' });
      await storedMessage({ from: "dave@example.org <attacker2@example.net>" });
      await storedMessage({ from: "attacker3@example.net (erin@example.org)" });
      await storedMessage({ from: "undisclosed: frank@example.org;" });
      await storedMessage({ from: "x@example.net", replyTo: "<gina@example.org" });
      await storedMessage({ from: "hank@example.org.evil.example, xivan@example.org" });
      const seen = await seenAddresses(database, userId, ["carol@example.org", "dave@example.org", "erin@example.org", "frank@example.org", "gina@example.org", "hank@example.org", "ivan@example.org", "attacker@example.net"]);
      expect([...seen]).toEqual(["attacker@example.net"]);
    });

    it("inbound To/Cc never make an address seen (only sent mail's To/Cc do); another user's sends and accounts don't count", async () => {
      await storedMessage({ to: "work@example.com, jill@example.org", cc: "kim@example.org" });
      const other = (await makeUser(database, "other@example.com")).id;
      const otherAcc = await makeGoogleAccount(database, other, { email: "otheracct@example.com" });
      await storedMessage({ owner: other, account: otherAcc, isSent: true, labels: ["SENT"], to: "leo@example.org" });
      const [oi] = await database
        .insert(schema.approvalItems)
        .values({
          userId: other,
          kind: "email.send",
          source: "owner",
          status: "succeeded",
          accountId: otherAcc.id,
          payload: { to: ["mia@example.org"], cc: [], subject: "s", bodyText: "b", quote: null, threading: null, replyToNotice: false },
          approvedPayload: { to: ["mia@example.org"], cc: [], subject: "s", bodyText: "b", quote: null, threading: null, replyToNotice: false },
          revision: 1,
          contentHash: "x",
        })
        .returning();
      expect(oi).toBeTruthy();
      expect([...(await seenAddresses(database, userId, ["jill@example.org", "kim@example.org", "leo@example.org", "mia@example.org", "otheracct@example.com"]))]).toEqual([]);
    });

    // Round 2 (F1, directed by the coordinator): a SPAM or TRASH parent exempts nothing.
    for (const label of ["TRASH", "SPAM"]) {
      it(`a parent the reply is to, in ${label}: its Cc'd never-seen addresses are NOT exempt (F1 fixed), at approve and on the page`, async () => {
        const cc = Array.from({ length: 12 }, (_, i) => `trashcc${i}@example.net`);
        const { thread, message } = await storedMessage({ from: "trashed@example.net", cc: cc.join(", "), labels: [label] });
        expect([...(await seenAddresses(database, userId, ["trashed@example.net", ...cc]))]).toEqual([]);
        const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: message.id, to: "trashed@example.net", cc: cc.join("\n"), subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
        expect(r.ok).toBe(true);
        const item = await reload((r as { itemId: string }).itemId);
        expect((await getItemView(database, userId, item.id, { newRecipientLimit: 10 }))!.firstTime.sort()).toEqual(["trashed@example.net", ...cc].sort());
        const res = await approveItem(database, approveInput(item, { confirmedRecipients: undefined, newRecipientLimit: 10 }));
        note(`round 2: reply to ${label} parent with 13 untrusted recipients under limit 10: ${JSON.stringify(res)}`);
        expect(res).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
        expect((await reload(item.id)).status).toBe("pending");
      });
    }

    it("round 2: a normal parent still exempts; the same parent moved to TRASH after the page rendered is re-checked at approve", async () => {
      const cc = Array.from({ length: 12 }, (_, i) => `normcc${i}@example.net`);
      const { thread, message } = await storedMessage({ from: "norm@example.net", cc: cc.join(", ") });
      const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: message.id, to: "norm@example.net", cc: cc.join("\n"), subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
      const item = await reload((r as { itemId: string }).itemId);
      expect((await getItemView(database, userId, item.id, { newRecipientLimit: 10 }))!.firstTime).toEqual([]);
      // Labels change (as history label sync does) between render and approve.
      await database.update(schema.mailMessages).set({ labelIds: ["INBOX", "TRASH"] }).where(eq(schema.mailMessages.id, message.id));
      expect(await approveItem(database, approveInput(item, { confirmedRecipients: undefined, newRecipientLimit: 10 }))).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
      await database.update(schema.mailMessages).set({ labelIds: ["INBOX"] }).where(eq(schema.mailMessages.id, message.id));
      expect((await approveItem(database, approveInput(item, { confirmedRecipients: undefined, newRecipientLimit: 10 }))).kind).toBe("approved");
      expect((await reload(item.id)).newRecipientCount).toBe(0);
    });

    it("the parent exemption needs the item's own parent: another message in the same thread doesn't exempt", async () => {
      const { thread, message } = await storedMessage({ cc: "onparent@example.net" });
      await database.insert(schema.mailMessages).values({
        userId,
        accountId: accountA.id,
        threadId: thread.id,
        gmailMessageId: "sibling",
        gmailThreadId: thread.gmailThreadId,
        internalDate: new Date(clock - 2 * DAY),
        labelIds: ["INBOX"],
        isSent: false,
        fromHeader: "alice@example.org",
        toHeader: "work@example.com",
        ccHeader: "onsibling@example.net",
        headers: [],
      });
      const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: message.id, to: "alice@example.org", cc: "onparent@example.net\nonsibling@example.net", subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
      const item = await reload((r as { itemId: string }).itemId);
      expect((await getItemView(database, userId, item.id, { newRecipientLimit: 10 }))!.firstTime).toEqual(["onsibling@example.net"]);
    });

    it("confirmed recipients don't matter for replies (2b unchanged): garbage ticks still approve", async () => {
      const { thread, message } = await storedMessage();
      const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: message.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
      const item = await reload((r as { itemId: string }).itemId);
      expect((await approveItem(database, approveInput(item, { confirmedRecipients: ["nobody@example.net"] }))).kind).toBe("approved");
    });

    it("speed: seenAddresses over ~20,000 stored messages (worst cases), recorded", async () => {
      const { thread } = await storedMessage();
      // 20,000 rows: half inbound, half sent; every header contains "zed@example.org" as a SUBSTRING
      // (xzed@...), so the prefilter matches every row and each must be parsed in code.
      await database.execute(sql`
        insert into mail_messages (user_id, account_id, thread_id, gmail_message_id, gmail_thread_id, internal_date, label_ids, is_sent, from_header, to_header, cc_header, reply_to_header, headers)
        select ${userId}::uuid, ${accountA.id}::uuid, ${thread.id}::uuid, 'perf' || g, ${thread.gmailThreadId}, now() - (g || ' minutes')::interval,
          case when g % 2 = 0 then array['SENT'] else array['INBOX'] end, g % 2 = 0,
          'Sender ' || g || ' <xzed@example.org>',
          'a' || g || '@example.org, xzed@example.org, "Name, with comma" <b' || g || '@example.org>, c' || g || '@example.org',
          'xzed@example.org, d' || g || '@example.org, e' || g || '@example.org',
          'xzed@example.org',
          '[]'::jsonb
        from generate_series(1, 20000) g
      `);
      const timeIt = async (label: string, candidates: string[]) => {
        await seenAddresses(database, userId, candidates); // warm
        const t0 = performance.now();
        const s = await seenAddresses(database, userId, candidates);
        const ms = performance.now() - t0;
        note(`seen ${label}: ${ms.toFixed(1)} ms (${s.size} seen of ${candidates.length})`);
        return ms;
      };
      const none50 = Array.from({ length: 50 }, (_, i) => `nobody${i}@example.net`);
      const t1 = await timeIt("50 unseen, prefilter matches nothing", none50);
      const t2 = await timeIt("1 unseen substring of every row", ["zed@example.org"]);
      const t3 = await timeIt("50 candidates incl. substring of every row", ["zed@example.org", ...none50.slice(1)]);
      const t4 = await timeIt("1 seen (sent To of row 778) mid-table", ["a778@example.org"]);
      // Whole approve and page view, with the substring candidate.
      const item = await compose({ to: "zed@example.org" });
      let t0 = performance.now();
      await getItemView(database, userId, item.id, { newRecipientLimit: 10 });
      const tv = performance.now() - t0;
      t0 = performance.now();
      expect((await approveItem(database, approveInput(item))).kind).toBe("approved");
      const ta = performance.now() - t0;
      note(`getItemView ${tv.toFixed(1)} ms, approveItem ${ta.toFixed(1)} ms`);
      const t5 = await timeIt("2 unseen (typical)", ["nobody1@example.net", "nobody2@example.net"]);
      expect(await seenAddresses(database, userId, ["a778@example.org"])).toEqual(new Set(["a778@example.org"]));
      // Worst case end to end: a 50-recipient new message, none seen.
      const big = await compose({ to: none50.join("\n") });
      t0 = performance.now();
      await getItemView(database, userId, big.id, { newRecipientLimit: 100 });
      const tv50 = performance.now() - t0;
      t0 = performance.now();
      expect((await approveItem(database, approveInput(big, { newRecipientLimit: 100 }))).kind).toBe("approved");
      const ta50 = performance.now() - t0;
      note(`50 recipients: getItemView ${tv50.toFixed(1)} ms, approveItem ${ta50.toFixed(1)} ms`);
      for (const t of [t1, t2, t3, t4, t5, tv, ta, tv50, ta50]) expect(t).toBeLessThan(5_000);
    }, 120_000);
  });

  // ---- R8: the check constraint -------------------------------------------------------------------

  describe("check constraint (R8)", () => {
    const base = { to: ["bob@example.org"], cc: [], subject: "s", bodyText: "b", quote: null, replyToNotice: false };
    it("records what the constraint lets through, and that the app refuses each such row (nothing sent)", async () => {
      const { thread, message } = await storedMessage();
      const shapes: Record<string, unknown> = {
        noThreadingKey: base,
        threadingJsonNull: { ...base, threading: null },
        payloadIsArray: [base],
        payloadIsString: "x",
      };
      const results: Record<string, string> = {};
      for (const [name, payload] of Object.entries(shapes)) {
        const err = await pgError(
          database.insert(schema.approvalItems).values({
            userId,
            kind: "email.send",
            source: "owner",
            status: "pending",
            accountId: accountA.id,
            threadId: thread.id,
            parentMessageId: message.id,
            payload: payload as schema.ApprovalItem["payload"],
            revision: 1,
            contentHash: contentHash("email.send", accountA.id, payload),
          }),
        );
        results[name] = err === "no error" ? "accepted" : /new_message_shape_chk/.test(err) ? "rejected" : err;
      }
      note(`R8 constraint results ${JSON.stringify(results)}`);
      expect(results.threadingJsonNull).toBe("rejected");
      // The gap the plan named: a missing key (or a non-object payload) passes the constraint.
      expect(results.noThreadingKey).toBe("accepted");
      // The app must still refuse every accepted row at approve and at execute.
      const rows = await database.select().from(schema.approvalItems);
      for (const row of rows) {
        expect(await approveItem(database, { userId, itemId: row.id, revision: 1, contentHash: row.contentHash, ackThreadChange: false, shownThreadChangedAt: null, messageIdHost: HOST, confirmedRecipients: ["bob@example.org"], newRecipientLimit: 10 })).toMatchObject({ kind: "blocked" });
        // Force-approve in SQL and run the executor.
        await database.update(schema.approvalItems).set({ status: "approved", approvedPayload: row.payload, approvedRevision: 1, approvedHash: row.contentHash, messageIdHeader: `<alex.${row.id}.1.ab@${HOST}>` }).where(eq(schema.approvalItems.id, row.id));
        const claim = await claimItem(database, userId, row.id);
        expect(claim).not.toBeNull();
        expect((await executeClaimed(deps(), row.id, claim!.executionId))?.kind).toBe("failed");
      }
      expect(sends).toEqual([]);
    });
  });

  // ---- outbound ingestion races and the item link (AC9) ----------------------------------------

  describe("outbound", () => {
    it("real race, two connections: an open enqueueOutbound transaction and a concurrent history drop; and the reverse order", async () => {
      // Order 1: enqueueOutbound holds the row (uncommitted conversion), the drop waits, then must keep it.
      await enqueueMessages(database, accountA, [{ gmailMessageId: "r1", gmailThreadId: "tr1", source: "history", needsClassify: true }]);
      const [loaded1] = await dueQueueRows(database, accountA.id, new Date(Date.now() + 1000), 10);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const held = poolDb.transaction(async (tx) => {
        await enqueueOutbound(tx, accountA, "r1", "tr1");
        await gate;
      });
      await sleep(100);
      let dropped = false;
      const drop = dropQueueRow(database, loaded1!).then(() => (dropped = true));
      await sleep(200);
      expect(dropped).toBe(false); // it is waiting on the row lock
      release();
      await Promise.all([held, drop]);
      expect(await database.select().from(schema.mailFetchQueue)).toMatchObject([{ gmailMessageId: "r1", source: "outbound" }]);

      // Order 2: the history drop deletes first (uncommitted), the upsert waits, then must insert.
      await database.delete(schema.mailFetchQueue);
      await enqueueMessages(database, accountA, [{ gmailMessageId: "r2", gmailThreadId: "tr2", source: "history", needsClassify: true }]);
      const [loaded2] = await dueQueueRows(database, accountA.id, new Date(Date.now() + 1000), 10);
      let release2!: () => void;
      const gate2 = new Promise<void>((r) => (release2 = r));
      const held2 = poolDb.transaction(async (tx) => {
        await dropQueueRow(tx, loaded2!);
        await gate2;
      });
      await sleep(100);
      let upserted = false;
      const up = enqueueOutbound(database, accountA, "r2", "tr2").then(() => (upserted = true));
      await sleep(200);
      expect(upserted).toBe(false);
      release2();
      await Promise.all([held2, up]);
      expect(await database.select().from(schema.mailFetchQueue)).toMatchObject([{ gmailMessageId: "r2", source: "outbound" }]);

      // Order 3: a defer UPDATE holds the row, then the upsert converts it after commit.
      await database.delete(schema.mailFetchQueue);
      await enqueueMessages(database, accountA, [{ gmailMessageId: "r3", gmailThreadId: "tr3", source: "backfill_sent", needsClassify: false }]);
      const [loaded3] = await dueQueueRows(database, accountA.id, new Date(Date.now() + 1000), 10);
      let release3!: () => void;
      const gate3 = new Promise<void>((r) => (release3 = r));
      const held3 = poolDb.transaction(async (tx) => {
        await deferQueueRow(tx, loaded3!, new Date(), 60_000, 5);
        await gate3;
      });
      await sleep(100);
      const up3 = enqueueOutbound(database, accountA, "r3", "tr3");
      await sleep(100);
      release3();
      await Promise.all([held3, up3]);
      expect(await database.select().from(schema.mailFetchQueue)).toMatchObject([{ gmailMessageId: "r3", source: "outbound", attempts: 0, deferredAt: null }]);
    });

    it("end to end inside syncAccount: the send response arrives while the history row for the SENT copy is being classified; the copy is still stored", async () => {
      await syncAcc(accountA);
      const item = await compose({ subject: "Race" });
      expect((await approveItem(database, approveInput(item))).kind).toBe("approved");
      const approved = await reload(item.id);
      const claim = (await claimItem(database, userId, item.id))!;
      // Gmail has the SENT copy; history reports it without labels, so a history row needs_classify is queued.
      gmail.deliver({ id: "sent1", threadId: "newthread1", labelIds: ["SENT"], internalDate: clock, subject: "Race", messageIdHeader: approved.messageIdHeader! });
      // While hydrate asks Gmail for its labels, the executor records the outcome (enqueueOutbound), on another connection.
      const realMinimal = gmail.getMessageMinimal.bind(gmail);
      let fired = false;
      gmail.getMessageMinimal = async (id: string) => {
        if (id === "sent1" && !fired) {
          fired = true;
          const rows = await database.select().from(schema.mailFetchQueue);
          note("e2e race queue before outcome: " + JSON.stringify(rows.map((r) => r.source)));
          expect(await executeClaimed({ db: poolDb, send }, item.id, claim.executionId)).toMatchObject({ kind: "succeeded" });
        }
        return realMinimal(id);
      };
      // The executor runs only when hydrate calls Gmail; start the executor-free sync.
      await syncAccount(syncDeps(), (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, accountA.id)))[0]!, "cron");
      expect(fired).toBe(true);
      clock += 5 * 60_000;
      await syncAcc(accountA);
      const threads = await database.select().from(schema.mailThreads);
      expect(threads).toMatchObject([{ gmailThreadId: "newthread1", inInbox: false }]);
      expect((await reload(item.id)).status).toBe("succeeded");
      expect((await getItemView(database, userId, item.id))!.sentThread).toMatchObject({ id: threads[0]!.id });
    });

    it("F2 (round 2): failQueueRow on a history row converted to outbound mid-hydrate neither parks nor retries it; real outbound rows still do", async () => {
      for (const [attempts, transient] of [[4, false], [0, false], [9, true], [0, true]] as const) {
        await database.delete(schema.mailFetchQueue);
        await enqueueMessages(database, accountA, [{ gmailMessageId: "f1", gmailThreadId: "tf1", source: "history", needsClassify: true }]);
        await database.update(schema.mailFetchQueue).set({ attempts });
        const [loaded] = await dueQueueRows(database, accountA.id, new Date(Date.now() + 1000), 10);
        await enqueueOutbound(database, accountA, "f1", "tf1");
        const fresh = (await database.select().from(schema.mailFetchQueue))[0]!;
        await failQueueRow(database, loaded!, new Date(), { transient, error: "400", maxAttempts: 5, maxTransientAttempts: 10 });
        const [row] = await database.select().from(schema.mailFetchQueue);
        note(`round 2 failQueueRow after conversion (attempts ${attempts}, transient ${transient}): source=${row?.source} attempts=${row?.attempts} parked=${row?.nextAttemptAt.getTime() === PARKED_AT.getTime()}`);
        expect(row).toEqual(fresh); // untouched
      }
      // An outbound row that itself fails is retried, then parked at the limit.
      await database.delete(schema.mailFetchQueue);
      await enqueueOutbound(database, accountA, "o1", "to1");
      let [o] = await database.select().from(schema.mailFetchQueue);
      expect(await failQueueRow(database, o!, new Date(), { transient: false, error: "400", maxAttempts: 5, maxTransientAttempts: 10 })).toBe("retry");
      [o] = await database.select().from(schema.mailFetchQueue);
      expect(o).toMatchObject({ attempts: 1, lastError: "400" });
      await database.update(schema.mailFetchQueue).set({ attempts: 4 });
      [o] = await database.select().from(schema.mailFetchQueue);
      expect(await failQueueRow(database, o!, new Date(), { transient: false, error: "400", maxAttempts: 5, maxTransientAttempts: 10 })).toBe("parked");
      [o] = await database.select().from(schema.mailFetchQueue);
      expect(o!.nextAttemptAt.getTime()).toBe(PARKED_AT.getTime());
    });

    it("A sends to B (own accounts): B's inbound copy with the same Message-ID never changes the item, even while it is unknown", async () => {
      await syncAcc(accountA);
      await syncAcc(accountB);
      nextOutcome = () => ({ kind: "unknown", code: "timeout", status: null });
      const item = await compose({ to: "home@example.com" });
      await approveAndSend(deps(), approveInput(item));
      const before = await reload(item.id);
      expect(before.status).toBe("unknown");
      // B receives the message: an INBOX copy in B carrying our Message-ID.
      gmail.deliver({ id: "inB", threadId: "tB", labelIds: ["INBOX", "UNREAD"], internalDate: clock, from: "work@example.com", messageIdHeader: before.messageIdHeader! });
      await syncAcc(accountB);
      expect((await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.accountId, accountB.id))).length).toBe(1);
      const after = await reload(item.id);
      expect(after).toEqual(before);
    });

    it("the item links only to a thread of its own account and user, found by result.gmailThreadId; replies never get sentThread", async () => {
      const item = await compose();
      await approveAndSend(deps(), approveInput(item));
      const sent = await reload(item.id);
      expect(sent.result).toMatchObject({ gmailThreadId: "newthread1" });
      // Same Gmail thread id in account B (same user) and in another user's account: not linked.
      await storedMessage({ account: accountB, gmailThreadId: "newthread1" });
      const other = (await makeUser(database, "other@example.com")).id;
      const otherAcc = await makeGoogleAccount(database, other, { email: "otheracct@example.com" });
      await storedMessage({ owner: other, account: otherAcc, gmailThreadId: "newthread1" });
      expect((await getItemView(database, userId, item.id))!.sentThread).toBeNull();
      const { thread } = await storedMessage({ gmailThreadId: "newthread1", isSent: true, labels: ["SENT"] });
      expect((await getItemView(database, userId, item.id))!.sentThread).toMatchObject({ id: thread.id });
      // A non-string result id is ignored.
      await database.update(schema.approvalItems).set({ result: { gmailMessageId: "sent1", gmailThreadId: { evil: 1 } } }).where(eq(schema.approvalItems.id, item.id));
      expect((await getItemView(database, userId, item.id))!.sentThread).toBeNull();
      // A succeeded reply with a result pointing at that thread: no sentThread.
      const { thread: t2, message: m2 } = await storedMessage();
      const rr = await proposeReply(database, { userId, threadId: t2.id, parentMessageId: m2.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
      const reply = await reload((rr as { itemId: string }).itemId);
      await database.update(schema.approvalItems).set({ status: "succeeded", result: { gmailMessageId: "x", gmailThreadId: "newthread1" } }).where(eq(schema.approvalItems.id, reply.id));
      expect((await getItemView(database, userId, reply.id))!.sentThread).toBeNull();
    });

    it("a reply's success never enqueues outbound (2b behaviour kept)", async () => {
      const { thread, message } = await storedMessage();
      const rr = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: message.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
      const reply = await reload((rr as { itemId: string }).itemId);
      expect((await approveAndSend(deps(), approveInput(reply, { confirmedRecipients: undefined }))).kind).toBe("executed");
      expect(await database.select().from(schema.mailFetchQueue)).toEqual([]);
    });
  });

  // ---- round 2: attacks on the D1 charge design ---------------------------------------------------

  describe("round 2: D1 recipient charges", () => {
    const used = (now = new Date()) => newRecipientsUsedToday(database, userId, utcDayStart(now));
    const charges = async () => await database.select().from(schema.approvalRecipientCharges);
    const approvedAudit = async (itemId: string) => (await audits()).some((a) => a.action === "approval.approved" && (a.detail as { itemId?: string }).itemId === itemId);

    it("no app path deletes approval_items except the account/user cascades (static: grep of src)", async () => {
      const { readdirSync, readFileSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const hits: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.(ts|tsx)$/.test(name)) {
            const text = readFileSync(p, "utf8");
            if (/delete\(\s*(schema\.)?approvalItems\s*\)/.test(text) || /delete\s+from\s+"?approval_items/i.test(text)) hits.push(p);
          }
        }
      };
      walk("src");
      expect(hits).toEqual([]);
    }, 30_000);

    it("disconnect racing the approve of that account's own item, 30 staggered rounds: approved ⇔ charge exists ⇔ it keeps counting (deadlocks tallied)", async () => {
      const tally = { approved: 0, notApproved: 0, approveDeadlock: 0, disconnectDeadlock: 0 };
      const code = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code ?? "?";
      for (let round = 0; round < 30; round++) {
        await database.delete(schema.approvalItems);
        await database.delete(schema.approvalRecipientCharges);
        const b = await makeGoogleAccount(database, userId, { email: `b${round}@example.com` });
        const item = await compose({ accountId: b.id, to: `rb${round}a@example.org\nrb${round}b@example.org` });
        const [res, disc] = await Promise.all([
          (async () => {
            if (round % 4 === 3) await sleep(round % 3);
            try {
              return await approveItem(poolDb, approveInput(item, { newRecipientLimit: 10 }));
            } catch (err) {
              return { kind: `error:${code(err)}` };
            }
          })(),
          (async () => {
            // Disconnect is cheaper than approve: delay it by up to ~60 ms so both orders occur.
            await sleep(round * 2);
            try {
              await deleteAccount(poolDb, userId, b.id);
              return "ok";
            } catch (err) {
              return `error:${code(err)}`;
            }
          })(),
        ]);
        if (res.kind === "error:40P01") tally.approveDeadlock++;
        if (disc === "error:40P01") tally.disconnectDeadlock++;
        for (const r of [res.kind, disc]) if (r.startsWith("error:")) expect(r, `round ${round}: only deadlocks are expected`).toBe("error:40P01");
        const wasApproved = await approvedAudit(item.id);
        if (wasApproved) tally.approved++;
        else tally.notApproved++;
        expect(res.kind === "approved", `round ${round} ${JSON.stringify(res)}`).toBe(wasApproved);
        expect((await charges()).length, `round ${round}`).toBe(wasApproved ? 1 : 0);
        expect(await used(), `round ${round}`).toBe(wasApproved ? 2 : 0);
        // A disconnect that lost a deadlock is retried, as the owner would; the count must survive it.
        if (disc !== "ok") await deleteAccount(database, userId, b.id);
        expect(await getOwnItem(database, userId, item.id)).toBeNull();
        expect(await used(), `round ${round} after disconnect`).toBe(wasApproved ? 2 : 0);
      }
      note(`round 2 disconnect-vs-own-approve tally ${JSON.stringify(tally)}`);
      expect(tally.approved).toBeGreaterThan(0);
      expect(tally.notApproved).toBeGreaterThan(0);
    }, 120_000);

    it("disconnect of B (holding a charge of 2) racing an approve from A (2 new, limit 3), 20 staggered rounds: always blocked", async () => {
      for (let round = 0; round < 20; round++) {
        await database.delete(schema.approvalItems);
        await database.delete(schema.approvalRecipientCharges);
        const b = await makeGoogleAccount(database, userId, { email: `c${round}@example.com` });
        const fromB = await compose({ accountId: b.id, to: `cb${round}a@example.org\ncb${round}b@example.org` });
        expect((await approveItem(database, approveInput(fromB, { newRecipientLimit: 3 }))).kind).toBe("approved");
        const fromA = await compose({ to: `ca${round}a@example.org\nca${round}b@example.org` });
        const [res] = await Promise.all([
          (async () => {
            if (round % 2) await sleep(round % 5);
            return approveItem(poolDb, approveInput(fromA, { newRecipientLimit: 3 }));
          })(),
          (async () => {
            if (!(round % 2)) await sleep(round % 5);
            await deleteAccount(poolDb, userId, b.id);
          })(),
        ]);
        expect(res, `round ${round}`).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
      }
    }, 120_000);

    it("reconnecting the same Google account (same sub) after a disconnect gets a new id; the old charge still counts", async () => {
      const fromB = await compose({ accountId: accountB.id, to: "rc1@example.org\nrc2@example.org" });
      await approveAndSend(deps(), approveInput(fromB, { newRecipientLimit: 2 }));
      await deleteAccount(database, userId, accountB.id);
      const re = await upsertGoogleAccount(database, {
        userId,
        identity: { sub: accountB.providerAccountId, email: accountB.email, name: null },
        tokens: { accessToken: "access", accessTokenExpiresAt: new Date(Date.now() + 3600_000), refreshToken: "refresh", scopes: [] },
        label: "personal",
        key: TEST_KEY,
      });
      expect(re.id).not.toBe(accountB.id);
      expect(await used()).toBe(2);
      const again = await compose({ accountId: re.id, to: "rc3@example.org" });
      expect(await approveItem(database, approveInput(again, { newRecipientLimit: 2 }))).toEqual({ kind: "blocked", reason: "new_recipient_limit" });
    });

    it("re-approval replaces the charge (one row per item): failed n=2 → edited to own accounts → re-approved n=0; disconnect then counts 0", async () => {
      nextOutcome = (n) => (n === 1 ? { kind: "failed", code: "gmail_400", status: 400 } : { kind: "succeeded", gmailMessageId: `s${n}`, gmailThreadId: `t${n}` });
      const item = await compose({ accountId: accountB.id, to: "ra1@example.org\nra2@example.org" });
      await approveAndSend(deps(), approveInput(item, { newRecipientLimit: 2 }));
      expect((await reload(item.id)).status).toBe("failed");
      expect(await used()).toBe(0);
      // Re-approving the same content twice over (fail, approve) never doubles: still one charge row.
      const failed = await reload(item.id);
      expect(await editItem(database, { userId, itemId: item.id, revision: failed.revision, to: "work@example.com", cc: "", subject: "Hello", bodyText: "Hi", includeQuote: false })).toMatchObject({ ok: true });
      const edited = await reload(item.id);
      expect((await approveAndSend(deps(), approveInput(edited, { newRecipientLimit: 2 }))).kind).toBe("executed");
      const ch = await charges();
      expect(ch).toHaveLength(1);
      expect(ch[0]).toMatchObject({ itemId: item.id, newRecipients: 0 });
      await deleteAccount(database, userId, accountB.id);
      expect(await used()).toBe(0);
    });

    it("judged: a failed item whose account is then disconnected counts again (over-count, conservative); recorded", async () => {
      nextOutcome = () => ({ kind: "failed", code: "gmail_400", status: 400 });
      const item = await compose({ accountId: accountB.id, to: "oc1@example.org\noc2@example.org\noc3@example.org" });
      await approveAndSend(deps(), approveInput(item, { newRecipientLimit: 10 }));
      const before = await used();
      await deleteAccount(database, userId, accountB.id);
      const after = await used();
      note(`round 2 failed-then-disconnect: used before ${before}, after ${after}`);
      expect({ before, after }).toEqual({ before: 0, after: 3 });
    });

    it("the day boundary uses the charge's approved_at once the item is gone", async () => {
      const day = Date.UTC(2026, 10, 20);
      const late = new Date(day - 1);
      const item = await compose({ accountId: accountB.id, to: "db1@example.org\ndb2@example.org" });
      expect((await approveItem(database, approveInput(item, { newRecipientLimit: 10, now: late }))).kind).toBe("approved");
      await deleteAccount(database, userId, accountB.id);
      expect(await newRecipientsUsedToday(database, userId, utcDayStart(late))).toBe(2);
      expect(await newRecipientsUsedToday(database, userId, utcDayStart(new Date(day)))).toBe(0);
    });

    it("user-level cascade: deleting the user deletes its charges; another user's charges never count", async () => {
      const item = await compose({ to: "uc1@example.org" });
      await approveItem(database, approveInput(item));
      const other = (await makeUser(database, "other@example.com")).id;
      expect(await newRecipientsUsedToday(database, other, utcDayStart(new Date()))).toBe(0);
      await database.delete(schema.users).where(eq(schema.users.id, userId));
      expect(await charges()).toEqual([]);
    });

    it("pinned (direct SQL only): a charge whose item is deleted while its account still exists stops counting", async () => {
      const item = await compose({ to: "ds1@example.org" });
      await approveItem(database, approveInput(item));
      expect(await used()).toBe(1);
      await database.delete(schema.approvalItems).where(eq(schema.approvalItems.id, item.id));
      expect(await used()).toBe(0);
    });
  });

  // ---- audit sweep (AC11) ------------------------------------------------------------------------

  it("audit: every compose outcome (refused, rejected, cancelled, failed, unknown, reconciled, marked not sent, IDN) holds no address, subject or body", async () => {
    const subject = "Quarterly secret plan";
    const bodyText = "Body words nobody should log";
    const addrs = ["zoe@example.org", "yuri@xn--80ak6aa92e.example", "xena@example.net"];
    const mk = (over: Partial<NewMessageInput> = {}) => compose({ to: addrs.slice(0, 2).join("\n"), cc: addrs[2], subject, bodyText, ...over });
    // Refused saves (not audited at all).
    expect((await proposeNewMessage(database, { userId, accountId: accountA.id, to: "bad token", cc: "", subject, bodyText })).ok).toBe(false);
    const rej = await mk();
    await rejectItem(database, userId, rej.id);
    nextOutcome = (n) => (n === 1 ? { kind: "failed", code: "gmail_400", status: 400 } : n === 2 ? { kind: "unknown", code: "timeout", status: null } : { kind: "succeeded", gmailMessageId: `s${n}`, gmailThreadId: `t${n}` });
    const f = await mk();
    await approveAndSend(deps(), approveInput(f));
    await cancelItem(database, userId, f.id);
    const u = await mk();
    await approveAndSend(deps(), approveInput(u));
    await database.update(schema.approvalItems).set({ executingSince: new Date(Date.now() - 2 * 3600_000) }).where(eq(schema.approvalItems.id, u.id));
    await markNotSent(database, userId, u.id, new Date());
    const blocked = await mk({ to: "fresh1@example.org\nfresh2@example.org" });
    await approveItem(database, approveInput(blocked, { newRecipientLimit: 0 }));
    const ok = await mk();
    await approveAndSend(deps(), approveInput(ok));
    const all = await audits();
    const actions = new Set(all.map((a) => a.action));
    for (const a of ["approval.proposed", "approval.rejected", "approval.execution_failed", "approval.cancelled", "approval.execution_unknown", "approval.marked_not_sent", "approval.new_recipient_limit", "approval.approved", "approval.executed"]) expect(actions, a).toContain(a);
    const blob = JSON.stringify(all.map((a) => a.detail)).toLowerCase();
    for (const needle of [...addrs, "fresh1@example.org", "xn--80ak6aa92e", "example.org", "example.net", subject, "secret", bodyText, "nobody should", "work@example.com", "bad token"]) expect(blob, needle).not.toContain(needle.toLowerCase());
  });
});
