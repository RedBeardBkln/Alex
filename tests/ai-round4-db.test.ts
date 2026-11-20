import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { asc, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import type { Caps } from "@/lib/ai-ledger/config";
import { capState, emptyUsage, startDraftCall, todaysUsage, usageReport, DRAFT_IN_FLIGHT_STALE_MS } from "@/lib/ai-ledger/ledger";
import {
  ambiguousFailureCost,
  costUsdMicros,
  DRAFT_RESERVED_COST_MICROS,
  TRIAGE_RESERVED_COST_MICROS,
} from "@/lib/ai-ledger/pricing";
import { draftReply } from "@/lib/ai/draft";
import { MESSAGE_TEXT_CAP, TRIAGE_MAX_TOKENS } from "@/lib/ai/prompts";
import { runTriageStage } from "@/lib/ai/triage";
import type { DraftOutcome, DraftProvider, TriageOutcome, TriageProvider } from "@/lib/ai/types";
import { getSyncState } from "@/lib/gmail/store";
import { syncAccount, type SyncDeps } from "@/lib/gmail/sync";
import { FakeGmail, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Phase 2c round 4, B1: failures that may have been billed but returned no usage are recorded at the
// purpose's reserved worst case, so the dollar caps count them. Fake Gmail and fake providers only.

const HOUR = 3_600_000;

describe("B1 reserve rules (unit)", () => {
  it("only ambiguous errors get the reserve; definite refusals and non-error outcomes don't", () => {
    for (const code of ["timeout", "aborted", "network", "unexpected", "api_5xx"]) {
      expect(ambiguousFailureCost("draft", "error", code)).toBe(DRAFT_RESERVED_COST_MICROS);
      expect(ambiguousFailureCost("triage", "error", code)).toBe(TRIAGE_RESERVED_COST_MICROS);
    }
    for (const code of ["spend_limit", "rate_limit", "api_400", "api_401", "api_404", "api_413", null]) {
      expect(ambiguousFailureCost("draft", "error", code)).toBeNull();
      expect(ambiguousFailureCost("triage", "error", code)).toBeNull();
    }
    expect(ambiguousFailureCost("draft", "invalid", "timeout")).toBeNull();
    expect(ambiguousFailureCost("draft", "refused", "refusal")).toBeNull();
  });

  it("the triage reserve is Haiku at TRIAGE_MAX_TOKENS output plus the message cap as input (one token per character + 2,000)", () => {
    expect(TRIAGE_MAX_TOKENS).toBe(1_024);
    expect(MESSAGE_TEXT_CAP).toBe(6_000);
    expect(TRIAGE_RESERVED_COST_MICROS).toBe(costUsdMicros("claude-haiku-5-5", { inputTokens: MESSAGE_TEXT_CAP + 2_000, outputTokens: TRIAGE_MAX_TOKENS, cacheWriteTokens: 0, cacheReadTokens: 0 }));
    expect(TRIAGE_RESERVED_COST_MICROS).toBe(1_312);
  });
});

describe.skipIf(!testDbUrl)("round 4, B1 (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
  });
  afterAll(async () => {
    await client.end();
  });

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
  const reload = async () => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, account.id)))[0]!;
  async function runUntilEmpty() {
    for (let i = 0; i < 20; i++) {
      await syncAccount(syncDeps(), await reload(), "cron");
      const q = await database.select().from(schema.mailFetchQueue).where(eq(schema.mailFetchQueue.accountId, account.id));
      if ((await getSyncState(database, account.id))?.backfillStatus === "complete" && q.length === 0) return;
      clock += 5 * 60_000;
    }
  }
  const msg = (over: Partial<FakeMessage> & { id: string }): FakeMessage => ({ threadId: "gt1", labelIds: ["INBOX"], internalDate: clock - HOUR, from: "Alice <alice@example.org>", ...over });
  const threads = async () => database.select().from(schema.mailThreads).orderBy(asc(schema.mailThreads.gmailThreadId));
  const draftCalls = async () => (await database.select().from(schema.aiCalls)).filter((c) => c.purpose === "draft");
  const failing = (errorCode: string): DraftProvider => ({
    id: "anthropic-opus",
    draft: async (): Promise<DraftOutcome> => ({ status: "error", body: null, notes: null, errorCode, usage: emptyUsage("anthropic-opus", "claude-opus-5-5", 90_000) }),
  });

  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com" });
    gmail = new FakeGmail();
    clock = Date.now();
  });

  it("repeated timed-out drafts are recorded at the reserve and hit the dollar cap; the usage report marks them estimated", async () => {
    gmail.seed(msg({ id: "p1" }));
    await runUntilEmpty();
    const [thread] = await threads();
    // Room for two worst cases and a bit: the third attempt still starts, the fourth is capped.
    const caps: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 25, draftMicros: 2 * DRAFT_RESERVED_COST_MICROS + 1, totalMicros: 10_000_000 };
    const deps = { db: database, provider: failing("timeout"), now: () => new Date(clock), caps };
    const input = { userId, threadId: thread!.id, mode: "reply" as const, instruction: null };
    expect(await draftReply(deps, input)).toEqual({ ok: false, code: "error" });
    expect((await todaysUsage(database, userId, new Date(clock))).draft.micros).toBe(DRAFT_RESERVED_COST_MICROS);
    expect(await draftReply(deps, input)).toEqual({ ok: false, code: "error" });
    expect(await draftReply(deps, input)).toEqual({ ok: false, code: "error" });
    expect(await draftReply(deps, input)).toEqual({ ok: false, code: "capped" });
    const rows = await draftCalls();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({ status: "error", errorCode: "timeout", costUsdMicros: DRAFT_RESERVED_COST_MICROS, inputTokens: 0, outputTokens: 0 });
    }
    const [day] = await usageReport(database, userId, new Date(clock));
    expect(day).toMatchObject({ purpose: "draft", calls: 3, failed: 3, costUsdMicros: 3 * DRAFT_RESERVED_COST_MICROS, estimated: 3, estimatedUsdMicros: 3 * DRAFT_RESERVED_COST_MICROS });
  });

  it("each ambiguous code is recorded at the reserve; spend-limit, 429 and other 4xx stay at $0 and aren't marked estimated", async () => {
    gmail.seed(msg({ id: "p1" }));
    await runUntilEmpty();
    const [thread] = await threads();
    const input = { userId, threadId: thread!.id, mode: "reply" as const, instruction: null };
    const codes = ["timeout", "aborted", "network", "unexpected", "api_5xx", "spend_limit", "rate_limit", "api_400", "api_413"];
    const big: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 100, draftMicros: 100_000_000, totalMicros: 100_000_000 };
    for (const code of codes) {
      // A spend-limit row caps the day, so clear it before the next code.
      await draftReply({ db: database, provider: failing(code), now: () => new Date(clock), caps: big }, input);
      if (code === "spend_limit") {
        const row = (await draftCalls()).find((c) => c.errorCode === "spend_limit")!;
        expect(row.costUsdMicros).toBe(0);
        await database.update(schema.aiCalls).set({ errorCode: "spend_limit_seen" }).where(eq(schema.aiCalls.id, row.id));
      }
    }
    const byCode = new Map((await draftCalls()).map((c) => [c.errorCode, c.costUsdMicros]));
    for (const code of ["timeout", "aborted", "network", "unexpected", "api_5xx"]) expect(byCode.get(code), code).toBe(DRAFT_RESERVED_COST_MICROS);
    for (const code of ["spend_limit_seen", "rate_limit", "api_400", "api_413"]) expect(byCode.get(code), code).toBe(0);
    const [day] = await usageReport(database, userId, new Date(clock));
    expect(day!.estimated).toBe(5);
    expect(day!.estimatedUsdMicros).toBe(5 * DRAFT_RESERVED_COST_MICROS);
  });

  it("a provider that throws (unexpected) is recorded at the reserve", async () => {
    gmail.seed(msg({ id: "p1" }));
    await runUntilEmpty();
    const [thread] = await threads();
    const provider: DraftProvider = {
      id: "anthropic-opus",
      draft: async () => {
        throw new Error("boom");
      },
    };
    expect(await draftReply({ db: database, provider, now: () => new Date(clock) }, { userId, threadId: thread!.id, mode: "reply", instruction: null })).toEqual({ ok: false, code: "error" });
    expect(await draftCalls()).toMatchObject([{ status: "error", errorCode: "unexpected", costUsdMicros: DRAFT_RESERVED_COST_MICROS }]);
  });

  it("a pending draft swept as abandoned keeps counting at the reserve", async () => {
    gmail.seed(msg({ id: "p1" }));
    await runUntilEmpty();
    const [thread] = await threads();
    const caps: Caps = { triageCalls: 400, triageMicros: 500_000, draftCalls: 25, draftMicros: 100_000_000, totalMicros: 100_000_000 };
    const s = await startDraftCall(database, { userId, accountId: account.id, threadId: thread!.id, provider: "anthropic-opus", model: "claude-opus-5-5", now: new Date(clock), caps });
    expect(s.kind).toBe("started");
    // The function died: no finishAiCall. Later, a new start sweeps it.
    clock += DRAFT_IN_FLIGHT_STALE_MS + 1_000;
    const s2 = await startDraftCall(database, { userId, accountId: account.id, threadId: thread!.id, provider: "anthropic-opus", model: "claude-opus-5-5", now: new Date(clock), caps });
    expect(s2.kind).toBe("started");
    const swept = (await draftCalls()).find((c) => c.id === (s as { callId: string }).callId)!;
    expect(swept).toMatchObject({ status: "error", errorCode: "abandoned", costUsdMicros: DRAFT_RESERVED_COST_MICROS });
    // Swept row (reserve) + the new pending row (reserve).
    expect((await todaysUsage(database, userId, new Date(clock))).draft.micros).toBe(2 * DRAFT_RESERVED_COST_MICROS);
    const [day] = await usageReport(database, userId, new Date(clock));
    expect(day).toMatchObject({ estimated: 1, estimatedUsdMicros: DRAFT_RESERVED_COST_MICROS });
  });

  it("triage: ambiguous failures are recorded at the Haiku reserve and count toward the triage dollar cap; a 4xx stays at $0", async () => {
    for (let i = 0; i < 4; i++) gmail.seed(msg({ id: `m${i}`, threadId: `gt${i}` }));
    await runUntilEmpty();
    const codes = ["timeout", "api_5xx", "api_400", "network"];
    let n = 0;
    const provider: TriageProvider = {
      id: "anthropic-haiku",
      triage: async (): Promise<TriageOutcome> => ({ status: "error", result: null, errorCode: codes[n++]!, usage: emptyUsage("anthropic-haiku", "claude-haiku-5-5", 30_000) }),
    };
    const caps: Caps = { triageCalls: 400, triageMicros: 3 * TRIAGE_RESERVED_COST_MICROS, draftCalls: 25, draftMicros: 3_000_000, totalMicros: 10_000_000 };
    const r = await runTriageStage({ db: database, provider, now: () => new Date(clock), caps }, account);
    expect(r.failed).toBe(4);
    const rows = (await database.select().from(schema.aiCalls)).filter((c) => c.purpose === "triage");
    const byCode = new Map(rows.map((c) => [c.errorCode, c.costUsdMicros]));
    expect(byCode.get("timeout")).toBe(TRIAGE_RESERVED_COST_MICROS);
    expect(byCode.get("api_5xx")).toBe(TRIAGE_RESERVED_COST_MICROS);
    expect(byCode.get("network")).toBe(TRIAGE_RESERVED_COST_MICROS);
    expect(byCode.get("api_400")).toBe(0);
    expect(r.costUsdMicros).toBe(3 * TRIAGE_RESERVED_COST_MICROS);
    // Three reserves reach the triage dollar cap exactly: the next call is refused.
    expect(await capState(database, userId, "triage", new Date(clock), caps)).toEqual({ capped: true, cap: "usd" });
  });
});
