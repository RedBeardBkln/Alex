import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";

// Phase 2c AC9 at the Server Action level: the AI actions require sign-in and the app's Origin,
// validate input, and call the AI runtime only after both checks. The runtime is mocked: no
// database, no SDK, no network.

const state = vi.hoisted(() => ({
  origin: null as string | null,
  user: null as { id: string } | null,
  drafts: [] as unknown[],
  triages: [] as unknown[],
  draftResult: { ok: true, itemId: "11111111-1111-4111-8111-111111111111" } as { ok: true; itemId: string } | { ok: false; code: string },
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
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({
  requireUser: async () => {
    if (!state.user) throw new Redirect("/login");
    return state.user;
  },
}));
vi.mock("@/lib/ai/runtime", () => ({
  draftReplyNow: async (input: unknown) => {
    state.drafts.push(input);
    return state.draftResult;
  },
  triageThreadOnDemand: async (...args: unknown[]) => {
    state.triages.push(args);
    return "triaged";
  },
}));

const actions = await import("@/app/(app)/inbox/[threadId]/ai-actions");
const THREAD = "22222222-2222-4222-8222-222222222222";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("AI actions: sign-in and Origin first (AC9)", () => {
  beforeEach(() => {
    state.drafts = [];
    state.triages = [];
    state.origin = "https://alex.example.com";
    state.user = { id: "33333333-3333-4333-8333-333333333333" };
    state.draftResult = { ok: true, itemId: "11111111-1111-4111-8111-111111111111" };
  });

  it("signed out: /login, and the AI isn't called", async () => {
    state.user = null;
    await expect(actions.draftReplyAction(form({ threadId: THREAD }))).rejects.toMatchObject({ url: "/login" });
    await expect(actions.triageThreadAction(form({ threadId: THREAD }))).rejects.toMatchObject({ url: "/login" });
    expect([state.drafts, state.triages]).toEqual([[], []]);
  });

  it("a missing, foreign or null Origin is refused before the AI is called", async () => {
    for (const origin of [null, "https://evil.example", "null", "http://alex.example.com"]) {
      state.origin = origin;
      await expect(actions.draftReplyAction(form({ threadId: THREAD }))).rejects.toThrow("Request origin not allowed");
      await expect(actions.triageThreadAction(form({ threadId: THREAD }))).rejects.toThrow("Request origin not allowed");
    }
    expect([state.drafts, state.triages]).toEqual([[], []]);
  });

  it("a successful draft opens the new queue item; a failure returns to the thread with a code", async () => {
    await expect(actions.draftReplyAction(form({ threadId: THREAD, mode: "all", instruction: "be brief" }))).rejects.toMatchObject({ url: "/queue/11111111-1111-4111-8111-111111111111" });
    expect(state.drafts).toEqual([{ userId: state.user!.id, threadId: THREAD, mode: "all", instruction: "be brief" }]);
    state.draftResult = { ok: false, code: "refused" };
    await expect(actions.draftReplyAction(form({ threadId: THREAD }))).rejects.toMatchObject({ url: `/inbox/${THREAD}?ai_error=refused#ai` });
    expect(state.drafts[1]).toEqual({ userId: state.user!.id, threadId: THREAD, mode: "reply", instruction: null });
  });

  it("input is validated: a bad thread id or mode is refused", async () => {
    await expect(actions.draftReplyAction(form({ threadId: "x" }))).rejects.toThrow();
    await expect(actions.draftReplyAction(form({ threadId: THREAD, mode: "forward" }))).rejects.toThrow();
    await expect(actions.draftReplyAction(form({ threadId: THREAD, instruction: "x".repeat(4_001) }))).rejects.toThrow();
    expect(state.drafts).toEqual([]);
    await expect(actions.triageThreadAction(form({ threadId: THREAD }))).rejects.toMatchObject({ url: `/inbox/${THREAD}?ai_triage=triaged#ai` });
    expect(state.triages).toEqual([[state.user!.id, THREAD]]);
  });
});
