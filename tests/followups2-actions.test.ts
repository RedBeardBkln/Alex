import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";

// phase-2-followups-2 at the Server Action level (no database, no Google, no SDK; all mocked):
// - O2 (owner Q7): a draft or triage whose account was disconnected lands on the Inbox notice.
// - SF2 (owner Q1 option c): the approve action parses shownNewer strictly and always passes it.
// - Security N3: a Disconnect whose DELETE still fails is audited with a code only, then rethrown.

const ACCOUNT = "44444444-4444-4444-8444-444444444444";
const state = vi.hoisted(() => ({
  origin: "https://alex.example.com" as string | null,
  user: { id: "33333333-3333-4333-8333-333333333333", email: "owner@example.test" } as { id: string; email: string } | null,
  draftResult: { ok: true, itemId: "11111111-1111-4111-8111-111111111111" } as { ok: true; itemId: string } | { ok: false; code: string },
  triageResult: "triaged" as string,
  approveInputs: [] as unknown[],
  audits: [] as unknown[],
  auditFails: false,
  deleteError: null as unknown,
  deletes: 0,
}));

class Redirect extends Error {
  constructor(public readonly url: string) {
    super(`redirect ${url}`);
  }
}

vi.mock("next/headers", () => ({ headers: async () => new Headers(state.origin === null ? {} : { origin: state.origin }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({
  requireUser: async () => {
    if (!state.user) throw new Redirect("/login");
    return state.user;
  },
  destroySession: async () => undefined,
}));
vi.mock("@/lib/ai/runtime", () => ({
  draftReplyNow: async () => state.draftResult,
  triageThreadOnDemand: async () => state.triageResult,
}));
vi.mock("@/lib/approvals/execute", () => ({
  approveAndSend: async (_deps: unknown, input: unknown) => {
    state.approveInputs.push(input);
    return { kind: "not_approved", result: { kind: "blocked", reason: "ack_required" } };
  },
}));
vi.mock("@/lib/approvals/runtime", () => ({
  approvalExecutorDeps: () => ({}),
  approvalReconcileDeps: () => ({}),
  messageIdHost: () => "alex.example.com",
}));
vi.mock("@/lib/accounts", async (orig) => ({
  ...(await orig<object>()),
  getAccount: async () => ({ id: ACCOUNT, userId: "33333333-3333-4333-8333-333333333333", email: "work@example.test", provider: "google", label: "personal", refreshTokenEnc: null, accessTokenEnc: null }),
  deleteAccount: async () => {
    state.deletes++;
    if (state.deleteError) throw state.deleteError;
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: async (entry: unknown) => {
    if (state.auditFails) throw Object.assign(new Error("Failed query: insert <owner@example.test>"), { cause: { code: "08006" } });
    state.audits.push(entry);
  },
}));
vi.mock("@/lib/gmail/watch-stop", () => ({ stopWatchBeforeDisconnect: async () => undefined }));
vi.mock("@/lib/gmail/runtime", () => ({ gmailClientFor: () => ({}) }));

const aiActions = await import("@/app/(app)/inbox/[threadId]/ai-actions");
const queueActions = await import("@/app/(app)/queue/actions");
const appActions = await import("@/app/(app)/actions");

const THREAD = "22222222-2222-4222-8222-222222222222";
const ITEM = "55555555-5555-4555-8555-555555555555";
const HASH = "a".repeat(64);
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  state.origin = "https://alex.example.com";
  state.user = { id: "33333333-3333-4333-8333-333333333333", email: "owner@example.test" };
  state.approveInputs = [];
  state.audits = [];
  state.auditFails = false;
  state.deleteError = null;
  state.deletes = 0;
});

describe("O2: the owner lands on the Inbox notice (AC-O2-6)", () => {
  it("draft: account_disconnected and not_found go to /inbox?notice=account_disconnected; other failures stay on the thread", async () => {
    for (const code of ["account_disconnected", "not_found"]) {
      state.draftResult = { ok: false, code };
      await expect(aiActions.draftReplyAction(form({ threadId: THREAD }))).rejects.toMatchObject({ url: "/inbox?notice=account_disconnected" });
    }
    state.draftResult = { ok: false, code: "proposal" };
    await expect(aiActions.draftReplyAction(form({ threadId: THREAD }))).rejects.toMatchObject({ url: `/inbox/${THREAD}?ai_error=proposal#ai` });
  });

  it("triage: account_disconnected goes to the Inbox notice; other outcomes stay on the thread", async () => {
    state.triageResult = "account_disconnected";
    await expect(aiActions.triageThreadAction(form({ threadId: THREAD }))).rejects.toMatchObject({ url: "/inbox?notice=account_disconnected" });
    state.triageResult = "not_found";
    await expect(aiActions.triageThreadAction(form({ threadId: THREAD }))).rejects.toMatchObject({ url: `/inbox/${THREAD}?ai_triage=not_found#ai` });
  });
});

describe("SF2: the approve action's shownNewer (AC-SF2-4)", () => {
  const base = { itemId: ITEM, revision: "1", contentHash: HASH };
  it("a missing field counts as empty and is still passed; a valid digest is passed as is", async () => {
    await expect(queueActions.approveItemAction(form(base))).rejects.toMatchObject({ url: `/queue/${ITEM}?notice=ack_required` });
    await expect(queueActions.approveItemAction(form({ ...base, shownNewer: "b".repeat(64), ackThreadChange: "on" }))).rejects.toBeInstanceOf(Redirect);
    expect(state.approveInputs).toMatchObject([{ shownNewer: "" }, { shownNewer: "b".repeat(64), ackThreadChange: true }]);
  });

  it("a malformed value is refused by zod before any approve call", async () => {
    for (const bad of ["B".repeat(64), "b".repeat(63), "b".repeat(65), " ", "x"]) {
      await expect(queueActions.approveItemAction(form({ ...base, shownNewer: bad }))).rejects.toThrow();
      await expect(queueActions.approveItemAction(form({ ...base, shownNewer: bad }))).rejects.not.toBeInstanceOf(Redirect);
    }
    expect(state.approveInputs).toEqual([]);
  });
});

describe("Security N3: a failed Disconnect is audited and still fails", () => {
  it("audits account.disconnect_failed {code} (no address) and rethrows the original error", async () => {
    const err = Object.assign(new Error("Failed query: delete <work@example.test>"), { cause: { code: "40P01" } });
    state.deleteError = err;
    await expect(appActions.disconnect(form({ accountId: ACCOUNT }))).rejects.toBe(err);
    expect(state.audits).toEqual([{ userId: state.user!.id, accountId: ACCOUNT, action: "account.disconnect_failed", detail: { code: "40P01" } }]);
    expect(JSON.stringify(state.audits)).not.toMatch(/example\.test/);
  });

  it("an error without a SQLSTATE is audited by class name", async () => {
    state.deleteError = new TypeError("boom <work@example.test>");
    await expect(appActions.disconnect(form({ accountId: ACCOUNT }))).rejects.toBeInstanceOf(TypeError);
    expect(state.audits).toEqual([{ userId: state.user!.id, accountId: ACCOUNT, action: "account.disconnect_failed", detail: { code: "TypeError" } }]);
  });

  it("if that audit fails too, it is only logged (ids and codes), and the original error is still thrown", async () => {
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a));
    try {
      const err = Object.assign(new Error("x"), { cause: { code: "40P01" } });
      state.deleteError = err;
      state.auditFails = true;
      await expect(appActions.disconnect(form({ accountId: ACCOUNT }))).rejects.toBe(err);
      expect(logs).toEqual([["disconnect failure audit failed", { accountId: ACCOUNT, error: "Error", code: "08006" }]]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a successful Disconnect writes only account.disconnected", async () => {
    await appActions.disconnect(form({ accountId: ACCOUNT }));
    expect(state.deletes).toBe(1);
    expect(state.audits).toMatchObject([{ action: "account.disconnected" }]);
  });
});
