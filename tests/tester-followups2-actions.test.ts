import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";

// Tester, phase-2-followups-2 (no database; Server Action level, approveAndSend mocked): can any form
// submission reach approve with shownNewer undefined (which skips the digest check, coder deviation 1)?

const state = vi.hoisted(() => ({ approveInputs: [] as Record<string, unknown>[] }));

class Redirect extends Error {
  constructor(public readonly url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://alex.example.com" }) }));
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
  requireUser: async () => ({ id: "33333333-3333-4333-8333-333333333333", email: "owner@example.test" }),
  destroySession: async () => undefined,
}));
vi.mock("@/lib/approvals/execute", () => ({
  approveAndSend: async (_deps: unknown, input: Record<string, unknown>) => {
    state.approveInputs.push(input);
    return { kind: "not_approved", result: { kind: "blocked", reason: "ack_required" } };
  },
}));
vi.mock("@/lib/approvals/runtime", () => ({
  approvalExecutorDeps: () => ({}),
  approvalReconcileDeps: () => ({}),
  messageIdHost: () => "alex.example.com",
}));

const queueActions = await import("@/app/(app)/queue/actions");
const ITEM = "55555555-5555-4555-8555-555555555555";
const base = { itemId: ITEM, revision: "1", contentHash: "a".repeat(64) };
const form = (fields: Record<string, string>, extra?: (f: FormData) => void) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  extra?.(f);
  return f;
};
const D1 = "b".repeat(64);
const D2 = "c".repeat(64);

beforeEach(() => {
  state.approveInputs = [];
});

describe("SF2: every form shape reaches approve with a string shownNewer", () => {
  it("missing, empty, a File, and duplicated fields: shownNewer is always a string (never undefined)", async () => {
    const shapes: [string, FormData][] = [
      ["missing", form(base)],
      ["empty", form({ ...base, shownNewer: "" })],
      ["file", form(base, (f) => f.set("shownNewer", new Blob([D1]), "x.txt"))],
      ["duplicate", form(base, (f) => (f.append("shownNewer", D1), f.append("shownNewer", D2)))],
      ["empty-then-digest", form(base, (f) => (f.append("shownNewer", ""), f.append("shownNewer", D1)))],
    ];
    for (const [name, f] of shapes) {
      await expect(queueActions.approveItemAction(f), name).rejects.toBeInstanceOf(Redirect);
    }
    expect(state.approveInputs.map((i) => i.shownNewer)).toEqual(["", "", "", D1, ""]);
    expect(state.approveInputs.every((i) => typeof i.shownNewer === "string")).toBe(true);
  });

  it("near-miss values are refused before approve (trailing newline, uppercase, padding, 0x prefix)", async () => {
    for (const bad of [`${D1}\n`, `\n${D1}`, D1.toUpperCase(), ` ${D1}`, `0x${D1.slice(2)}`, "0".repeat(128)]) {
      await expect(queueActions.approveItemAction(form({ ...base, shownNewer: bad }))).rejects.not.toBeInstanceOf(Redirect);
    }
    expect(state.approveInputs).toEqual([]);
  });
});
