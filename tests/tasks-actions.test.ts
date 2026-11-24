import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";

// Phase T Server Actions (coder): sign-in and the strict Origin check (AC-S-1), refusals as fixed
// codes, the content-free error path (AC-L-1), and the thread action taking only the thread id
// from the form. next/*, the session, the database and the task service are mocked.

const MARKER = "SECRET-TITLE-MARKER-9d2e";
const ID = "00000000-0000-4000-8000-000000000001";
const THREAD = "00000000-0000-4000-8000-000000000002";

const state = vi.hoisted(() => ({
  origin: "https://alex.example.com" as string | null,
  user: null as { id: string; email: string; timeZone: string | null } | null,
  fail: false,
  calls: [] as { fn: string; args: unknown[] }[],
  revalidated: [] as unknown[][],
  stored: null as null | { status: string; dueTz: string | null; dueDate?: string | null; dueAt?: Date | null },
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
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => void state.revalidated.push(a) }));
vi.mock("@/lib/session", () => ({
  requireUser: async () => {
    if (!state.user) throw new Redirect("/login");
    return state.user;
  },
}));
vi.mock("@/db", async (orig) => ({
  ...(await orig<object>()),
  db: () => new Proxy({}, { get: () => { throw new Error("the database must not be reached directly"); } }),
}));
vi.mock("@/lib/settings", () => ({
  setTimeZone: async (...args: unknown[]) => {
    state.calls.push({ fn: "setTimeZone", args: args.slice(1) });
    if (state.fail) throw Object.assign(new Error(`Failed query: update users params: ${MARKER}`), { cause: { code: "08006", detail: MARKER } });
    return true;
  },
}));
vi.mock("@/lib/tasks/service", () => {
  const write = (fn: string, result: unknown) => async (...args: unknown[]) => {
    state.calls.push({ fn, args: args.slice(1) });
    if (state.fail) throw Object.assign(new Error(`Failed query: insert into "tasks" params: ${MARKER}`), { cause: { code: "08006", detail: MARKER } });
    return result;
  };
  return {
    createTask: write("createTask", { ok: true, taskId: ID, linked: true }),
    updateTask: write("updateTask", { ok: true, fields: ["title"] }),
    completeTask: write("completeTask", { ok: true }),
    reopenTask: write("reopenTask", { ok: true }),
    acceptSuggestion: write("acceptSuggestion", { ok: true }),
    dismissSuggestion: write("dismissSuggestion", { ok: true }),
    deleteTask: write("deleteTask", { ok: true }),
    getTaskForEdit: async () => (state.stored ? { id: ID, dueDate: null, dueAt: null, ...state.stored } : null),
  };
});

const tasks = await import("@/app/(app)/tasks/actions");
const settings = await import("@/app/(app)/settings/actions");
const { TaskActionError, TASK_ACTION_ERROR_MESSAGE } = await import("@/lib/tasks/errors");

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const taskForm = (over: Record<string, string> = {}) => form({ title: `Pay ${MARKER}`, notes: "", priority: "normal", due_kind: "none", due_date: "", due_time: "", ...over });
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
  throw new Error("no redirect");
}

const ACTIONS: [string, (f: FormData) => Promise<unknown>, () => FormData][] = [
  ["createTaskAction", tasks.createTaskAction, () => taskForm()],
  ["createTaskFromThreadAction", tasks.createTaskFromThreadAction, () => taskForm({ threadId: THREAD })],
  ["updateTaskAction", tasks.updateTaskAction, () => taskForm({ taskId: ID })],
  ["completeTaskAction", tasks.completeTaskAction, () => form({ taskId: ID })],
  ["reopenTaskAction", tasks.reopenTaskAction, () => form({ taskId: ID })],
  ["acceptSuggestionAction", tasks.acceptSuggestionAction, () => form({ taskId: ID })],
  ["dismissSuggestionAction", tasks.dismissSuggestionAction, () => form({ taskId: ID })],
  ["deleteTaskAction", tasks.deleteTaskAction, () => form({ taskId: ID, confirm: "yes" })],
  ["setTimeZoneAction", settings.setTimeZoneAction, () => form({ zone: "Europe/London" })],
];

beforeEach(() => {
  state.origin = "https://alex.example.com";
  state.user = { id: "u1", email: "owner@example.com", timeZone: "America/New_York" };
  state.fail = false;
  state.calls = [];
  state.revalidated = [];
  state.stored = { status: "open", dueTz: null };
});

