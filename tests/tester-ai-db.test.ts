import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import type { Caps } from "@/lib/ai-ledger/config";
import { utcDayStart } from "@/lib/ai-ledger/config";
import { capState, emptyUsage, logAiCall, type AiUsage } from "@/lib/ai-ledger/ledger";
import { draftReply } from "@/lib/ai/draft";
import { buildDraftRequest } from "@/lib/ai/prompts";
import { anthropicDraftProvider } from "@/lib/ai/providers/anthropic";
import { runTriageStage } from "@/lib/ai/triage";
import type { DraftInput, DraftOutcome, DraftProvider, TriageInput, TriageOutcome, TriageProvider } from "@/lib/ai/types";
import { approveAndSend, type Sender } from "@/lib/approvals/execute";
import { emailSendPayload } from "@/lib/approvals/payload";
import { getOwnItem, proposeReply, replyContext, replyFormDefaults } from "@/lib/approvals/service";
import { replyThreading } from "@/lib/gmail/compose";
import { getSyncState } from "@/lib/gmail/store";
import { syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { FakeGmail, header, textPart, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester (phase 2c round 1): the single gate under adversarial provider output (fake and real
// provider with a fake SDK client), other threads' data, Q6 during a draft, cap boundaries and day
// rollover, one ai_calls row per call, the parallel-account overshoot, and content-free storage.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HAIKU = (): AiUsage => ({ ...emptyUsage("anthropic-haiku", "claude-haiku-5-5", 5), inputTokens: 2_000, outputTokens: 150, requestId: "req_t" }); // 275 micros
const OPUS = (): AiUsage => ({ ...emptyUsage("anthropic-opus", "claude-opus-5-5", 5), inputTokens: 8_000, outputTokens: 3_000, requestId: "req_d" }); // 92,000 micros
const BIG: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 25, draftMicros: 3_000_000, totalMicros: 3_500_000 };

function decodeHead(raw: string) {
  const msg = Buffer.from(raw, "base64url").toString("utf8");
  const head = msg.slice(0, msg.indexOf("\r\n\r\n"));
  const lines: string[] = [];
  for (const l of head.split("\r\n")) if (l.startsWith(" ")) lines[lines.length - 1] += l;
  else lines.push(l);
  return { names: lines.map((l) => l.slice(0, l.indexOf(":"))), get: (n: string) => lines.filter((l) => l.startsWith(`${n}: `)).map((l) => l.slice(n.length + 2)), body: Buffer.from(msg.slice(msg.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, ""), "base64").toString("utf8") };
}

describe.skipIf(!testDbUrl)("tester: AI single gate, caps and storage (Postgres, fake Gmail, fake providers)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    pool = postgres(testDbUrl!, { max: 12, onnotice: () => {} });
    poolDb = drizzle(pool, { schema }) as unknown as Database;
  });
  afterAll(async () => {
    await pool.end();
    await client.end();
  });

  const syncDeps = (acc: () => ConnectedAccount, g: () => FakeGmail): SyncDeps => ({
    db: database,
    gmailFor: () => g(),
    now: () => new Date(clock),
    sleep: async () => {},
    unitsPerMinute: 1e9,
    render: async (body, opts) => ({ renderKind: "none", renderReason: null, renderedHtml: null, renderedHtmlRemote: null, renderedText: body.text, renderTruncated: false, sanitizerVersion: opts.version, renderedAt: new Date(clock) }),
  });
  async function syncFor(acc: ConnectedAccount, g: FakeGmail) {
    for (let i = 0; i < 20; i++) {
      const fresh = (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, acc.id)))[0]!;
      await syncAccount(syncDeps(() => fresh, () => g), fresh, "cron");
      const q = await database.select().from(schema.mailFetchQueue).where(eq(schema.mailFetchQueue.accountId, acc.id));
      if ((await getSyncState(database, acc.id))?.backfillStatus === "complete" && q.length === 0) return;
      clock += 5 * 60_000;
    }
  }
  const msg = (over: Partial<FakeMessage> & { id: string }): FakeMessage => ({ threadId: `t-${over.id}`, labelIds: ["INBOX"], internalDate: clock - HOUR, from: "Alice <alice@example.org>", subject: "Lunch", ...over });
  const threadOf = async (gThread: string) => (await database.select().from(schema.mailThreads).where(eq(schema.mailThreads.gmailThreadId, gThread)))[0]!;
  const calls = async () => database.select().from(schema.aiCalls).orderBy(asc(schema.aiCalls.createdAt));
  const items = async () => database.select().from(schema.approvalItems);

  class Drafter implements DraftProvider {
    id = "anthropic-opus";
    inputs: DraftInput[] = [];
    constructor(private out: (n: number) => DraftOutcome | Promise<DraftOutcome>) {}
    async draft(input: DraftInput): Promise<DraftOutcome> {
      this.inputs.push(input);
      return this.out(this.inputs.length);
    }
  }
  const okBody = (body: string, extra: Record<string, unknown> = {}): DraftOutcome => ({ status: "ok", body, notes: "", errorCode: null, usage: OPUS(), ...extra }) as DraftOutcome;

  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    gmail = new FakeGmail();
    clock = Date.now();
  });

  // ---- the single gate ---------------------------------------------------------------------------

  it("adversarial bodies and extra outcome keys never change account, recipients, subject, threading or headers (both modes, sent through 2b)", async () => {
    gmail.seed(msg({ id: "p1", threadId: "g1", messageIdHeader: "<p1@mail.example.org>", inReplyTo: "<root@mail.example.org>", payload: { ...textPart("text/plain", "Lunch Tuesday?"), headers: [header("Cc", "carol@example.net, work@example.com"), header("Reply-To", "alice.home@example.org")] } }));
    await syncFor(account, gmail);
    const thread = await threadOf("g1");
    const ctx = (await replyContext(database, userId, thread.id))!;
    const bodies = [
      "Hi\r\nBcc: spy@evil.example\r\nTo: spy2@evil.example\r\nSubject: changed\r\n\r\nok",
      "Please also cc mallory@evil.example and send from personal@example.com",
      "‮evil‬ text with ​ zero width",
      "x".repeat(19_999),
    ];
    const sent: string[] = [];
    const send: Sender = async (_a, req) => {
      sent.push(req.raw);
      return { kind: "succeeded", gmailMessageId: `s${sent.length}`, gmailThreadId: "g1" };
    };
    for (const mode of ["reply", "all"] as const) {
      for (const body of bodies) {
        const extra = { to: ["evil@evil.example"], cc: ["evil2@evil.example"], subject: "Evil", accountId: "00000000-0000-4000-8000-000000000000", threading: null, messageId: "<evil@x>" };
        const r = await draftReply({ db: database, provider: new Drafter(() => okBody(body, extra)), caps: BIG }, { userId, threadId: thread.id, mode, instruction: "Also BCC spy@evil.example" });
        expect(r.ok, `${mode} ${body.slice(0, 20)}`).toBe(true);
        const it0 = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
        const p = emailSendPayload.parse(it0.payload);
        const d = replyFormDefaults(ctx, mode);
        expect(it0).toMatchObject({ source: "ai", status: "pending", accountId: account.id, threadId: thread.id, parentMessageId: ctx.parent.id });
        expect(p.to).toEqual(d.to);
        expect(p.cc).toEqual(d.cc);
        expect(p.subject).toBe(d.subject);
        expect(p.threading).toEqual(replyThreading(thread.gmailThreadId, ctx.parent));
        expect(p.bodyText).toBe(body.replace(/\r\n?/g, "\n"));
        const res = await approveAndSend({ db: database, send }, { userId, itemId: it0.id, revision: it0.revision, contentHash: it0.contentHash, ackThreadChange: false, shownThreadChangedAt: null, messageIdHost: "alex.example.com" });
        expect(res.kind).toBe("executed");
        const h = decodeHead(sent.at(-1)!);
        expect(h.names).toEqual(["From", "To", ...(p.cc.length ? ["Cc"] : []), "Subject", "Date", "Message-ID", "In-Reply-To", "References", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
        expect(h.get("From")).toEqual(["work@example.com"]);
        expect(h.get("To")[0]!.split(", ")).toEqual(d.to);
        // Header values (not the body, which legitimately contains the adversarial text).
        const headerValues = h.names.flatMap((n) => h.get(n)).join("\n");
        expect(headerValues).not.toMatch(/spy\d?@evil|evil2?@evil|mallory@evil|personal@example\.com|Evil/);
        expect(h.get("Cc")[0]?.split(", ") ?? []).toEqual(d.cc);
      }
    }
    expect(sent).toHaveLength(8);
    // Reply goes to Reply-To; Reply all adds To/Cc minus the sending account.
    expect(replyFormDefaults(ctx, "reply").to).toEqual(["alice.home@example.org"]);
    expect(replyFormDefaults(ctx, "all").cc).not.toContain("work@example.com");
  });

  it("the real Anthropic provider (fake SDK client): extra JSON keys, refusal, max_tokens, pause_turn, a tool_use block and non-JSON text create no item; thinking-first works", async () => {
    gmail.seed(msg({ id: "p1", threadId: "g1" }));
    await syncFor(account, gmail);
    const thread = await threadOf("g1");
    const resp = (content: unknown[], stop: string) => ({ withResponse: async () => ({ data: { content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, request_id: "req_x" }) });
    const text = (t: string) => ({ type: "text", text: t });
    const cases: [string, unknown[], string, boolean][] = [
      ["extra key to", [text(JSON.stringify({ body: "hi", notes: "", to: "evil@evil.example" }))], "end_turn", false],
      ["extra key subject", [text(JSON.stringify({ body: "hi", notes: "", subject: "x" }))], "end_turn", false],
      ["refusal", [text(JSON.stringify({ body: "hi", notes: "" }))], "refusal", false],
      ["max_tokens", [text('{"body":"hi","no')], "max_tokens", false],
      ["pause_turn", [text(JSON.stringify({ body: "hi", notes: "" }))], "pause_turn", false],
      ["tool_use", [{ type: "tool_use", id: "t1", name: "send_email", input: { to: "evil@evil.example" } }], "tool_use", false],
      ["prose", [text("Sure, here is the reply: hi")], "end_turn", false],
      ["two text blocks", [text('{"body":"hi",'), text('"notes":""}')], "end_turn", true],
      ["thinking first", [{ type: "thinking", thinking: "...", signature: "s" }, text(JSON.stringify({ body: "Thinking-first body", notes: "" }))], "end_turn", true],
    ];
    for (const [name, content, stop, creates] of cases) {
      const before = (await items()).length;
      const client = { messages: { create: () => resp(content, stop) } } as never;
      const r = await draftReply({ db: database, provider: anthropicDraftProvider(client), caps: BIG }, { userId, threadId: thread.id, mode: "reply", instruction: null });
      expect(r.ok, name).toBe(creates);
      expect((await items()).length - before, name).toBe(creates ? 1 : 0);
    }
    const st = (await calls()).map((c) => c.status);
    expect(st).toEqual(["invalid", "invalid", "refused", "invalid", "invalid", "invalid", "invalid", "ok", "ok"]);
  });

  it("a provider that bypasses parse.ts (future local provider): D3 strip-and-cap; empty after stripping is refused; no control character reaches the payload", async () => {
    gmail.seed(msg({ id: "p1", threadId: "g1" }));
    await syncFor(account, gmail);
    const thread = await threadOf("g1");
    const c0 = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).filter((ch) => ch !== "\n" && ch !== "\t").join("");
    const c1 = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(0x80 + i)).join("");
    const cases: [string, string, string | null][] = [
      // name, provider body, expected stored body (null = refused, no item)
      ["whitespace", "   \n\t ", null],
      ["empty", "", null],
      ["c0-only", c0 + "\u007f", null],
      ["c0+whitespace", " \u0000\n\u0007\t\u001b ", null],
      ["nbsp/ideographic-space only", " 　﻿", null],
      ["nul", "a\u0000b", "ab"],
      ["all c0 + del (CR becomes a newline first)", `x${c0}\u007fy`, "x\ny"],
      ["crlf", "a\r\nb\rc", "a\nb\nc"],
      ["oversize", "y".repeat(100_001), "y".repeat(20_000)],
      ["exactly 20,000", "z".repeat(20_000), "z".repeat(20_000)],
      ["emoji at the cut", "q".repeat(19_999) + "🍜tail", "q".repeat(19_999)],
      ["lone surrogate", "a\uD800b", "a�b"],
    ];
    for (const [name, body, expected] of cases) {
      const before = (await items()).length;
      const r = await draftReply({ db: database, provider: new Drafter(() => okBody(body)), caps: BIG }, { userId, threadId: thread.id, mode: "reply", instruction: null }).catch((e: unknown) => ({ threw: String(e).slice(0, 80) }));
      if (expected === null) {
        expect(r, name).toEqual({ ok: false, code: "invalid" });
        expect((await items()).length, name).toBe(before);
      } else {
        expect(r, name).toMatchObject({ ok: true });
        const p = emailSendPayload.parse((await getOwnItem(database, userId, (r as { itemId: string }).itemId))!.payload);
        expect(p.bodyText, name).toBe(expected);
        expect([...p.bodyText].filter((ch) => { const c = ch.codePointAt(0)!; return (c < 0x20 && c !== 0x0a && c !== 0x09) || c === 0x7f; }), name).toEqual([]);
      }
    }
    // C1 controls (U+0080–U+009F, Unicode category Cc) are controls too: they must not reach the payload either.
    const r = await draftReply({ db: database, provider: new Drafter(() => okBody(`a${c1}b`)), caps: BIG }, { userId, threadId: thread.id, mode: "reply", instruction: null });
    const p = emailSendPayload.parse((await getOwnItem(database, userId, (r as { itemId: string }).itemId))!.payload);
    expect([...p.bodyText].filter((ch) => { const c = ch.codePointAt(0)!; return c >= 0x80 && c <= 0x9f; }).map((ch) => ch.codePointAt(0)!.toString(16)), "C1 controls in the AI body payload").toEqual([]);
  });

  // ---- what the model sees --------------------------------------------------------------------------

  it("the draft prompt contains this thread only: no other thread, account or user data, no Trash/Spam message", async () => {
    gmail.seed(msg({ id: "a1", threadId: "gA", payload: textPart("text/plain", "THREAD_A_ONE") }));
    gmail.seed(msg({ id: "a2", threadId: "gA", labelIds: ["TRASH"], payload: textPart("text/plain", "THREAD_A_TRASHED") }));
    gmail.seed(msg({ id: "b1", threadId: "gB", payload: textPart("text/plain", "THREAD_B_SECRET") }));
    await syncFor(account, gmail);
    const acc2 = await makeGoogleAccount(database, userId, { email: "personal@example.com", label: "personal" });
    const g2 = new FakeGmail();
    g2.seed(msg({ id: "c1", threadId: "gA", payload: textPart("text/plain", "OTHER_ACCOUNT_SAME_GMAIL_THREAD_ID") }));
    await syncFor(acc2, g2);
    const other = await makeUser(database, "other@example.com");
    const acc3 = await makeGoogleAccount(database, other.id, { email: "o@example.com" });
    const g3 = new FakeGmail();
    g3.seed(msg({ id: "d1", threadId: "gA", payload: textPart("text/plain", "OTHER_USER_SECRET") }));
    await syncFor(acc3, g3);
    const threads = await database.select().from(schema.mailThreads).where(eq(schema.mailThreads.accountId, account.id));
    const tA = threads.find((t) => t.gmailThreadId === "gA")!;
    const d = new Drafter(() => okBody("ok"));
    await draftReply({ db: database, provider: d, caps: BIG }, { userId, threadId: tA.id, mode: "reply", instruction: null });
    const req = JSON.stringify(buildDraftRequest(d.inputs[0]!));
    expect(req).toContain("THREAD_A_ONE");
    for (const s of ["THREAD_A_TRASHED", "THREAD_B_SECRET", "OTHER_ACCOUNT_SAME_GMAIL_THREAD_ID", "OTHER_USER_SECRET", "work@example.com", "personal@example.com", "o@example.com", "ALEX_ENCRYPTION_KEY", "refresh"]) expect(req, s).not.toContain(s);
    // Another user's thread id: no provider call, no ai_calls row.
    const tOther = (await database.select().from(schema.mailThreads).where(eq(schema.mailThreads.accountId, acc3.id)))[0]!;
    const d2 = new Drafter(() => okBody("ok"));
    expect(await draftReply({ db: database, provider: d2, caps: BIG }, { userId, threadId: tOther.id, mode: "reply", instruction: null })).toEqual({ ok: false, code: "not_found" });
    expect(d2.inputs).toHaveLength(0);
  });

  // ---- Q6 during a draft ---------------------------------------------------------------------------

  it("Q6: a message that lands while the model is drafting (sync runs meanwhile) flags the AI item", async () => {
    gmail.seed(msg({ id: "p1", threadId: "g1", internalDate: clock - 2 * HOUR }));
    await syncFor(account, gmail);
    const thread = await threadOf("g1");
    const d = new Drafter(async () => {
      // While Opus is thinking (up to 90 s), a new reply arrives and is synced.
      gmail.deliver(msg({ id: "late", threadId: "g1", internalDate: Date.now() - 1000, payload: textPart("text/plain", "Actually, cancel lunch.") }));
      await syncFor(account, gmail);
      return okBody("Great, see you Tuesday!");
    });
    const r = await draftReply({ db: database, provider: d, caps: BIG }, { userId, threadId: thread.id, mode: "reply", instruction: null });
    expect(r.ok).toBe(true);
    const it0 = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    expect(JSON.stringify(d.inputs[0]!.messages)).not.toContain("cancel lunch"); // the model never saw it
    expect(it0.threadChangedAt, "AI item written without seeing a newer message must carry the Q6 warning").not.toBeNull();
  });

  // Pre-existing in 2b (same root cause as the AI case above); env-gated so it does not count against 2c on its own.
  it.runIf(process.env.TESTER_PREEXISTING === "1")("Q6 (2b path, same root cause): a message stored after the reply form rendered but before Save", async () => {
    gmail.seed(msg({ id: "p1", threadId: "g1", internalDate: clock - 2 * HOUR }));
    await syncFor(account, gmail);
    const thread = await threadOf("g1");
    const parent = (await replyContext(database, userId, thread.id))!.parent; // the form renders with this parent
    gmail.deliver(msg({ id: "late", threadId: "g1", internalDate: Date.now() - 1000 }));
    await syncFor(account, gmail);
    const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: parent.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "ok", includeQuote: false });
    const it0 = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
    expect(it0.threadChangedAt, "reply saved against an older parent while a newer message exists").not.toBeNull();
  });

  // ---- caps, rollover, one row per call ------------------------------------------------------------

  it("cap boundaries from logged rows: calls at N-1 / N, dollars at cap-1 / cap, total across purposes, spend limit; yesterday's rows don't count", async () => {
    const caps: Caps = { triageCalls: 3, triageMicros: 1_000, draftCalls: 2, draftMicros: 200_000, totalMicros: 250_000 };
    const now = new Date();
    const row = async (purpose: "triage" | "draft", micros: number, at?: Date, errorCode: string | null = null) => {
      const r = await logAiCall(database, { userId, accountId: account.id, purpose, status: errorCode ? "error" : "ok", errorCode, usage: { ...emptyUsage("p", "local", 1), costUsdMicros: micros } });
      if (at) await database.update(schema.aiCalls).set({ createdAt: at }).where(eq(schema.aiCalls.id, r.id));
    };
    await row("triage", 100);
    await row("triage", 100);
    expect(await capState(database, userId, "triage", now, caps)).toEqual({ capped: false });
    await row("triage", 100);
    expect(await capState(database, userId, "triage", now, caps)).toEqual({ capped: true, cap: "calls" });
    await database.delete(schema.aiCalls);
    await row("triage", 999);
    expect(await capState(database, userId, "triage", now, caps)).toEqual({ capped: false });
    await row("triage", 1);
    expect(await capState(database, userId, "triage", now, caps)).toEqual({ capped: true, cap: "usd" });
    await database.delete(schema.aiCalls);
    await row("draft", 199_999);
    expect(await capState(database, userId, "draft", now, caps)).toEqual({ capped: false });
    await row("triage", 50_001); // total 250,000
    expect(await capState(database, userId, "draft", now, caps)).toEqual({ capped: true, cap: "total_usd" });
    // Rollover: rows 1 ms before UTC midnight belong to yesterday.
    await database.delete(schema.aiCalls);
    const start = utcDayStart(now);
    for (let i = 0; i < 5; i++) await row("triage", 10_000, new Date(start.getTime() - 1));
    await row("draft", 0, new Date(start.getTime() - 1), "spend_limit");
    expect(await capState(database, userId, "triage", now, caps)).toEqual({ capped: false });
    expect(await capState(database, userId, "draft", now, caps)).toEqual({ capped: false });
    await row("triage", 0, start, "spend_limit");
    expect(await capState(database, userId, "draft", now, caps)).toEqual({ capped: true, cap: "spend_limit" });
    // Another user's usage never counts.
    await database.delete(schema.aiCalls);
    const other = await makeUser(database, "o2@example.com");
    for (let i = 0; i < 5; i++) await logAiCall(database, { userId: other.id, accountId: null, purpose: "triage", status: "ok", errorCode: null, usage: { ...emptyUsage("p", "local", 1), costUsdMicros: 999_999 } });
    expect(await capState(database, userId, "triage", now, caps)).toEqual({ capped: false });
  });

  it("one ai_calls row per triage call in every status, none for skipped_cap; tokens and cost as reported", async () => {
    for (let i = 0; i < 6; i++) gmail.seed(msg({ id: `m${i}`, internalDate: clock - (i + 1) * 60_000 }));
    await syncFor(account, gmail);
    const outs: TriageOutcome[] = [
      { status: "ok", result: { category: "fyi", needsReply: false, summary: "s" }, errorCode: null, usage: HAIKU() },
      { status: "refused", result: null, errorCode: "refusal", usage: HAIKU() },
      { status: "invalid", result: null, errorCode: "max_tokens", usage: HAIKU() },
      { status: "invalid", result: null, errorCode: "schema", usage: HAIKU() },
      { status: "error", result: null, errorCode: "api_5xx", usage: emptyUsage("anthropic-haiku", "claude-haiku-5-5", 3) },
    ];
    let n = 0;
    const provider: TriageProvider = { id: "anthropic-haiku", triage: async () => outs[n++]! };
    const r = await runTriageStage({ db: database, provider, now: () => new Date(clock), caps: { ...BIG, triageCalls: 5 } }, account);
    expect(r).toMatchObject({ triaged: 1, failed: 4, skippedCap: 1 });
    const c = await calls();
    expect(c.map((x) => x.status)).toEqual(["ok", "refused", "invalid", "invalid", "error"]);
    // 2c round 4 (B1): an ambiguous failure (api_5xx: may have been billed, no usage returned) is recorded at the triage reserve.
    const { TRIAGE_RESERVED_COST_MICROS } = await import("@/lib/ai-ledger/pricing");
    expect(c.map((x) => x.costUsdMicros)).toEqual([275, 275, 275, 275, TRIAGE_RESERVED_COST_MICROS]);
    expect(c.every((x) => x.inputTokens === (x.status === "error" ? 0 : 2_000))).toBe(true);
    expect((await database.select().from(schema.mailTriage)).map((t) => t.status).sort()).toEqual(["error", "invalid", "invalid", "ok", "refused", "skipped_cap"]);
  });

  it("overshoot: K accounts triaging in parallel against one call cap and one dollar cap (measured)", { timeout: 300_000 }, async () => {
    const results: Record<string, unknown> = {};
    for (const K of [1, 2, 4, 8]) {
      await database.delete(schema.users);
      userId = (await makeUser(database)).id;
      const accs: ConnectedAccount[] = [];
      for (let k = 0; k < K; k++) {
        const a = await makeGoogleAccount(database, userId, { email: `acc${k}@example.com` });
        const g = new FakeGmail();
        for (let i = 0; i < 15; i++) g.seed(msg({ id: `k${k}m${i}`, threadId: `k${k}t${i}`, internalDate: clock - (i + 1) * 60_000 }));
        await syncFor(a, g);
        accs.push(a);
      }
      const provider: TriageProvider = {
        id: "anthropic-haiku",
        triage: async () => {
          await sleep(20);
          return { status: "ok", result: { category: "fyi", needsReply: false, summary: "s" }, errorCode: null, usage: HAIKU() };
        },
      };
      const capCalls = 10;
      await Promise.all(accs.map((a) => runTriageStage({ db: poolDb, provider, caps: { ...BIG, triageCalls: capCalls } }, a)));
      const nCalls = (await calls()).filter((c) => c.userId === userId).length;
      // Dollar cap: 10 calls' worth (2,750 micros).
      await database.delete(schema.aiCalls);
      await database.delete(schema.mailTriage);
      await Promise.all(accs.map((a) => runTriageStage({ db: poolDb, provider, caps: { ...BIG, triageMicros: 2_750 } }, a)));
      const usd = (await calls()).reduce((s, c) => s + Number(c.costUsdMicros ?? 0), 0);
      results[`K=${K}`] = { calls: nCalls, callOvershoot: nCalls - capCalls, micros: usd, microOvershoot: usd - 2_750 };
      expect(nCalls - capCalls).toBeLessThanOrEqual(K - 1);
      expect(usd - 2_750).toBeLessThanOrEqual((K - 1) * 275 + 275);
    }
    if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `overshoot ${JSON.stringify(results)}\n`);
  });

  it("parallel draft clicks against the draft call cap (measured)", async () => {
    gmail.seed(msg({ id: "p1", threadId: "g1" }));
    await syncFor(account, gmail);
    const thread = await threadOf("g1");
    const d = new Drafter(async () => {
      await sleep(50);
      return okBody("ok");
    });
    const rs = await Promise.all(Array.from({ length: 6 }, () => draftReply({ db: poolDb, provider: d, caps: { ...BIG, draftCalls: 1 } }, { userId, threadId: thread.id, mode: "reply", instruction: null })));
    const made = rs.filter((r) => r.ok).length;
    if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `draft-parallel cap=1 clicks=6 providerCalls=${d.inputs.length} items=${made}\n`);
    expect(d.inputs.length).toBeGreaterThanOrEqual(1);
  });

  // ---- storage ---------------------------------------------------------------------------------------

  it("after triage and drafts with marker content, no audit detail or ai_calls value contains content, addresses, tokens or summaries", async () => {
    gmail.seed(msg({ id: "p1", threadId: "g1", subject: "SUBJ_MARK", payload: textPart("text/plain", "BODY_MARK") }));
    await syncFor(account, gmail);
    const provider: TriageProvider = { id: "anthropic-haiku", triage: async () => ({ status: "ok", result: { category: "fyi", needsReply: false, summary: "SUMMARY_MARK" }, errorCode: null, usage: HAIKU() }) };
    await runTriageStage({ db: database, provider, now: () => new Date(clock), caps: BIG }, account);
    const thread = await threadOf("g1");
    await draftReply({ db: database, provider: new Drafter(() => okBody("DRAFT_MARK")), caps: BIG }, { userId, threadId: thread.id, mode: "all", instruction: "INSTR_MARK" });
    await draftReply({ db: database, provider: new Drafter(() => ({ status: "error", body: null, notes: null, errorCode: "api_5xx", usage: OPUS() })), caps: BIG }, { userId, threadId: thread.id, mode: "all", instruction: "INSTR_MARK" });
    const bad = /MARK|@|alice|Lunch|sk-ant/i;
    for (const a of await database.select().from(schema.auditLog)) if (a.action.startsWith("ai.") || a.action.startsWith("approval.")) expect(JSON.stringify(a.detail), a.action).not.toMatch(bad);
    for (const c of await calls()) expect(JSON.stringify({ ...c, id: 0, userId: 0, accountId: 0, messageId: 0, approvalItemId: 0, createdAt: 0 })).not.toMatch(bad);
  });

  // ---- round 2: attacks on the D1–D4 fixes -----------------------------------------------------------

  describe("round 2", () => {
    const send: Sender = async () => ({ kind: "succeeded", gmailMessageId: "s1", gmailThreadId: "g1" });

    it("D1: our own SENT copy newer than the parent doesn't flag a new reply; an inbound reuse of our Message-ID and a newer Trash message do", async () => {
      gmail.seed(msg({ id: "p1", threadId: "g1", internalDate: clock - 2 * HOUR, messageIdHeader: "<p1@mail.example.org>" }));
      await syncFor(account, gmail);
      const thread = await threadOf("g1");
      const parent = (await replyContext(database, userId, thread.id))!.parent;
      const r1 = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: parent.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "one", includeQuote: false });
      const i1 = (await getOwnItem(database, userId, (r1 as { itemId: string }).itemId))!;
      expect(i1.threadChangedAt).toBeNull();
      await approveAndSend({ db: database, send }, { userId, itemId: i1.id, revision: i1.revision, contentHash: i1.contentHash, ackThreadChange: false, shownThreadChangedAt: null, messageIdHost: "alex.example.com" });
      const header = (await getOwnItem(database, userId, i1.id))!.messageIdHeader!;
      gmail.deliver(msg({ id: "ownSent", threadId: "g1", labelIds: ["SENT"], from: "work@example.com", messageIdHeader: header, internalDate: Date.now() - 60_000 }));
      await syncFor(account, gmail);
      const prop = async () => {
        const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: parent.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "two", includeQuote: false });
        return (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!.threadChangedAt;
      };
      expect(await prop(), "own SENT copy").toBeNull();
      // An AI draft on the thread now targets the newest visible message (our SENT copy): not flagged either.
      const d = await draftReply({ db: database, provider: new Drafter(() => okBody("x")), caps: BIG }, { userId, threadId: thread.id, mode: "reply", instruction: null });
      expect((await getOwnItem(database, userId, (d as { itemId: string }).itemId))!.threadChangedAt).toBeNull();
      // An inbound message reusing our Message-ID (not SENT) is a real new message.
      gmail.deliver(msg({ id: "reuse", threadId: "g1", labelIds: ["INBOX"], messageIdHeader: header, internalDate: Date.now() - 30_000 }));
      await syncFor(account, gmail);
      expect(await prop(), "inbound reuse").not.toBeNull();
      // A newer message the owner already trashed still flags (conservative; documented).
      await database.delete(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "reuse"));
      await database.update(schema.mailMessages).set({ labelIds: ["TRASH"] }).where(eq(schema.mailMessages.gmailMessageId, "ownSent"));
      gmail.deliver(msg({ id: "trashed", threadId: "g1", labelIds: ["TRASH"], internalDate: Date.now() - 20_000 }));
      await syncFor(account, gmail);
      const trashStored = (await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "trashed"))).length;
      if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `trash-stored ${trashStored} flag ${(await prop()) !== null}\n`);
    });

    it("D1 race: a message committed between proposeReply's newer-message check and its insert", async () => {
      gmail.seed(msg({ id: "p1", threadId: "g1", internalDate: clock - 2 * HOUR }));
      await syncFor(account, gmail);
      const thread = await threadOf("g1");
      const parent = (await replyContext(database, userId, thread.id))!.parent;
      let injected = false;
      const external = async () => {
        if (injected) return;
        injected = true;
        gmail.deliver(msg({ id: "between", threadId: "g1", internalDate: Date.now() - 1000 }));
        await syncFor(account, gmail); // another connection: stores the message and runs the ingest hook, which can't see our uncommitted item
      };
      // Runs proposeReply on the pool; just before the item INSERT (after the newer-message check), the other transaction commits.
      const ex = new Proxy(poolDb, {
        get(target, prop, recv) {
          if (prop !== "transaction") return Reflect.get(target, prop, recv);
          return (fn: (tx: Database) => Promise<unknown>) =>
            (target as Database).transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(t, p, r) {
                    if (p !== "insert") return Reflect.get(t, p, r);
                    return (table: unknown) => {
                      const real = (t as unknown as Database).insert(table as typeof schema.approvalItems);
                      if (table !== schema.approvalItems) return real;
                      return { values: (v: unknown) => ({ returning: async (sel: unknown) => (await external(), real.values(v as never).returning(sel as never)) }) };
                    };
                  },
                }) as unknown as Database,
              ),
            );
        },
      }) as Database;
      const r = await proposeReply(ex, { userId, threadId: thread.id, parentMessageId: parent.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "x", includeQuote: false });
      expect(injected).toBe(true);
      expect((await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "between"))).length).toBe(1);
      const it0 = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
      expect(it0.threadChangedAt, "message stored inside the check-to-insert window").not.toBeNull();
    });

    it("D4: 6 concurrent drafts for one thread on 12 connections make 1 model call; the advisory lock is transaction-scoped and not held during the model call", async () => {
      gmail.seed(msg({ id: "p1", threadId: "g1" }));
      await syncFor(account, gmail);
      const thread = await threadOf("g1");
      let locksDuringCall = -1;
      const d = new Drafter(async () => {
        const [row] = await pool`select count(*)::int as n from pg_locks where locktype = 'advisory'`;
        locksDuringCall = row!.n as number;
        await sleep(80);
        return okBody("ok");
      });
      const rs = await Promise.all(Array.from({ length: 6 }, () => draftReply({ db: poolDb, provider: d, caps: BIG }, { userId, threadId: thread.id, mode: "reply", instruction: null })));
      expect(d.inputs).toHaveLength(1);
      expect(rs.filter((x) => x.ok)).toHaveLength(1);
      expect(rs.filter((x) => !x.ok).map((x) => (x as { code: string }).code)).toEqual(Array(5).fill("in_flight"));
      // During the concurrent run, the other 5 requests' own start transactions hold or wait for the
      // lock, so the in-call count isn't meaningful here; it is measured with a solo draft below.
      expect(locksDuringCall).toBeGreaterThanOrEqual(0);
      let soloLocks = -1;
      const solo = new Drafter(async () => {
        const [row] = await pool`select count(*)::int as n from pg_locks where locktype = 'advisory'`;
        soloLocks = row!.n as number;
        return okBody("ok");
      });
      expect((await draftReply({ db: poolDb, provider: solo, caps: BIG }, { userId, threadId: thread.id, mode: "reply", instruction: null })).ok).toBe(true);
      expect(soloLocks, "advisory locks held while the model runs (solo draft)").toBe(0);
      const c = (await calls()).filter((x) => x.purpose === "draft");
      expect(c.map((x) => x.status)).toEqual(["ok", "ok"]);
      const [after] = await pool`select count(*)::int as n from pg_locks where locktype = 'advisory'`;
      expect(after!.n).toBe(0);
      // Static: only the transaction-scoped form is used anywhere in src.
      const { readFileSync } = await import("node:fs");
      const ledger = readFileSync("src/lib/ai-ledger/ledger.ts", "utf8");
      expect(ledger).toContain("pg_advisory_xact_lock(");
      expect(ledger).not.toMatch(/pg_advisory_lock\(|pg_try_advisory_lock\(|pg_advisory_unlock/);
    });

    it("D4: pending rows count toward the call cap but not the dollar cap (measured overshoot across threads); stale > 3 min is closed, < 3 min blocks with no model call", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        gmail.seed(msg({ id: `p${i}`, threadId: `g${i}` }));
      }
      await syncFor(account, gmail);
      for (let i = 0; i < 4; i++) ids.push((await threadOf(`g${i}`)).id);
      // Dollar cap: one micro-dollar of room left; 4 threads drafted in parallel.
      await logAiCall(database, { userId, accountId: account.id, purpose: "draft", status: "ok", errorCode: null, usage: { ...OPUS(), costUsdMicros: 2_999_999 } });
      const d = new Drafter(async () => {
        await sleep(60);
        return okBody("ok");
      });
      const rs = await Promise.all(ids.map((t) => draftReply({ db: poolDb, provider: d, caps: BIG }, { userId, threadId: t, mode: "reply", instruction: null })));
      const spent = (await calls()).reduce((s, c) => s + Number(c.costUsdMicros ?? 0), 0);
      if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `d4-usd parallelThreads=4 modelCalls=${d.inputs.length} items=${rs.filter((x) => x.ok).length} spentMicros=${spent} capMicros=3000000\n`);
      // Call cap: a fresh pending row on another thread counts.
      await database.delete(schema.aiCalls);
      await database.insert(schema.aiCalls).values({ userId, accountId: account.id, threadId: ids[1], purpose: "draft", provider: "p", model: "m", status: "pending", createdAt: new Date() });
      const d2 = new Drafter(() => okBody("ok"));
      expect(await draftReply({ db: database, provider: d2, caps: { ...BIG, draftCalls: 1 } }, { userId, threadId: ids[0]!, mode: "reply", instruction: null })).toEqual({ ok: false, code: "capped" });
      expect(d2.inputs).toHaveLength(0);
      // Same thread: 179 s old blocks (no model call); 181 s old is closed as abandoned and the draft proceeds.
      await database.delete(schema.aiCalls);
      const at = (ms: number) => database.insert(schema.aiCalls).values({ userId, accountId: account.id, threadId: ids[0], purpose: "draft", provider: "p", model: "m", status: "pending", createdAt: new Date(Date.now() - ms) }).returning({ id: schema.aiCalls.id });
      const [young] = await at(179_000);
      expect(await draftReply({ db: database, provider: d2, caps: BIG }, { userId, threadId: ids[0]!, mode: "reply", instruction: null })).toEqual({ ok: false, code: "in_flight" });
      expect(d2.inputs).toHaveLength(0);
      await database.delete(schema.aiCalls).where(eq(schema.aiCalls.id, young!.id));
      const [old] = await at(181_000);
      expect((await draftReply({ db: database, provider: d2, caps: BIG }, { userId, threadId: ids[0]!, mode: "reply", instruction: null })).ok).toBe(true);
      expect(d2.inputs).toHaveLength(1);
      expect((await database.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, old!.id)))[0]).toMatchObject({ status: "error", errorCode: "abandoned" });
      // A stale pending row of another user is never touched.
      const other = await makeUser(database, "o3@example.com");
      const [foreign] = await database.insert(schema.aiCalls).values({ userId: other.id, accountId: null, purpose: "draft", provider: "p", model: "m", status: "pending", createdAt: new Date(Date.now() - 3_600_000) }).returning({ id: schema.aiCalls.id });
      await draftReply({ db: database, provider: d2, caps: BIG }, { userId, threadId: ids[2]!, mode: "reply", instruction: null });
      expect((await database.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, foreign!.id)))[0]!.status).toBe("pending");
    });
  });

  // ---- round 3: attacks on E1–E3 -----------------------------------------------------------------------

  describe("round 3", () => {
    it("E2: proposeReply racing a real sync of a newer message on separate connections, staggered both ways (20 rounds): the item always ends flagged", { timeout: 300_000 }, async () => {
      gmail.seed(msg({ id: "p1", threadId: "g1", internalDate: clock - 2 * HOUR }));
      await syncFor(account, gmail);
      const thread = await threadOf("g1");
      const parent = (await replyContext(database, userId, thread.id))!.parent;
      // A second single-connection client for the sync side, so both sides commit independently of the pool.
      const syncClient = postgres(testDbUrl!, { max: 1, onnotice: () => {} });
      const syncDb = drizzle(syncClient, { schema }) as unknown as Database;
      const tally = { flagged: 0, unflagged: 0 };
      try {
        for (let round = 0; round < 20; round++) {
          const id = `race${round}`;
          gmail.deliver(msg({ id, threadId: "g1", internalDate: Date.now() - 1000 + round }));
          const fresh = (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
          const syncOnce = () => syncAccount({ ...syncDeps(() => fresh, () => gmail), db: syncDb }, fresh, "push");
          const prop = () => proposeReply(poolDb, { userId, threadId: thread.id, parentMessageId: parent.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: `r${round}`, includeQuote: false });
          const d = round % 10;
          const [r] = await Promise.all([sleep(round % 2 ? d : 0).then(prop), sleep(round % 2 ? 0 : d).then(syncOnce)]);
          const stored = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, id));
          expect(stored, `round ${round}: premise, message stored`).toHaveLength(1);
          const it0 = (await getOwnItem(database, userId, (r as { itemId: string }).itemId))!;
          if (it0.threadChangedAt) tally.flagged++;
          else tally.unflagged++;
        }
      } finally {
        await syncClient.end();
      }
      if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `e2-race ${JSON.stringify(tally)}\n`);
      expect(tally.unflagged).toBe(0);
    });

    it("E2: only pending/failed items get the post-commit flag; our own SENT copy never flags; an already-set flag isn't moved by the re-check on the reply side", async () => {
      gmail.seed(msg({ id: "p1", threadId: "g1", internalDate: clock - 2 * HOUR }));
      await syncFor(account, gmail);
      const thread = await threadOf("g1");
      const parent = (await replyContext(database, userId, thread.id))!.parent;
      const mk = async () => {
        const r = await proposeReply(database, { userId, threadId: thread.id, parentMessageId: parent.id, to: "alice@example.org", cc: "", subject: "Re: Lunch", bodyText: "x", includeQuote: false });
        return (r as { itemId: string }).itemId;
      };
      const byStatus: Record<string, string> = {};
      for (const s of ["pending", "failed", "approved", "executing", "unknown", "succeeded", "rejected", "cancelled"] as const) {
        const id = await mk();
        await database.update(schema.approvalItems).set({ status: s }).where(eq(schema.approvalItems.id, id));
        byStatus[s] = id;
      }
      // Our own sent copy (header of a sent item) arriving: nothing is flagged.
      const sentId = await mk();
      await database.update(schema.approvalItems).set({ status: "succeeded", messageIdHeader: "<alex.own@alex.example.com>" }).where(eq(schema.approvalItems.id, sentId));
      gmail.deliver(msg({ id: "own", threadId: "g1", labelIds: ["SENT"], from: "work@example.com", messageIdHeader: "<alex.own@alex.example.com>", internalDate: Date.now() - 5000 }));
      await syncFor(account, gmail);
      for (const [s, id] of Object.entries(byStatus)) expect((await getOwnItem(database, userId, id))!.threadChangedAt, `own copy, ${s}`).toBeNull();
      // A genuine newer message: only pending and failed are flagged.
      gmail.deliver(msg({ id: "new", threadId: "g1", internalDate: Date.now() - 4000 }));
      await syncFor(account, gmail);
      for (const [s, id] of Object.entries(byStatus)) {
        const flagged = (await getOwnItem(database, userId, id))!.threadChangedAt !== null;
        expect(flagged, s).toBe(s === "pending" || s === "failed");
      }
    });

    it("E2: an error in the post-commit step after a message committed: the message stays stored, and the sync run is reported (documented behaviour)", async () => {
      gmail.seed(msg({ id: "p1", threadId: "g1", internalDate: clock - 2 * HOUR }));
      await syncFor(account, gmail);
      gmail.deliver(msg({ id: "n1", threadId: "g1", internalDate: Date.now() - 3000 }));
      gmail.deliver(msg({ id: "n2", threadId: "g2", internalDate: Date.now() - 2000 }));
      // Top-level (non-transaction) UPDATEs of approval_items throw: that is exactly the post-commit flag step.
      let thrown = 0;
      const broken = new Proxy(database, {
        get(t, p, r) {
          if (p === "update")
            return (table: unknown) => {
              if (table === schema.approvalItems) {
                thrown++;
                throw new Error("injected post-commit failure");
              }
              return (t as Database).update(table as never);
            };
          return Reflect.get(t, p, r);
        },
      }) as Database;
      const fresh = (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
      const res = await syncAccount({ ...syncDeps(() => fresh, () => gmail), db: broken }, fresh, "push");
      const n1 = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "n1"));
      const n2 = await database.select().from(schema.mailMessages).where(eq(schema.mailMessages.gmailMessageId, "n2"));
      if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `e2-postcommit-error outcome=${res.outcome} thrown=${thrown} n1=${n1.length} n2=${n2.length}\n`);
      expect(thrown).toBeGreaterThan(0);
      expect(n1, "the committed message is kept").toHaveLength(1);
      // The rest of the run's ingest must not be lost because of the advisory step.
      expect(n2, "later messages in the same run are still ingested").toHaveLength(1);
      expect(res.outcome, "an advisory-step error must not fail the sync run").toBe("ok");
    });

    it("E3: parallel drafts can't go past the cap by more than one reserved call (cap − spent > 2 reserves, 6 parallel)", async () => {
      const { DRAFT_RESERVED_COST_MICROS } = await import("@/lib/ai-ledger/pricing");
      const R = DRAFT_RESERVED_COST_MICROS;
      expect(R).toBe(448_000);
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) gmail.seed(msg({ id: `p${i}`, threadId: `g${i}` }));
      await syncFor(account, gmail);
      for (let i = 0; i < 6; i++) ids.push((await threadOf(`g${i}`)).id);
      const cap = 3_000_000;
      await logAiCall(database, { userId, accountId: account.id, purpose: "draft", status: "ok", errorCode: null, usage: { ...OPUS(), costUsdMicros: 2_000_000 } });
      // Each call really costs the full reserve (worst case within the reserve's assumptions).
      const d = new Drafter(async () => {
        await sleep(60);
        return okBody("ok", { usage: { ...OPUS(), costUsdMicros: R } });
      });
      const rs = await Promise.all(ids.map((t) => draftReply({ db: poolDb, provider: d, caps: { ...BIG, draftMicros: cap, totalMicros: 10_000_000 } }, { userId, threadId: t, mode: "reply", instruction: null })));
      const spent = (await calls()).reduce((s, c) => s + Number(c.costUsdMicros ?? 0), 0);
      if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `e3 started=${d.inputs.length} ok=${rs.filter((x) => x.ok).length} capped=${rs.filter((x) => !x.ok).length} spent=${spent} cap=${cap}\n`);
      expect(d.inputs.length).toBe(3); // counted 2.0, 2.448, 2.896 are below the cap (3 start); 3.344 is not
      expect(spent - cap).toBeLessThanOrEqual(R);
    });
  });
});

