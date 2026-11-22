import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { asc, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import type { Caps } from "@/lib/ai-ledger/config";
import { capState, emptyUsage, type AiUsage } from "@/lib/ai-ledger/ledger";
import { draftReply } from "@/lib/ai/draft";
import { runTriageStage, triageThreadNow, TRIAGE_BUDGET_GUARD_MS } from "@/lib/ai/triage";
import type { DraftInput, DraftOutcome, DraftProvider, TriageInput, TriageOutcome, TriageProvider } from "@/lib/ai/types";
import { type Sender } from "@/lib/approvals/execute";
import { approveAndSend } from "./helpers/approve";
import { emailSendPayload } from "@/lib/approvals/payload";
import { getOwnItem, replyContext, replyFormDefaults } from "@/lib/approvals/service";
import { replyThreading } from "@/lib/gmail/compose";
import { getSyncState, listInboxThreads } from "@/lib/gmail/store";
import { syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { FakeGmail, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Phase 2c with Postgres, a fake Gmail and fake AI providers (no live API calls): the triage stage
// (AC8), the ai_calls log and caps (AC6, AC7), drafts through proposeAiReply and the unchanged 2b
// approval path (AC2, AC3, AC9), the inbox triage display, and content-free audit (AC11).

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HAIKU_USAGE = (): AiUsage => ({ ...emptyUsage("anthropic-haiku", "claude-haiku-5-5", 12), inputTokens: 2_000, outputTokens: 150, thinkingTokens: 20, requestId: "req_t" }); // 275 micro-dollars
const OPUS_USAGE = (): AiUsage => ({ ...emptyUsage("anthropic-opus", "claude-opus-5-5", 30), inputTokens: 8_000, outputTokens: 3_000, thinkingTokens: 1_000, requestId: "req_d" }); // 92,000 micro-dollars
const BIG_CAPS: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 25, draftMicros: 3_000_000, totalMicros: 3_500_000 };

class FakeTriage implements TriageProvider {
  id = "anthropic-haiku";
  calls: TriageInput[] = [];
  next: (n: number, input: TriageInput) => TriageOutcome = () => ({ status: "ok", result: { category: "needs_reply", needsReply: true, summary: "Asks a question." }, errorCode: null, usage: HAIKU_USAGE() });
  async triage(input: TriageInput): Promise<TriageOutcome> {
    this.calls.push(input);
    return this.next(this.calls.length, input);
  }
}
class FakeDraft implements DraftProvider {
  id = "anthropic-opus";
  calls: DraftInput[] = [];
  next: (n: number) => DraftOutcome = () => ({ status: "ok", body: "Thanks, Wednesday works.", notes: "", errorCode: null, usage: OPUS_USAGE() });
  async draft(input: DraftInput): Promise<DraftOutcome> {
    this.calls.push(input);
    return this.next(this.calls.length);
  }
}

describe.skipIf(!testDbUrl)("AI triage and drafts (Postgres + fake Gmail + fake providers)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  let triage: FakeTriage;
  let drafter: FakeDraft;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });

  const syncDeps = (over: Partial<SyncDeps> = {}): SyncDeps => ({
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
    ...over,
  });
  const reload = async () => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
  async function runUntilEmpty(over: Partial<SyncDeps> = {}) {
    for (let i = 0; i < 20; i++) {
      await syncAccount(syncDeps(over), await reload(), "cron");
      const q = await database.select().from(schema.mailFetchQueue).where(eq(schema.mailFetchQueue.accountId, account.id));
      if ((await getSyncState(database, account.id))?.backfillStatus === "complete" && q.length === 0) return;
      clock += 5 * 60_000;
    }
  }
  const msg = (over: Partial<FakeMessage> & { id: string }): FakeMessage => ({ threadId: `t-${over.id}`, labelIds: ["INBOX"], internalDate: clock - HOUR, from: "Alice <alice@example.org>", ...over });
  const messageId = async (gmailId: string) => (await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, gmailId)))[0]!.id;
  const triageRows = async () => database.select().from(schema.mailTriage);
  const calls = async () => database.select().from(schema.aiCalls).orderBy(asc(schema.aiCalls.createdAt));
  const audits = async (prefix: string) => (await database.select().from(schema.auditLog).orderBy(asc(schema.auditLog.createdAt))).filter((a) => a.action.startsWith(prefix));
  const stage = (over: Partial<Parameters<typeof runTriageStage>[0]> = {}) =>
    runTriageStage({ db: database, provider: triage, now: () => new Date(clock), caps: BIG_CAPS, ...over }, account);

  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    gmail = new FakeGmail();
    clock = Date.now();
    triage = new FakeTriage();
    drafter = new FakeDraft();
  });

  // ---- triage stage (AC8) ----------------------------------------------------------------------

  it("triages only INBOX, non-SENT messages from the last 3 days, newest first, once (idempotent)", async () => {
    gmail.seed(msg({ id: "new1", internalDate: clock - 1 * HOUR }));
    gmail.seed(msg({ id: "new2", internalDate: clock - 2 * HOUR }));
    gmail.seed(msg({ id: "old", internalDate: clock - 4 * DAY }));
    gmail.seed(msg({ id: "sent", threadId: "t-new1", labelIds: ["SENT"], internalDate: clock - 30 * 60_000, from: "work@example.com" }));
    gmail.seed(msg({ id: "spam", internalDate: clock - 3 * HOUR }));
    await runUntilEmpty();
    // A message that later moved to Spam isn't triaged.
    await database.update(schema.mailMessages).set({ labelIds: ["SPAM"] }).where(eq(schema.mailMessages.gmailMessageId, "spam"));

    const r = await stage();
    expect(r).toEqual({ triaged: 2, failed: 0, skippedCap: 0, costUsdMicros: 550 });
    expect(triage.calls.map((c) => c.message.text)).toEqual(["Body of new1", "Body of new2"]);
    expect(triage.calls[0]!.message).toMatchObject({ source: "inbound_email", from_address: "alice@example.org", subject: "Subject new1" });
    const rows = await triageRows();
    expect(rows.map((t) => t.status)).toEqual(["ok", "ok"]);
    expect(rows[0]).toMatchObject({ category: "needs_reply", needsReply: true, summary: "Asks a question.", provider: "anthropic-haiku", model: "claude-haiku-5-5", promptVersion: "triage-v1", attempts: 1 });
    const c = await calls();
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ purpose: "triage", status: "ok", inputTokens: 2_000, outputTokens: 150, thinkingTokens: 20, costUsdMicros: 275, pricingVersion: "anthropic-2026-11-19", requestId: "req_t" });
    expect((await audits("ai.triage_run")).map((a) => a.detail)).toEqual([{ triaged: 2, failed: 0, skipped_cap: 0, costUsdMicros: 550 }]);

    expect(await stage()).toEqual({ triaged: 0, failed: 0, skippedCap: 0, costUsdMicros: 0 });
    expect(triage.calls).toHaveLength(2);
    expect((await audits("ai.triage_run")).length).toBe(1); // nothing to report the second time
  });

  it("refused and invalid are final; errors back off and stop after 3 attempts", async () => {
    gmail.seed(msg({ id: "a", internalDate: clock - 1 * HOUR }));
    gmail.seed(msg({ id: "b", internalDate: clock - 2 * HOUR }));
    gmail.seed(msg({ id: "c", internalDate: clock - 3 * HOUR }));
    await runUntilEmpty();
    triage.next = (_n, input) =>
      input.message.text === "Body of a"
        ? { status: "refused", result: null, errorCode: "refusal", usage: HAIKU_USAGE() }
        : input.message.text === "Body of b"
          ? { status: "invalid", result: null, errorCode: "schema", usage: HAIKU_USAGE() }
          : { status: "error", result: null, errorCode: "api_5xx", usage: emptyUsage("anthropic-haiku", "claude-haiku-5-5") };
    expect(await stage()).toMatchObject({ triaged: 0, failed: 3 });
    const statusOf = async (gid: string) => (await database.select().from(schema.mailTriage).where(eq(schema.mailTriage.messageId, await messageId(gid))))[0]!;
    expect((await statusOf("a")).status).toBe("refused");
    expect((await statusOf("b")).status).toBe("invalid");
    const cRow = await statusOf("c");
    expect(cRow).toMatchObject({ status: "error", attempts: 1 });
    expect(cRow.nextAttemptAt!.getTime() - clock).toBe(5 * 60_000);
    expect((await calls()).map((x) => x.status).sort()).toEqual(["error", "invalid", "refused"]);
    expect((await audits("ai.provider_error")).map((a) => a.detail)).toEqual([{ purpose: "triage", status: "api_5xx" }]);

    // Not due yet: nothing. Then attempts 2 and 3 after each backoff; then never again.
    expect((await stage()).failed).toBe(0);
    clock += 5 * 60_000;
    expect((await stage()).failed).toBe(1);
    clock += 10 * 60_000;
    expect((await stage()).failed).toBe(1);
    expect((await statusOf("c")).attempts).toBe(3);
    clock += DAY;
    expect((await stage()).failed).toBe(0);
    expect(triage.calls).toHaveLength(5);
    // The same error code again isn't re-audited (deduplicated like mail.sync_error).
    expect((await audits("ai.provider_error")).length).toBe(1);
  });

  it("daily caps: calls (exactly at the cap) and dollars; the rest is skipped until midnight UTC and audited once", async () => {
    for (let i = 0; i < 5; i++) gmail.seed(msg({ id: `m${i}`, internalDate: clock - (i + 1) * HOUR }));
    await runUntilEmpty();
    expect(await stage({ caps: { ...BIG_CAPS, triageCalls: 2 } })).toEqual({ triaged: 2, failed: 0, skippedCap: 3, costUsdMicros: 550 });
    const skipped = (await triageRows()).filter((t) => t.status === "skipped_cap");
    expect(skipped).toHaveLength(3);
    const midnight = new Date(clock);
    midnight.setUTCHours(24, 0, 0, 0);
    for (const s of skipped) expect(s.nextAttemptAt!.getTime()).toBe(midnight.getTime());
    expect(await stage({ caps: { ...BIG_CAPS, triageCalls: 2 } })).toMatchObject({ triaged: 0, skippedCap: 0 }); // not due yet
    expect((await audits("ai.cap_reached")).map((a) => a.detail)).toEqual([{ purpose: "triage", cap: "calls" }]);
    // Dollars: 550 spent; a cap of 551 allows one more call (cap + 1), a cap of 550 doesn't.
    expect(await capState(database, userId, "triage", new Date(clock), { ...BIG_CAPS, triageMicros: 550 })).toEqual({ capped: true, cap: "usd" });
    expect(await capState(database, userId, "triage", new Date(clock), { ...BIG_CAPS, triageMicros: 551 })).toEqual({ capped: false });
    expect(await capState(database, userId, "triage", new Date(clock), { ...BIG_CAPS, totalMicros: 550 })).toEqual({ capped: true, cap: "total_usd" });
    // The next UTC day they are due again.
    clock = midnight.getTime() + 60_000;
    triage.calls = [];
    const later = await runTriageStage({ db: database, provider: triage, now: () => new Date(clock), caps: BIG_CAPS }, account);
    expect(later.triaged).toBe(3);
  });

  it("a spend-limit answer pauses triage and drafts for the rest of the UTC day", async () => {
    for (let i = 0; i < 3; i++) gmail.seed(msg({ id: `s${i}`, internalDate: clock - (i + 1) * HOUR }));
    await runUntilEmpty();
    triage.next = () => ({ status: "error", result: null, errorCode: "spend_limit", usage: emptyUsage("anthropic-haiku", "claude-haiku-5-5") });
    expect(await stage()).toMatchObject({ triaged: 0, failed: 1 });
    expect(triage.calls).toHaveLength(1);
    expect(await capState(database, userId, "triage", new Date(clock), BIG_CAPS)).toEqual({ capped: true, cap: "spend_limit" });
    expect(await capState(database, userId, "draft", new Date(clock), BIG_CAPS)).toEqual({ capped: true, cap: "spend_limit" });
    expect((await audits("ai.cap_reached")).map((a) => a.detail)).toEqual([{ purpose: "triage", cap: "spend_limit" }]);
  });

  it("the run budget: no new call with less than 15 s left", async () => {
    gmail.seed(msg({ id: "b1" }));
    await runUntilEmpty();
    expect(await stage({ remainingMs: () => TRIAGE_BUDGET_GUARD_MS - 1 })).toEqual({ triaged: 0, failed: 0, skippedCap: 0, costUsdMicros: 0 });
    expect(triage.calls).toHaveLength(0);
  });

  it("in sync: cron and push runs triage when configured; connect runs and an unconfigured sync don't", async () => {
    gmail.seed(msg({ id: "x1", internalDate: clock - HOUR }));
    await runUntilEmpty(); // no triage deps: off
    expect(triage.calls).toHaveLength(0);
    await syncAccount(syncDeps({ triage: { provider: triage } }), await reload(), "connect");
    expect(triage.calls).toHaveLength(0);
    await syncAccount(syncDeps({ triage: { provider: triage } }), await reload(), "cron");
    expect(triage.calls).toHaveLength(1);
    clock += 60_000;
    gmail.deliver(msg({ id: "x2", internalDate: clock }));
    await syncAccount(syncDeps({ triage: { provider: triage } }), await reload(), "push");
    expect(triage.calls.map((c) => c.message.text)).toEqual(["Body of x1", "Body of x2"]);
    // A provider that throws never fails the sync.
    triage.triage = async () => {
      throw new Error("boom");
    };
    clock += 60_000;
    gmail.deliver(msg({ id: "x3", internalDate: clock }));
    expect((await syncAccount(syncDeps({ triage: { provider: triage } }), await reload(), "push")).outcome).toBe("ok");
  });

  it("on demand: an older thread can be triaged with 'Triage this thread'", async () => {
    gmail.seed(msg({ id: "old1", internalDate: clock - 10 * DAY }));
    await runUntilEmpty();
    expect((await stage()).triaged).toBe(0);
    const [thread] = await database.select().from(schema.mailThreads);
    expect(await triageThreadNow({ db: database, provider: triage, now: () => new Date(clock), caps: BIG_CAPS }, userId, thread!.id)).toBe("triaged");
    expect(await triageThreadNow({ db: database, provider: triage, now: () => new Date(clock), caps: BIG_CAPS }, userId, thread!.id)).toBe("already");
    const other = (await makeUser(database, "other@example.com")).id;
    expect(await triageThreadNow({ db: database, provider: triage, now: () => new Date(clock), caps: BIG_CAPS }, other, thread!.id)).toBe("not_found");
    expect(triage.calls).toHaveLength(1);
  });

  it("the inbox shows the latest inbound message's triage, and 'Needs reply' filters on it", async () => {
    gmail.seed(msg({ id: "q1", threadId: "tq", internalDate: clock - 2 * HOUR }));
    gmail.seed(msg({ id: "f1", threadId: "tf", internalDate: clock - 1 * HOUR }));
    await runUntilEmpty();
    triage.next = (_n, input) => ({
      status: "ok",
      result: input.message.text === "Body of q1" ? { category: "needs_reply", needsReply: true, summary: "Q" } : { category: "fyi", needsReply: false, summary: "F" },
      errorCode: null,
      usage: HAIKU_USAGE(),
    });
    await stage();
    const all = await listInboxThreads(database, userId, { limit: 10 });
    expect(all.map((t) => [t.subject, t.triage])).toEqual([
      ["Subject f1", { category: "fyi", needs_reply: false, summary: "F" }],
      ["Subject q1", { category: "needs_reply", needs_reply: true, summary: "Q" }],
    ]);
    expect((await listInboxThreads(database, userId, { limit: 10, needsReply: true })).map((t) => t.subject)).toEqual(["Subject q1"]);
  });

  it("ai_calls and mail_triage have no content columns (Q6)", async () => {
    const cols = async (table: string) =>
      (await database.execute(sql`select column_name from information_schema.columns where table_name = ${table} order by column_name`)).map((r) => r.column_name as string);
    expect(await cols("ai_calls")).toEqual([
      "account_id", "approval_item_id", "cache_read_tokens", "cache_write_tokens", "cost_usd_micros", "created_at", "error_code", "id", "input_tokens", "latency_ms",
      "message_id", "model", "output_tokens", "pricing_version", "provider", "purpose", "request_id", "status", "thinking_tokens", "thread_id", "user_id",
    ]);
    expect(await cols("mail_triage")).toEqual([
      "account_id", "attempts", "category", "created_at", "id", "message_id", "model", "needs_reply", "next_attempt_at", "prompt_version", "provider", "status", "summary", "thread_id", "updated_at", "user_id",
    ]);
    const src = await database.execute(sql`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'approval_source' order by e.enumsortorder`);
    expect(src.map((r) => r.enumlabel)).toEqual(["owner", "ai"]);
  });

  // ---- drafts (AC2, AC3, AC9) -------------------------------------------------------------------

  async function threadWithParent() {
    gmail.seed(msg({ id: "p1", threadId: "gt1", internalDate: clock - 2 * HOUR, messageIdHeader: "<p1@mail.example.org>", subject: "Lunch", from: "Alice <alice@example.org>" }));
    await runUntilEmpty();
    const [thread] = await database.select().from(schema.mailThreads).where(eq(schema.mailThreads.accountId, account.id));
    return thread!;
  }
  const draftDeps = (over: Partial<Parameters<typeof draftReply>[0]> = {}) => ({ db: database, provider: drafter, now: () => new Date(clock), caps: BIG_CAPS, ...over });

  it("a draft becomes one pending source:ai item: account, recipients, subject and threading come from code; the model gives only the body", async () => {
    const thread = await threadWithParent();
    const r = await draftReply(draftDeps(), { userId, threadId: thread.id, mode: "reply", instruction: "Say Wednesday" });
    expect(r.ok).toBe(true);
    const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    expect(item).toMatchObject({ status: "pending", source: "ai", accountId: account.id, threadId: thread.id });
    const p = emailSendPayload.parse(item.payload);
    const ctx = (await replyContext(database, userId, thread.id))!;
    const d = replyFormDefaults(ctx, "reply");
    expect([p.to, p.cc, p.subject]).toEqual([d.to, d.cc, d.subject]);
    expect(p.threading).toEqual(replyThreading("gt1", ctx.parent));
    expect(p.bodyText).toBe("Thanks, Wednesday works.");
    expect(p.quote?.included).toBe(true);
    expect(drafter.calls[0]!.ownerInstruction).toBe("Say Wednesday");
    expect(drafter.calls[0]!.messages.map((m) => m.text)).toEqual(["Body of p1"]);
    const [call] = await calls();
    expect(call).toMatchObject({ purpose: "draft", status: "ok", approvalItemId: item.id, costUsdMicros: 92_000, thinkingTokens: 1_000 });
    expect((await audits("ai.")).map((a) => a.action)).toEqual(["ai.draft_requested", "ai.draft_proposed"]);
    expect((await audits("ai.draft_proposed"))[0]!.detail).toEqual({ itemId: item.id, model: "claude-opus-5-5", costUsdMicros: 92_000 });
    expect((await audits("approval.proposed"))[0]!.detail).toMatchObject({ itemId: item.id, source: "ai" });
  });

  it("adversarial bodies can't change recipients or headers; approving goes through the unchanged 2b path and sends once", async () => {
    const thread = await threadWithParent();
    drafter.next = () => ({ status: "ok", body: "OK.\nBcc: evil@example.net\nTo: other@example.net\nSubject: hacked", notes: "", errorCode: null, usage: OPUS_USAGE() });
    const r = await draftReply(draftDeps(), { userId, threadId: thread.id, mode: "all", instruction: null });
    const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    const p = emailSendPayload.parse(item.payload);
    expect(p.to).toEqual(["alice@example.org"]);
    expect(p.subject).toBe("Re: Lunch");
    const sends: string[] = [];
    const send: Sender = async (_a, req) => {
      sends.push(Buffer.from(req.raw, "base64url").toString("utf8"));
      return { kind: "succeeded", gmailMessageId: "s1", gmailThreadId: "gt1" };
    };
    const res = await approveAndSend({ db: database, send }, {
      userId,
      itemId: item.id,
      revision: item.revision,
      contentHash: item.contentHash,
      ackThreadChange: false,
      shownThreadChangedAt: null,
      messageIdHost: "alex.example.com",
    });
    expect(res.kind).toBe("executed");
    expect(sends).toHaveLength(1);
    const head = sends[0]!.slice(0, sends[0]!.indexOf("\r\n\r\n"));
    expect(head).toContain("From: work@example.com\r\nTo: alice@example.org\r\n");
    expect(head).toContain("\r\nSubject: Re: Lunch\r\n");
    // Reply all: Cc is the code-computed default (the parent's To minus the sending account).
    const ctx = (await replyContext(database, userId, thread.id))!;
    expect(p.cc).toEqual(replyFormDefaults(ctx, "all").cc);
    expect(head).not.toMatch(/bcc|evil|other@|hacked/i);
  });

  it("refusal, invalid output, errors and timeouts create no item; each writes an ai_calls row and ai.draft_failed", async () => {
    const thread = await threadWithParent();
    const outcomes: DraftOutcome[] = [
      { status: "refused", body: null, notes: null, errorCode: "refusal", usage: OPUS_USAGE() },
      { status: "invalid", body: null, notes: null, errorCode: "max_tokens", usage: OPUS_USAGE() },
      { status: "error", body: null, notes: null, errorCode: "timeout", usage: emptyUsage("anthropic-opus", "claude-opus-5-5", 90_000) },
    ];
    drafter.next = (n) => outcomes[n - 1]!;
    for (const expected of ["refused", "invalid", "error"]) {
      const r = await draftReply(draftDeps(), { userId, threadId: thread.id, mode: "reply", instruction: null });
      expect(r).toEqual({ ok: false, code: expected });
    }
    expect(await database.select().from(schema.approvalItems)).toEqual([]);
    expect((await calls()).map((c) => [c.status, c.errorCode])).toEqual([
      ["refused", "refusal"],
      ["invalid", "max_tokens"],
      ["error", "timeout"],
    ]);
    expect((await audits("ai.draft_failed")).map((a) => a.detail)).toEqual([{ code: "refusal" }, { code: "max_tokens" }, { code: "timeout" }]);
  });

  it("not configured, another user's thread and the draft cap make no call", async () => {
    const thread = await threadWithParent();
    expect(await draftReply(draftDeps({ provider: null }), { userId, threadId: thread.id, mode: "reply", instruction: null })).toEqual({ ok: false, code: "not_configured" });
    const other = (await makeUser(database, "other@example.com")).id;
    expect(await draftReply(draftDeps(), { userId: other, threadId: thread.id, mode: "reply", instruction: null })).toEqual({ ok: false, code: "not_found" });
    expect(drafter.calls).toHaveLength(0);
    expect((await draftReply(draftDeps({ caps: { ...BIG_CAPS, draftCalls: 1 } }), { userId, threadId: thread.id, mode: "reply", instruction: null })).ok).toBe(true);
    expect(await draftReply(draftDeps({ caps: { ...BIG_CAPS, draftCalls: 1 } }), { userId, threadId: thread.id, mode: "reply", instruction: null })).toEqual({ ok: false, code: "capped" });
    expect(drafter.calls).toHaveLength(1);
    expect((await audits("ai.cap_reached")).map((a) => a.detail)).toEqual([{ purpose: "draft", cap: "calls" }]);
  });

  // ---- round 2 (review round 1: D1, D3, D4) ------------------------------------------------------

  it("D1: a message that lands while the model drafts flags the new AI item (thread_changed_at at propose time)", async () => {
    const thread = await threadWithParent();
    drafter.draft = async (input) => {
      drafter.calls.push(input);
      // While Opus "writes": a reply arrives and sync stores it.
      clock += 30_000;
      gmail.deliver(msg({ id: "during", threadId: "gt1", internalDate: clock, messageIdHeader: "<during@mail.example.org>" }));
      await syncAccount(syncDeps(), await reload(), "cron");
      return { status: "ok", body: "Sure.", notes: "", errorCode: null, usage: OPUS_USAGE() };
    };
    const r = await draftReply(draftDeps(), { userId, threadId: thread.id, mode: "reply", instruction: null });
    const item = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    expect(drafter.calls[0]!.messages.map((m) => m.text)).toEqual(["Body of p1"]); // the model never saw it
    expect(item.threadChangedAt).not.toBeNull();
    // Approval then needs the rendered value and the tick (B1 unchanged).
    const send: Sender = async () => ({ kind: "succeeded", gmailMessageId: "s", gmailThreadId: "gt1" });
    const base = { userId, itemId: item.id, revision: item.revision, contentHash: item.contentHash, messageIdHost: "alex.example.com" };
    expect(await approveAndSend({ db: database, send }, { ...base, ackThreadChange: false, shownThreadChangedAt: item.threadChangedAt!.getTime() })).toEqual({ kind: "approval", result: { kind: "blocked", reason: "ack_required" } });
    expect((await approveAndSend({ db: database, send }, { ...base, ackThreadChange: true, shownThreadChangedAt: item.threadChangedAt!.getTime() })).kind).toBe("executed");
  });

  it("D3: the gate cleans the body whatever the provider did: whitespace-only is invalid; controls are removed; length is capped at 20K", async () => {
    const thread = await threadWithParent();
    const ok = (body: string): DraftOutcome => ({ status: "ok", body, notes: "", errorCode: null, usage: OPUS_USAGE() });
    drafter.next = () => ok("   \n\t ");
    expect(await draftReply(draftDeps(), { userId, threadId: thread.id, mode: "reply", instruction: null })).toEqual({ ok: false, code: "invalid" });
    expect(await database.select().from(schema.approvalItems)).toEqual([]);
    expect((await calls()).at(-1)).toMatchObject({ status: "invalid", errorCode: "empty_body" });

    drafter.next = () => ok(`Hi${String.fromCharCode(0)}${String.fromCharCode(7)}\r\nthere\t!`);
    const r1 = await draftReply(draftDeps(), { userId, threadId: thread.id, mode: "reply", instruction: null });
    expect(emailSendPayload.parse((await getOwnItem(database, userId, (r1 as { itemId: string }).itemId))!.payload).bodyText).toBe("Hi\nthere\t!");

    drafter.next = () => ok("y".repeat(100_001));
    const r2 = await draftReply(draftDeps(), { userId, threadId: thread.id, mode: "reply", instruction: null });
    expect(emailSendPayload.parse((await getOwnItem(database, userId, (r2 as { itemId: string }).itemId))!.payload).bodyText).toHaveLength(20_000);
  });

  it("D4: a second draft for the same thread while one is in flight makes no model call; other threads aren't blocked", async () => {
    const thread = await threadWithParent();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    drafter.draft = async (input) => {
      drafter.calls.push(input);
      await gate;
      return { status: "ok", body: "One.", notes: "", errorCode: null, usage: OPUS_USAGE() };
    };
    const first = draftReply(draftDeps(), { userId, threadId: thread.id, mode: "reply", instruction: null });
    await new Promise((r) => setTimeout(r, 100)); // the first one is now in flight
    const others = await Promise.all(Array.from({ length: 5 }, () => draftReply(draftDeps(), { userId, threadId: thread.id, mode: "reply", instruction: null })));
    expect(others).toEqual(Array.from({ length: 5 }, () => ({ ok: false, code: "in_flight" })));
    expect(drafter.calls).toHaveLength(1);
    release();
    expect((await first).ok).toBe(true);
    expect(await database.select().from(schema.approvalItems)).toHaveLength(1);
    expect((await calls()).map((c) => c.status)).toEqual(["ok"]); // the refused ones never started a call
    // Afterwards a new draft is allowed again.
    drafter.draft = async (input) => {
      drafter.calls.push(input);
      return { status: "ok", body: "Two.", notes: "", errorCode: null, usage: OPUS_USAGE() };
    };
    expect((await draftReply(draftDeps(), { userId, threadId: thread.id, mode: "reply", instruction: null })).ok).toBe(true);
  });

  it("D4: six parallel drafts with a 1-call cap make exactly one model call (in-flight calls count)", async () => {
    const thread = await threadWithParent();
    drafter.draft = async (input) => {
      drafter.calls.push(input);
      await new Promise((r) => setTimeout(r, 50));
      return { status: "ok", body: "Once.", notes: "", errorCode: null, usage: OPUS_USAGE() };
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => draftReply(draftDeps({ caps: { ...BIG_CAPS, draftCalls: 1 } }), { userId, threadId: thread.id, mode: "reply", instruction: null })));
    expect(drafter.calls).toHaveLength(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && (r.code === "in_flight" || r.code === "capped"))).toBe(true);
    expect(await database.select().from(schema.approvalItems)).toHaveLength(1);
  });

  it("D4: a pending draft on another thread counts toward the call cap; a crashed attempt older than 3 minutes is cleared", async () => {
    const thread = await threadWithParent();
    gmail.deliver(msg({ id: "o1", threadId: "gt2", internalDate: clock - HOUR }));
    await syncAccount(syncDeps(), await reload(), "cron");
    const [other] = (await database.select().from(schema.mailThreads)).filter((t) => t.id !== thread.id);
    // A crashed attempt on the other thread, started just now: it counts toward a 1-call cap.
    await database.insert(schema.aiCalls).values({ userId, accountId: account.id, threadId: other!.id, purpose: "draft", provider: "anthropic-opus", model: "claude-opus-5-5", status: "pending", createdAt: new Date(clock) });
    expect(await draftReply(draftDeps({ caps: { ...BIG_CAPS, draftCalls: 1 } }), { userId, threadId: thread.id, mode: "reply", instruction: null })).toEqual({ ok: false, code: "capped" });
    // A crashed attempt on this thread doesn't block it forever: after 3 minutes it is closed as abandoned.
    await database.delete(schema.aiCalls);
    await database.insert(schema.aiCalls).values({ userId, accountId: account.id, threadId: thread.id, purpose: "draft", provider: "anthropic-opus", model: "claude-opus-5-5", status: "pending", createdAt: new Date(clock) });
    expect(await draftReply(draftDeps(), { userId, threadId: thread.id, mode: "reply", instruction: null })).toEqual({ ok: false, code: "in_flight" });
    clock += 3 * 60_000 + 1_000;
    expect((await draftReply(draftDeps(), { userId, threadId: thread.id, mode: "reply", instruction: null })).ok).toBe(true);
    expect((await calls()).map((c) => [c.status, c.errorCode])).toEqual([
      ["error", "abandoned"],
      ["ok", null],
    ]);
  });

  it("no ai.* or approval.* audit detail contains an address, the subject, the body, the summary or the instruction", async () => {
    gmail.seed(msg({ id: "z1", internalDate: clock - HOUR, subject: "SECRETSUBJECT", from: "Zed <zed@example.org>" }));
    await runUntilEmpty();
    triage.next = () => ({ status: "ok", result: { category: "fyi", needsReply: false, summary: "SECRETSUMMARY" }, errorCode: null, usage: HAIKU_USAGE() });
    await stage();
    const [thread] = await database.select().from(schema.mailThreads);
    drafter.next = () => ({ status: "ok", body: "SECRETBODY", notes: "SECRETNOTES", errorCode: null, usage: OPUS_USAGE() });
    await draftReply(draftDeps(), { userId, threadId: thread!.id, mode: "reply", instruction: "SECRETINSTRUCTION" });
    drafter.next = () => ({ status: "refused", body: null, notes: null, errorCode: "refusal", usage: OPUS_USAGE() });
    await draftReply(draftDeps(), { userId, threadId: thread!.id, mode: "reply", instruction: "SECRETINSTRUCTION" });
    const rows = [...(await audits("ai.")), ...(await audits("approval."))];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const a of rows) expect(JSON.stringify(a.detail), a.action).not.toMatch(/@|SECRET|example/i);
  });
});