describe("every task and settings action requires sign-in and the app's Origin (AC-S-1)", () => {
  it("covers every exported action", () => {
    expect([...Object.keys(tasks), ...Object.keys(settings)].sort()).toEqual(ACTIONS.map(([n]) => n).sort());
  });
  for (const [name, action, make] of ACTIONS) {
    it(name, async () => {
      state.user = null;
      expect(await redirectOf(action(make()))).toBe("/login");
      state.user = { id: "u1", email: "owner@example.com", timeZone: null };
      for (const origin of [null, "null", "https://evil.example", "http://alex.example.com", "https://alex.example.com.evil.example"]) {
        state.origin = origin;
        await expect(action(make()), String(origin)).rejects.toThrow("Request origin not allowed");
      }
      expect(state.calls).toEqual([]);
      state.origin = "https://alex.example.com";
      await redirectOf(action(make()));
      expect(state.calls.length).toBe(1);
      expect(state.revalidated).toEqual([["/", "layout"]]);
    });
  }
});

describe("refusals are fixed codes; typed text never goes into a URL", () => {
  it("create: invalid title, gap time, bad date, oversize fields", async () => {
    expect(await redirectOf(tasks.createTaskAction(taskForm({ title: `a\tb ${MARKER}` })))).toBe("/tasks?error=title_invalid");
    expect(await redirectOf(tasks.createTaskAction(taskForm({ due_kind: "datetime", due_date: "2026-03-08", due_time: "02:30" })))).toBe("/tasks?error=time_in_gap");
    expect(await redirectOf(tasks.createTaskAction(taskForm({ due_kind: "date", due_date: "2026-02-30" })))).toBe("/tasks?error=date_invalid");
    expect(await redirectOf(tasks.createTaskAction(taskForm({ title: "x".repeat(2001) })))).toBe("/tasks?error=title_too_long");
    expect(await redirectOf(tasks.createTaskAction(taskForm({ notes: "x".repeat(40_001) })))).toBe("/tasks?error=notes_too_long");
    expect(await redirectOf(tasks.createTaskAction(taskForm({ priority: "urgent" })))).toBe("/tasks?error=form_invalid");
    expect(await redirectOf(tasks.createTaskAction(taskForm({ due_kind: "weekly" })))).toBe("/tasks?error=form_invalid");
    expect(state.calls).toEqual([]);
  });
  it("create uses the owner's zone for a date-time deadline (UTC when unset)", async () => {
    await redirectOf(tasks.createTaskAction(taskForm({ due_kind: "datetime", due_date: "2026-03-10", due_time: "09:00" })));
    state.user = { id: "u1", email: "owner@example.com", timeZone: null };
    await redirectOf(tasks.createTaskAction(taskForm({ due_kind: "datetime", due_date: "2026-03-10", due_time: "09:00" })));
    const dues = state.calls.map((c) => (c.args[0] as { task: { due: unknown } }).task.due);
    expect(dues).toEqual([
      { kind: "datetime", at: new Date("2026-03-10T13:00:00Z"), tz: "America/New_York" },
      { kind: "datetime", at: new Date("2026-03-10T09:00:00Z"), tz: "UTC" },
    ]);
  });
  it("update keeps the task's own zone for a date-time deadline; stale and unknown ids show the stale notice", async () => {
    state.stored = { status: "open", dueTz: "Europe/London" };
    expect(await redirectOf(tasks.updateTaskAction(taskForm({ taskId: ID, due_kind: "datetime", due_date: "2026-07-01", due_time: "09:00" })))).toBe(`/tasks/${ID}?notice=saved`);
    expect((state.calls[0]!.args[0] as { task: { due: unknown } }).task.due).toEqual({ kind: "datetime", at: new Date("2026-07-01T08:00:00Z"), tz: "Europe/London" });
    expect(await redirectOf(tasks.updateTaskAction(taskForm({ taskId: ID, title: "" })))).toBe(`/tasks/${ID}?error=title_empty`);
    state.stored = { status: "suggested", dueTz: null };
    expect(await redirectOf(tasks.updateTaskAction(taskForm({ taskId: ID })))).toBe("/tasks?notice=stale");
    state.stored = null;
    expect(await redirectOf(tasks.updateTaskAction(taskForm({ taskId: ID })))).toBe("/tasks?notice=stale");
    expect(await redirectOf(tasks.updateTaskAction(taskForm({ taskId: "not-a-uuid" })))).toBe("/tasks?notice=stale");
    expect(state.calls.length).toBe(1);
  });
  it("delete needs the confirmation tick; quick actions return where they came from", async () => {
    expect(await redirectOf(tasks.deleteTaskAction(form({ taskId: ID })))).toBe(`/tasks/${ID}?error=confirm_delete`);
    expect(state.calls).toEqual([]);
    expect(await redirectOf(tasks.deleteTaskAction(form({ taskId: ID, confirm: "yes" })))).toBe("/tasks?notice=deleted");
    expect(await redirectOf(tasks.completeTaskAction(form({ taskId: ID, return: "done" })))).toBe("/tasks?view=done");
    expect(await redirectOf(tasks.completeTaskAction(form({ taskId: ID, return: "detail" })))).toBe(`/tasks/${ID}`);
    expect(await redirectOf(tasks.completeTaskAction(form({ taskId: ID, return: "https://evil.example" })))).toBe("/tasks");
    expect(await redirectOf(tasks.completeTaskAction(form({ taskId: "x" })))).toBe("/tasks?notice=stale");
  });
  it("a filled-in field the deadline choice doesn't use is refused on all three forms, never dropped (round 2, SF1)", async () => {
    const mismatches = [
      { due_kind: "none", due_date: "2026-05-01" },
      { due_kind: "none", due_time: "09:00" },
      { due_kind: "none", due_date: "2026-05-01", due_time: "09:00" },
      { due_kind: "date", due_date: "2026-05-01", due_time: "09:00" },
      // A missing radio is read as "none", so a date posted without one is refused too.
      { due_date: "2026-05-01" },
    ];
    state.stored = { status: "open", dueTz: null };
    for (const m of mismatches) {
      const mk = (extra: Record<string, string> = {}) => {
        const f = taskForm({ ...extra, ...(m as Record<string, string>) });
        if (!("due_kind" in m)) f.delete("due_kind");
        return f;
      };
      const label = JSON.stringify(m);
      expect(await redirectOf(tasks.createTaskAction(mk())), label).toBe("/tasks?error=due_kind_mismatch");
      expect(await redirectOf(tasks.updateTaskAction(mk({ taskId: ID }))), label).toBe(`/tasks/${ID}?error=due_kind_mismatch`);
      expect(await redirectOf(tasks.createTaskFromThreadAction(mk({ threadId: THREAD }))), label).toBe(`/inbox/${THREAD}?task=1&task_error=due_kind_mismatch#task`);
    }
    expect(state.calls).toEqual([]);
    // Matching choices still save.
    expect(await redirectOf(tasks.createTaskAction(taskForm({ due_kind: "date", due_date: "2026-05-01" })))).toBe("/tasks?notice=saved");
    expect(await redirectOf(tasks.createTaskAction(taskForm({ due_kind: "none", due_date: " ", due_time: "" })))).toBe("/tasks?notice=saved");
    expect(state.calls.map((c) => (c.args[0] as { task: { due: unknown } }).task.due)).toEqual([{ kind: "date", date: "2026-05-01" }, { kind: "none" }]);
  });
  it("edit: None or Date with only the pre-filled leftovers saves; a changed leftover is refused; create and thread stay strict (round 3)", async () => {
    const dueOf = (i: number) => (state.calls[i]!.args[0] as { task: { due: unknown; title: string } }).task;
    // Stored 2026-12-01 14:00 UTC in New York: the edit page pre-fills 2026-12-01 and 09:00.
    state.stored = { status: "open", dueDate: null, dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: "America/New_York" };
    state.user = { id: "u1", email: "owner@example.com", timeZone: "Europe/London" };
    const edit = (over: Record<string, string>) => redirectOf(tasks.updateTaskAction(taskForm({ taskId: ID, ...over })));
    for (const due of [
      { due_kind: "none", due_date: "2026-12-02", due_time: "09:00" },
      { due_kind: "none", due_date: "2026-12-01", due_time: "09:30" },
      // The UTC and owner-zone wall times are not what the page showed.
      { due_kind: "none", due_date: "2026-12-01", due_time: "14:00" },
      { due_kind: "date", due_date: "2026-12-02", due_time: "09:00" },
      { due_kind: "date", due_date: "2026-12-01", due_time: "10:00" },
    ]) {
      expect(await edit(due), JSON.stringify(due)).toBe(`/tasks/${ID}?error=due_kind_mismatch`);
    }
    expect(state.calls).toEqual([]);
    expect(await edit({ due_kind: "none", due_date: "2026-12-01", due_time: "09:00", title: "Renamed" })).toBe(`/tasks/${ID}?notice=saved`);
    expect(await edit({ due_kind: "none", due_date: "2026-12-01", due_time: "" })).toBe(`/tasks/${ID}?notice=saved`);
    expect(await edit({ due_kind: "date", due_date: "2026-12-01", due_time: "09:00" })).toBe(`/tasks/${ID}?notice=saved`);
    expect([dueOf(0), dueOf(1).due, dueOf(2).due]).toEqual([{ title: "Renamed", notes: null, priority: "normal", due: { kind: "none" } }, { kind: "none" }, { kind: "date", date: "2026-12-01" }]);
    // An unrecognised stored zone: the page shows the owner's zone (14:00 in London), and that is what matches.
    state.calls = [];
    state.stored = { status: "open", dueDate: null, dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: "Mars/Olympus" };
    expect(await edit({ due_kind: "none", due_date: "2026-12-01", due_time: "09:00" })).toBe(`/tasks/${ID}?error=due_kind_mismatch`);
    expect(await edit({ due_kind: "none", due_date: "2026-12-01", due_time: "14:00" })).toBe(`/tasks/${ID}?notice=saved`);
    // A date-only task: its date may be left with None; a time can't be.
    state.stored = { status: "open", dueDate: "2026-05-01", dueAt: null, dueTz: null };
    expect(await edit({ due_kind: "none", due_date: "2026-05-01" })).toBe(`/tasks/${ID}?notice=saved`);
    expect(await edit({ due_kind: "none", due_date: "2026-05-02" })).toBe(`/tasks/${ID}?error=due_kind_mismatch`);
    expect(await edit({ due_kind: "date", due_date: "2026-05-01", due_time: "09:00" })).toBe(`/tasks/${ID}?error=due_kind_mismatch`);
    expect(state.calls.map((c) => (c.args[0] as { task: { due: unknown } }).task.due)).toEqual([{ kind: "none" }, { kind: "none" }]);
    // The create forms never use a prefill, whatever the stored task is.
    state.calls = [];
    state.stored = { status: "open", dueDate: null, dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: "America/New_York" };
    for (const due of [
      { due_kind: "none", due_date: "2026-12-01", due_time: "09:00" },
      { due_kind: "date", due_date: "2026-12-01", due_time: "09:00" },
    ]) {
      expect(await redirectOf(tasks.createTaskAction(taskForm({ taskId: ID, ...due })))).toBe("/tasks?error=due_kind_mismatch");
      expect(await redirectOf(tasks.createTaskFromThreadAction(taskForm({ threadId: THREAD, taskId: ID, ...due })))).toBe(`/inbox/${THREAD}?task=1&task_error=due_kind_mismatch#task`);
    }
    expect(state.calls).toEqual([]);
  });
  it("settings: unknown zones are refused; the typed name wins and is canonicalised", async () => {
    expect(await redirectOf(settings.setTimeZoneAction(form({ zone: "+05:30" })))).toBe("/settings?error=zone_invalid");
    expect(await redirectOf(settings.setTimeZoneAction(form({ zone: "Bogus/Zone" })))).toBe("/settings?error=zone_invalid");
    expect(state.calls).toEqual([]);
    expect(await redirectOf(settings.setTimeZoneAction(form({ zone: "UTC", zone_text: " america/new_york " })))).toBe("/settings?notice=saved");
    expect(await redirectOf(settings.setTimeZoneAction(form({ zone: "Etc/UTC", zone_text: "" })))).toBe("/settings?notice=saved");
    expect(state.calls.map((c) => c.args)).toEqual([
      ["u1", "America/New_York"],
      ["u1", "UTC"],
    ]);
  });
});