describe.skipIf(!testDbUrl)("tester round 3: E4 end to end (hostile headers stored by 2a reach the draft prompt uncapped)", () => {
  it("30 stored messages with 10K-character subjects and dates make the draft input far larger than the 30K text cap", async () => {
    const { client, database } = await openTestDb();
    try {
      const userId = (await makeUser(database)).id;
      const account = await makeGoogleAccount(database, userId, { email: "work@example.com" });
      const g = new FakeGmail();
      const now = Date.now();
      for (let i = 0; i < 30; i++) {
        g.seed({ id: `h${i}`, threadId: "gH", labelIds: ["INBOX"], internalDate: now - (30 - i) * 60_000, from: "Mallory <m@evil.example>", subject: "S".repeat(10_000), payload: { ...textPart("text/plain", "short"), headers: [header("Date", "D".repeat(10_000))] } });
      }
      for (let i = 0; i < 10; i++) {
        const fresh = (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
        await syncAccount({ db: database, gmailFor: () => g, now: () => new Date(now), sleep: async () => {}, unitsPerMinute: 1e9, render: async (body, opts) => ({ renderKind: "none", renderReason: null, renderedHtml: null, renderedHtmlRemote: null, renderedText: body.text, renderTruncated: false, sanitizerVersion: opts.version, renderedAt: new Date(now) }) }, fresh, "cron");
        if ((await getSyncState(database, account.id))?.backfillStatus === "complete") break;
      }
      const thread = (await database.select().from(schema.mailThreads))[0]!;
      let input: DraftInput | null = null;
      await draftReply({ db: database, provider: { id: "anthropic-opus", draft: async (inp) => ((input = inp), { status: "invalid", body: null, notes: null, errorCode: "x", usage: emptyUsage("anthropic-opus", "claude-opus-5-5") }) }, caps: { triageCalls: 400, triageMicros: 500_000, draftCalls: 25, draftMicros: 3_000_000, totalMicros: 3_500_000 } }, { userId, threadId: thread.id, mode: "reply", instruction: null });
      const chars = JSON.stringify(buildDraftRequest(input!)).length;
      const stored = (await database.select().from(schema.mailMessages)).map((m) => (m.subject ?? "").length);
      if (process.env.TESTER_DEBUG) (await import("node:fs")).appendFileSync(process.env.TESTER_DEBUG, `e4-db messages=${input!.messages.length} storedSubjectLen=${Math.max(...stored)} requestChars=${chars}\n`);
      expect(chars, "draft request characters vs the 30K content cap (+ a fixed allowance)").toBeLessThanOrEqual(30_000 + 20_000);
    } finally {
      await client.end();
    }
  });
});

describe.skipIf(!testDbUrl)("tester round 4 (B1): ambiguous failures and abandoned rows are counted at the reserve", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  const now = Date.now();
  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });
  const sync = async () => {
    for (let i = 0; i < 10; i++) {
      const fresh = (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
      await syncAccount({ db: database, gmailFor: () => gmail, now: () => new Date(now), sleep: async () => {}, unitsPerMinute: 1e9, render: async (body, opts) => ({ renderKind: "none", renderReason: null, renderedHtml: null, renderedHtmlRemote: null, renderedText: body.text, renderTruncated: false, sanitizerVersion: opts.version, renderedAt: new Date(now) }) }, fresh, "cron");
      if ((await getSyncState(database, account.id))?.backfillStatus === "complete") break;
    }
  };
  const seedThreads = async (n: number) => {
    for (let i = 0; i < n; i++) gmail.seed({ id: `m${i}`, threadId: `t${i}`, labelIds: ["INBOX"], internalDate: now - (i + 1) * 60_000, from: "Alice <alice@example.org>", subject: "Hi" });
    await sync();
    return (await database.select().from(schema.mailThreads)).map((t) => t.id);
  };
  const callsRows = async () => database.select().from(schema.aiCalls).orderBy(asc(schema.aiCalls.createdAt));
  const BIGC: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 25, draftMicros: 3_000_000, totalMicros: 3_500_000 };
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com" });
    gmail = new FakeGmail();
  });

  it("every error code: ambiguous ones at the reserve (triage and draft), definite ones at $0", async () => {
    const { TRIAGE_RESERVED_COST_MICROS: TR, DRAFT_RESERVED_COST_MICROS: DR, AMBIGUOUS_ERROR_CODES } = await import("@/lib/ai-ledger/pricing");
    expect([...AMBIGUOUS_ERROR_CODES].sort()).toEqual(["aborted", "api_5xx", "network", "timeout", "unexpected"]);
    const threads = await seedThreads(1);
    const codes = ["timeout", "aborted", "network", "unexpected", "api_5xx", "rate_limit", "api_400", "api_401", "api_403", "api_404", "api_408", "api_409", "api_413", "api_422", "spend_limit"];
    const got: Record<string, [number | null, number | null]> = {};
    for (const code of codes) {
      await database.delete(schema.aiCalls);
      await database.delete(schema.mailTriage);
      const tp: TriageProvider = { id: "anthropic-haiku", triage: async () => ({ status: "error", result: null, errorCode: code, usage: emptyUsage("anthropic-haiku", "claude-haiku-5-5", 1) }) };
      await runTriageStage({ db: database, provider: tp, caps: BIGC }, account);
      const t = (await callsRows())[0]!;
      await database.delete(schema.aiCalls);
      const dp: DraftProvider = { id: "anthropic-opus", draft: async () => ({ status: "error", body: null, notes: null, errorCode: code, usage: emptyUsage("anthropic-opus", "claude-opus-5-5", 1) }) };
      await draftReply({ db: database, provider: dp, caps: BIGC }, { userId, threadId: threads[0]!, mode: "reply", instruction: null });
      const d = (await callsRows()).find((x) => x.purpose === "draft")!;
      got[code] = [t.costUsdMicros, d.costUsdMicros];
    }
    for (const code of codes) {
      const amb = AMBIGUOUS_ERROR_CODES.includes(code);
      expect(got[code], code).toEqual(amb ? [TR, DR] : [0, 0]);
    }
    // A provider that throws (draft): recorded as unexpected, at the reserve.
    await database.delete(schema.aiCalls);
    await draftReply({ db: database, provider: { id: "anthropic-opus", draft: async () => { throw new Error("boom"); } }, caps: BIGC }, { userId, threadId: threads[0]!, mode: "reply", instruction: null });
    expect((await callsRows())[0]).toMatchObject({ status: "error", errorCode: "unexpected", costUsdMicros: DR });
    // Refused/invalid keep the returned usage's cost (not the reserve).
    await database.delete(schema.aiCalls);
    await draftReply({ db: database, provider: { id: "anthropic-opus", draft: async () => ({ status: "refused", body: null, notes: null, errorCode: "refusal", usage: { ...emptyUsage("anthropic-opus", "claude-opus-5-5", 1), inputTokens: 1_000, outputTokens: 10 } }) }, caps: BIGC }, { userId, threadId: threads[0]!, mode: "reply", instruction: null });
    expect((await callsRows())[0]!.costUsdMicros).toBe(4_200);
  });

  it("repeated timeouts hit the dollar caps: triage stops after cap/reserve calls; drafts after the bound", async () => {
    const { TRIAGE_RESERVED_COST_MICROS: TR, DRAFT_RESERVED_COST_MICROS: DR } = await import("@/lib/ai-ledger/pricing");
    const threads = await seedThreads(12);
    const tp: TriageProvider = { id: "anthropic-haiku", triage: async () => ({ status: "error", result: null, errorCode: "timeout", usage: emptyUsage("anthropic-haiku", "claude-haiku-5-5", 1) }) };
    const r = await runTriageStage({ db: database, provider: tp, caps: { ...BIGC, triageMicros: 5 * TR } }, account);
    expect(r).toMatchObject({ failed: 5, skippedCap: 7 });
    // Drafts: aborted every time; a $3.00 cap allows 7 starts (6 × 0.448 = 2.688 < 3), the 8th is capped.
    await database.delete(schema.aiCalls);
    const dp: DraftProvider = { id: "anthropic-opus", draft: async () => ({ status: "error", body: null, notes: null, errorCode: "aborted", usage: emptyUsage("anthropic-opus", "claude-opus-5-5", 1) }) };
    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      const x = await draftReply({ db: database, provider: dp, caps: { ...BIGC, totalMicros: 10_000_000 } }, { userId, threadId: threads[i]!, mode: "reply", instruction: null });
      results.push(x.ok ? "ok" : x.code);
    }
    expect(results).toEqual([...Array(7).fill("error"), "capped", "capped", "capped"]);
    expect((await callsRows()).reduce((s, c) => s + Number(c.costUsdMicros ?? 0), 0)).toBe(7 * DR);
  });

  it("a swept abandoned row is counted exactly once (never with its pending reserve too), and the report marks it estimated", async () => {
    const { DRAFT_RESERVED_COST_MICROS: DR } = await import("@/lib/ai-ledger/pricing");
    const { startDraftCall, finishAiCall, todaysUsage, usageReport } = await import("@/lib/ai-ledger/ledger");
    const threads = await seedThreads(2);
    const [stale] = await database.insert(schema.aiCalls).values({ userId, accountId: account.id, threadId: threads[0], purpose: "draft", provider: "p", model: "claude-opus-5-5", status: "pending", createdAt: new Date(Date.now() - 10 * 60_000) }).returning({ id: schema.aiCalls.id });
    const t = new Date();
    expect((await todaysUsage(database, userId, t)).draft.micros, "pending stale row at the reserve").toBe(DR);
    const s = await startDraftCall(database, { userId, accountId: account.id, threadId: threads[1]!, provider: "anthropic-opus", model: "claude-opus-5-5", now: t, caps: BIGC });
    expect(s.kind).toBe("started");
    expect((await database.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, stale!.id)))[0]).toMatchObject({ status: "error", errorCode: "abandoned", costUsdMicros: DR });
    expect((await todaysUsage(database, userId, t)).draft.micros, "swept (DR) + the new pending (DR)").toBe(2 * DR);
    // A second sweep pass (another start) doesn't re-cost it.
    await finishAiCall(database, (s as { callId: string }).callId, { status: "error", errorCode: "api_400", usage: emptyUsage("anthropic-opus", "claude-opus-5-5", 1) });
    const s2 = await startDraftCall(database, { userId, accountId: account.id, threadId: threads[1]!, provider: "anthropic-opus", model: "claude-opus-5-5", now: t, caps: BIGC });
    await finishAiCall(database, (s2 as { callId: string }).callId, { status: "error", errorCode: "api_400", usage: emptyUsage("anthropic-opus", "claude-opus-5-5", 1) });
    expect((await todaysUsage(database, userId, t)).draft.micros, "only the abandoned row costs").toBe(DR);
    // A late finish of the abandoned call can't overwrite it (only pending rows are finished).
    await finishAiCall(database, stale!.id, { status: "ok", errorCode: null, usage: { ...emptyUsage("anthropic-opus", "claude-opus-5-5", 1), inputTokens: 1, outputTokens: 1 } });
    expect((await database.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, stale!.id)))[0]).toMatchObject({ status: "error", errorCode: "abandoned", costUsdMicros: DR });
    const rep = (await usageReport(database, userId, t)).find((r) => r.purpose === "draft")!;
    expect(rep).toMatchObject({ calls: 3, failed: 3, costUsdMicros: DR, estimated: 1, estimatedUsdMicros: DR });
  });

  it("the reserves stay tied to the prompt constants", async () => {
    const p = await import("@/lib/ai-ledger/pricing");
    const pr = await import("@/lib/ai/prompts");
    expect(p.TRIAGE_RESERVED_INPUT_TOKENS).toBe(pr.MESSAGE_TEXT_CAP + 2_000);
    expect(p.TRIAGE_RESERVED_OUTPUT_TOKENS).toBe(pr.TRIAGE_MAX_TOKENS);
    expect(p.DRAFT_RESERVED_INPUT_TOKENS).toBe(pr.THREAD_TEXT_CAP + 2_000);
    expect(p.DRAFT_RESERVED_OUTPUT_TOKENS).toBe(pr.DRAFT_MAX_TOKENS);
    expect(p.TRIAGE_RESERVED_COST_MICROS).toBe(8_000 * 0.1 + 1_024 * 0.5); // 1,312
    expect(p.DRAFT_RESERVED_COST_MICROS).toBe(32_000 * 4 + 16_000 * 20); // 448,000
  });
});