describe("Add task from a thread", () => {
  it("passes only the thread id from the form (never an account or subject), and handles a vanished thread", async () => {
    const url = await redirectOf(tasks.createTaskFromThreadAction(taskForm({ threadId: THREAD, accountId: ID, subject: "forged", sourceAccountId: ID })));
    expect(url).toBe("/tasks?notice=saved");
    const arg = state.calls[0]!.args[0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(["now", "task", "threadId", "userId"]);
    expect(arg.threadId).toBe(THREAD);
    expect(arg.userId).toBe("u1");
    expect(JSON.stringify(arg)).not.toContain("forged");
    expect(await redirectOf(tasks.createTaskFromThreadAction(taskForm({ threadId: THREAD, title: "" })))).toBe(`/inbox/${THREAD}?task=1&task_error=title_empty#task`);
    expect(await redirectOf(tasks.createTaskFromThreadAction(taskForm({ threadId: "nope" })))).toBe("/inbox?notice=task_thread_gone");
  });
});

describe("a database error is logged content-free and replaced by a fixed error (AC-L-1)", () => {
  for (const [name, action, make] of ACTIONS) {
    it(name, async () => {
      state.fail = true;
      const logged: unknown[][] = [];
      const spies = (["error", "warn", "log", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a)));
      let thrown: unknown;
      try {
        await action(make());
      } catch (e) {
        thrown = e;
      } finally {
        for (const s of spies) s.mockRestore();
      }
      expect(thrown).toBeInstanceOf(TaskActionError);
      const e = thrown as Error;
      expect(e.message).toBe(TASK_ACTION_ERROR_MESSAGE);
      expect(e.cause).toBeUndefined();
      expect(String(e.stack)).not.toContain(MARKER);
      expect(JSON.stringify(logged)).not.toContain(MARKER);
      expect(logged.length).toBe(1);
      expect(logged[0]![1]).toEqual({ action: expect.any(String), error: "Error", code: "08006" });
      expect(state.revalidated).toEqual([]);
    });
  }
});
