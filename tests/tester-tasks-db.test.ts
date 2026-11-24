import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import { appendFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { deleteAccount } from "@/lib/accounts";
import { deleteStoredMessage } from "@/lib/gmail/store";
import { setTimeZone } from "@/lib/settings";
import { completeTask, createTask, deleteTask, updateTask } from "@/lib/tasks/service";
import * as T from "@/lib/tasks/time";
import { subjectPrefill, type TaskInput } from "@/lib/tasks/validate";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester additions for phase-t-tasks (03-test-report.md), Postgres only (TEST_DATABASE_URL):
// - the REAL pages against a real database: the nav badge equals the Overdue + Today rows that
//   /tasks shows, and the Accounts banner agrees, at DST-edge instants in several zones;
// - another user's task and thread ids through the real actions: stale / gone, nothing written;
// - "Add task" from a thread with a hostile subject: the prefill, the links, then Disconnect;
// - real Drizzle errors (a trigger that raises) through the real actions: the log and the thrown
//   error carry no title or notes (and the unguarded error really would have);
// - races on a 12-connection pool with tallies: double clicks, create vs Disconnect / Gmail delete.

const state = vi.hoisted(() => ({
  db: null as unknown,
  user: null as unknown,
  origin: "https://alex.example.com" as string | null,
}));

vi.mock("@/db", async (orig) => ({ ...(await orig<object>()), db: () => state.db }));
vi.mock("@/lib/session", () => ({
  requireUser: async () => {
    if (!state.user) throw new Error("REDIRECT /login");
    return state.user;
  },
  currentUser: async () => state.user,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (u: string) => {
    throw new Error(`REDIRECT ${u}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(state.origin === null ? {} : { origin: state.origin }) }));
vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<object>()),
  env: () => ({ GOOGLE_OAUTH_TESTING_MODE: true, APP_URL: "https://alex.example.com/" }),
}));
vi.mock("@/app/(app)/inbox/[threadId]/message-body", () => ({ MessageBody: () => null }));
vi.mock("@/app/(app)/inbox/[threadId]/ai-panel", () => ({ AiPanel: () => null }));

type Page<P> = { default: (props: P) => Promise<ReactNode> };
const MARK = "TESTER-CONTENT-MARK-5f1e";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scratch = (line: string) => {
  if (process.env.TESTER_SCRATCH) appendFileSync(process.env.TESTER_SCRATCH, `tester-tasks-db ${line}\n`);
};
const pgCode = (err: unknown): string => {
  const e = err as { cause?: { code?: string }; code?: string };
  return e?.cause?.code ?? e?.code ?? (err instanceof Error ? err.name : "?");
};
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const attr = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const input = (over: Partial<TaskInput> = {}): TaskInput => ({ title: `T ${MARK}`, notes: `N ${MARK}`, priority: "normal", due: { kind: "none" }, ...over });
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const m = /^REDIRECT (.*)$/.exec((e as Error).message);
    if (m) return m[1]!;
    throw e;
  }
  throw new Error("no redirect");
}

/** The rows of one /tasks section: the <li> count between its <h2> and the next <h2>/<section> end. */
function sectionCount(html: string, title: string): number {
  const at = html.search(new RegExp(`<h2[^>]*>${title}</h2>`));
  if (at < 0) return 0;
  const rest = html.slice(at + 1);
  const next = rest.search(/<h2[^>]*>/);
  const chunk = next < 0 ? rest : rest.slice(0, next);
  return (chunk.match(/<li[ >]/g) ?? []).length;
}

describe.skipIf(!testDbUrl)("Phase T tester (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;
  let userId: string;
  let otherId: string;
  let account: ConnectedAccount;
  let actions: typeof import("@/app/(app)/tasks/actions");
  let settingsActions: typeof import("@/app/(app)/settings/actions");
  let TasksPage: Page<{ searchParams: Promise<Record<string, string>> }>["default"];
  let TaskPage: Page<{ params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }>["default"];
  let ThreadPage: Page<{ params: Promise<{ threadId: string }>; searchParams: Promise<Record<string, string>> }>["default"];
  let AccountsPage: Page<{ searchParams: Promise<Record<string, string>> }>["default"];
  let AppLayout: Page<{ children: ReactNode }>["default"];

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    pool = postgres(testDbUrl!, { max: 12, onnotice: () => {} });
    poolDb = drizzle(pool, { schema }) as unknown as Database;
    actions = await import("@/app/(app)/tasks/actions");
    settingsActions = await import("@/app/(app)/settings/actions");
    TasksPage = ((await import("@/app/(app)/tasks/page")) as unknown as Page<{ searchParams: Promise<Record<string, string>> }>).default;
    TaskPage = ((await import("@/app/(app)/tasks/[id]/page")) as unknown as Page<{ params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }>).default;
    ThreadPage = ((await import("@/app/(app)/inbox/[threadId]/page")) as unknown as Page<{ params: Promise<{ threadId: string }>; searchParams: Promise<Record<string, string>> }>).default;
    AccountsPage = ((await import("@/app/(app)/page")) as unknown as Page<{ searchParams: Promise<Record<string, string>> }>).default;
    AppLayout = ((await import("@/app/(app)/layout")) as unknown as Page<{ children: ReactNode }>).default;
  });
  afterAll(async () => {
    await pool.end();
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    otherId = (await makeUser(database, "other@example.com")).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com" });
    state.db = database;
    state.origin = "https://alex.example.com";
    await signIn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function signIn(id = userId) {
    state.user = (await database.select().from(schema.users).where(eq(schema.users.id, id)))[0];
  }
  async function setZone(zone: string | null) {
    await database.update(schema.users).set({ timeZone: zone }).where(eq(schema.users.id, userId));
    await signIn();
  }
  let seq = 0;
  async function thread(acc: ConnectedAccount = account, subject: string | null = "Invoice due") {
    seq++;
    const gt = `gt-${seq}-${Math.random().toString(36).slice(2)}`;
    const [t] = await database
      .insert(schema.mailThreads)
      .values({ userId: acc.userId, accountId: acc.id, gmailThreadId: gt, subject, lastMessageAt: new Date(), messageCount: 1, inInbox: true, hasUnread: false })
      .returning();
    const gmailMessageId = `m-${seq}-${Math.random().toString(36).slice(2)}`;
    await database.insert(schema.mailMessages).values({
      userId: acc.userId,
      accountId: acc.id,
      threadId: t!.id,
      gmailMessageId,
      gmailThreadId: gt,
      internalDate: new Date(),
      labelIds: ["INBOX"],
      isSent: false,
      subject,
      headers: [],
      bodyText: "Hello",
    });
    return { thread: t!, gmailMessageId };
  }
  type Raw = Partial<typeof schema.tasks.$inferInsert>;
  async function raw(over: Raw) {
    const [r] = await database
      .insert(schema.tasks)
      .values({ userId, title: "t", source: "manual", status: "open", ...over })
      .returning({ id: schema.tasks.id });
    return r!.id;
  }
  const audits = async () =>
    database
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.action} like 'task.%' or ${schema.auditLog.action} like 'settings.%'`);
  const taskRow = async (id: string) => (await database.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0];
  const render = async (el: Promise<ReactNode>) => renderToStaticMarkup((await el) as never);

  // ---- The real pages: badge = Overdue + Today rows ---------------------------------------------

  it.each([
    ["Australia/Lord_Howe", "2026-04-04T13:20:00Z"], // 00:20 on the day of the 30-minute fall-back
    ["Australia/Lord_Howe", "2026-10-03T15:45:00Z"], // just after the 30-minute spring gap
    ["America/Santiago", "2026-04-05T03:30:00Z"], // inside the repeated 23:xx hour of 04-04
    ["America/Santiago", "2026-09-06T04:00:00Z"], // the first instant of 09-06 (midnight doesn't exist)
    ["America/New_York", "2026-03-08T06:59:00Z"], // a minute before the spring gap
    ["America/New_York", "2026-11-01T05:59:00Z"], // inside the overlap (first 01:59)
    ["Europe/London", "2026-03-29T00:30:00Z"], // 00:30, just before the gap
    ["Pacific/Kiritimati", "2026-06-01T11:00:00Z"], // +14, a different local date from UTC
    [null, "2026-06-01T12:00:00Z"], // zone not set: UTC
  ])("zone %s at %s: the nav badge and the Accounts banner equal the Overdue + Today rows on /tasks", async (zoneSetting, iso) => {
    const now = new Date(iso);
    await setZone(zoneSetting);
    const zone = zoneSetting ?? "UTC";
    const b = T.dayBounds(now, zone);
    const today = b.today;
    // Open tasks across every edge.
    for (const d of [T.addDays(today, -1), today, T.addDays(today, 1), T.addDays(today, 14), T.addDays(today, 15)]) await raw({ dueDate: d });
    for (const ms of [now.getTime() - 60_000, now.getTime(), now.getTime() + 60_000, b.tomorrowStart.getTime() - 60_000, b.tomorrowStart.getTime(), b.upcomingEnd.getTime() - 1, b.upcomingEnd.getTime()]) {
      await raw({ dueAt: new Date(ms), dueTz: zone });
    }
    await raw({}); // no date
    // Statuses and users that must never count.
    await raw({ status: "suggested", dueDate: T.addDays(today, -3) });
    await raw({ status: "suggested", dueAt: new Date(now.getTime() - 1000), dueTz: zone });
    await raw({ status: "done", completedAt: now, dueDate: today });
    await raw({ status: "dismissed", dueDate: T.addDays(today, -2) });
    await raw({ userId: otherId, dueDate: T.addDays(today, -1) });
    await raw({ userId: otherId, dueAt: new Date(now.getTime() - 1000), dueTz: zone });

    vi.useFakeTimers({ toFake: ["Date"], now });
    const layout = await render(AppLayout({ children: null }));
    const page = await render(TasksPage({ searchParams: Promise.resolve({}) }));
    const accounts = await render(AccountsPage({ searchParams: Promise.resolve({}) }));
    vi.useRealTimers();

    const overdue = sectionCount(page, "Overdue");
    const todayRows = sectionCount(page, "Today");
    // Hand-derived: overdue = yesterday's date, now-1min, exactly now; today = today's date, now+1min, tomorrowStart-1min.
    expect([overdue, todayRows], iso).toEqual([3, 3]);
    expect(sectionCount(page, "Suggested")).toBe(2);
    expect(sectionCount(page, "Later")).toBe(2); // day 15 (date) and upcomingEnd (instant)
    expect(sectionCount(page, "No date")).toBe(1);
    expect(layout).toMatch(/aria-label="6 due"[^>]*>6</);
    expect(textOf(accounts)).toContain("3 tasks overdue \u00B7 3 due today \u2192 Tasks");
    // Upcoming: day 1, tomorrowStart (day 1), upcomingEnd-1ms (day 14) and day 14 by date.
    const up = page.slice(page.search(/<h2[^>]*>Upcoming<\/h2>/));
    expect((up.slice(0, up.search(/<h2[^>]*>Later<\/h2>/)).match(/<li[ >]/g) ?? []).length).toBe(4);
  });

  it("a task whose stored due_tz the runtime doesn't know still renders on /tasks, /tasks/[id] and in the badge", async () => {
    await setZone("Europe/London");
    const id = await raw({ dueAt: new Date(Date.now() - 60_000), dueTz: "Bogus/Zone" });
    const layout = await render(AppLayout({ children: null }));
    const page = await render(TasksPage({ searchParams: Promise.resolve({}) }));
    const edit = await render(TaskPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
    expect(layout).toContain('aria-label="1 due"');
    expect(sectionCount(page, "Overdue")).toBe(1);
    expect(textOf(edit)).toContain("Europe/London");
  });

  it.each([
    ["America/New_York", "2026-11-01T05:30:00Z"], // the earlier 01:30 of the overlap
    ["Australia/Lord_Howe", "2026-04-04T14:45:00Z"], // 01:45 +11, the earlier of the 30-minute overlap
    ["Asia/Calcutta", "2026-03-10T13:00:00Z"], // +05:30
    ["Pacific/Chatham", "2026-09-26T13:00:00Z"], // +12:45
  ])("editing only the title of a date-time task entered in %s keeps due_at and due_tz exactly (the edit form re-parses to the same instant)", async (taskZone, iso) => {
    await setZone("Europe/London");
    const id = await raw({ title: "before", notes: "keep\nme", priority: "high", dueAt: new Date(iso), dueTz: taskZone });
    const html = await render(TaskPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
    const val = (name: string) => attr(new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? new RegExp(`<input[^>]*value="([^"]*)"[^>]*name="${name}"`).exec(html)?.[1] ?? "");
    const kind = [...html.matchAll(/<input[^>]*name="due_kind"[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes('checked=""')).map((t) => /value="(\w+)"/.exec(t)?.[1]);
    expect(kind).toHaveLength(1);
    const notes = attr(/<textarea[^>]*name="notes"[^>]*>([^<]*)<\/textarea>/.exec(html)?.[1] ?? "");
    const priority = /<option value="(\w+)" selected="">/.exec(html)?.[1];
    expect([kind[0], priority, notes]).toEqual(["datetime", "high", "keep\nme"]);
    expect(textOf(html)).toContain(`Time zone: ${taskZone} (this task's zone`);
    // Unchanged submit: nothing written, nothing audited.
    const fields = { taskId: id, title: "before", notes, priority: priority!, due_kind: kind[0]!, due_date: val("due_date"), due_time: val("due_time") };
    expect(await redirectOf(actions.updateTaskAction(form(fields)))).toBe(`/tasks/${id}?notice=saved`);
    expect(await audits()).toEqual([]);
    // Title-only change: the deadline stays the same instant in the same zone.
    expect(await redirectOf(actions.updateTaskAction(form({ ...fields, title: "after" })))).toBe(`/tasks/${id}?notice=saved`);
    expect(await taskRow(id)).toMatchObject({ title: "after", dueAt: new Date(iso), dueTz: taskZone, notes: "keep\nme", priority: "high" });
    expect((await audits()).map((a) => a.detail)).toEqual([{ taskId: id, fields: ["title"] }]);
    // A gap time entered on this task is refused with the task's own zone named.
    const gap = await render(TaskPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ error: "time_in_gap" }) }));
    expect(textOf(gap)).toContain(`That time doesn't exist on that day in ${taskZone} because of the clock change.`);
  });

  // ---- User scoping through the real actions -----------------------------------------------------

  it("another user's task id: the edit page is notFound and every action is stale, with nothing written or audited", async () => {
    const theirs = await raw({ userId: otherId, title: "theirs", dueDate: "2026-06-01" });
    const theirsDone = await raw({ userId: otherId, title: "theirs-done", status: "done", completedAt: new Date() });
    const theirsSuggested = await raw({ userId: otherId, title: "theirs-sugg", status: "suggested" });
    await expect(TaskPage({ params: Promise.resolve({ id: theirs }), searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
    const before = await database.select().from(schema.tasks).orderBy(schema.tasks.id);
    const tf = (id: string) => form({ taskId: id, title: "hijack", notes: "", priority: "high", due_kind: "none", due_date: "", due_time: "" });
    expect(await redirectOf(actions.updateTaskAction(tf(theirs)))).toBe("/tasks?notice=stale");
    expect(await redirectOf(actions.completeTaskAction(form({ taskId: theirs })))).toBe("/tasks?notice=stale");
    expect(await redirectOf(actions.reopenTaskAction(form({ taskId: theirsDone, return: "done" })))).toBe("/tasks?view=done&notice=stale");
    expect(await redirectOf(actions.acceptSuggestionAction(form({ taskId: theirsSuggested })))).toBe("/tasks?notice=stale");
    expect(await redirectOf(actions.dismissSuggestionAction(form({ taskId: theirsSuggested })))).toBe("/tasks?notice=stale");
    expect(await redirectOf(actions.deleteTaskAction(form({ taskId: theirs, confirm: "yes" })))).toBe("/tasks?notice=stale");
    expect(await database.select().from(schema.tasks).orderBy(schema.tasks.id)).toEqual(before);
    expect(await audits()).toEqual([]);
  });

  it("another user's thread id on Add task: task_thread_gone, nothing written", async () => {
    const otherAcc = await makeGoogleAccount(database, otherId, { email: "other-work@example.com" });
    const { thread: t } = await thread(otherAcc, "Their secret subject");
    await expect(ThreadPage({ params: Promise.resolve({ threadId: t.id }), searchParams: Promise.resolve({ task: "1" }) })).rejects.toThrow("NOT_FOUND");
    const url = await redirectOf(
      actions.createTaskFromThreadAction(form({ threadId: t.id, title: "x", notes: "", priority: "normal", due_kind: "none", due_date: "", due_time: "" })),
    );
    expect(url).toBe("/inbox?notice=task_thread_gone");
    expect(await database.select().from(schema.tasks)).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("forged form fields (status, source, links, user) are ignored by createTaskAction", async () => {
    const { thread: t } = await thread();
    const url = await redirectOf(
      actions.createTaskAction(
        form({ title: "plain", notes: "", priority: "low", due_kind: "none", due_date: "", due_time: "", status: "done", source: "email", sourceThreadId: t.id, sourceAccountId: account.id, threadId: t.id, userId: otherId }),
      ),
    );
    expect(url).toBe("/tasks?notice=saved");
    const rows = await database.select().from(schema.tasks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, status: "open", source: "manual", sourceThreadId: null, sourceAccountId: null, priority: "low", completedAt: null });
  });

  it("delete needs the exact confirmation value; a missing or wrong tick deletes nothing", async () => {
    const id = await raw({ title: "keep me" });
    for (const confirm of [undefined, "", "no", "YES", "yes "]) {
      const f = form(confirm === undefined ? { taskId: id } : { taskId: id, confirm });
      expect(await redirectOf(actions.deleteTaskAction(f)), String(confirm)).toBe(`/tasks/${id}?error=confirm_delete`);
    }
    expect(await taskRow(id)).toBeDefined();
    expect(await audits()).toEqual([]);
    expect(await redirectOf(actions.deleteTaskAction(form({ taskId: id, confirm: "yes" })))).toBe("/tasks?notice=deleted");
    expect(await taskRow(id)).toBeUndefined();
    expect((await audits()).map((a) => [a.action, a.detail])).toEqual([["task.deleted", { taskId: id }]]);
    // The delete page's own form posts confirm=yes only from the checkbox.
    const id2 = await raw({ title: "page" });
    const html = await render(TaskPage({ params: Promise.resolve({ id: id2 }), searchParams: Promise.resolve({}) }));
    expect(html).toMatch(/<input type="checkbox" name="confirm" value="yes"\/>/);
    expect(html).not.toMatch(/type="hidden" name="confirm"/);
  });

  // ---- Add task from a thread with a hostile subject, then Disconnect ---------------------------

  it("the thread page prefills the stripped subject; saving links the thread; after Disconnect the task says the email is gone", async () => {
    await setZone("America/New_York");
    const subject = `Pay \u202Eexe.fdp\u202C now\u0085\u009b31m \u2066\u2069\u200B\u200D\u{E0041}\t\nsoon ${"x".repeat(600)}`;
    const { thread: t } = await thread(account, subject);
    const html = await render(ThreadPage({ params: Promise.resolve({ threadId: t.id }), searchParams: Promise.resolve({ task: "1" }) }));
    const titleInput = /<input[^>]*name="title"[^>]*>/.exec(html.slice(html.indexOf('id="task"')))?.[0] ?? "";
    const value = attr(/value="([^"]*)"/.exec(titleInput)?.[1] ?? "");
    expect(value).toBe(subjectPrefill(subject));
    expect(value.startsWith("Pay exe.fdp now31m soon xxx")).toBe(true);
    expect(value.length).toBeLessThanOrEqual(500);
    for (const c of [0x202e, 0x202c, 0x85, 0x9b, 0x2066, 0x2069, 0x200b, 0x200d, 0x09, 0x0a]) expect(value.includes(String.fromCharCode(c))).toBe(false);
    expect(value.includes("\u{E0041}")).toBe(false);
    // The form carries only the thread id, never the account or subject.
    const taskForm = html.slice(html.indexOf('id="task"'));
    const hidden = [...taskForm.matchAll(/<input type="hidden" name="([^"]+)"/g)].map((m) => m[1]);
    expect(hidden).toEqual(["threadId"]);
    expect(taskForm).toContain("Time zone: America/New_York");

    const url = await redirectOf(
      actions.createTaskFromThreadAction(form({ threadId: t.id, title: value, notes: "", priority: "normal", due_kind: "date", due_date: "2026-12-01", due_time: "" })),
    );
    expect(url).toBe("/tasks?notice=saved");
    const [task] = await database.select().from(schema.tasks);
    expect(task).toMatchObject({ source: "email", sourceAccountId: account.id, sourceThreadId: t.id, title: value, dueDate: "2026-12-01" });
    let list = await render(TasksPage({ searchParams: Promise.resolve({}) }));
    expect(list).toContain(`href="/inbox/${t.id}"`);

    await deleteAccount(database, userId, account.id);
    const after = await taskRow(task!.id);
    expect(after).toMatchObject({ source: "email", sourceAccountId: null, sourceThreadId: null, title: value, dueDate: "2026-12-01", status: "open" });
    list = await render(TasksPage({ searchParams: Promise.resolve({}) }));
    expect(textOf(list)).toContain("From an email (no longer in Alex)");
    expect(list).not.toContain("/inbox/");
    const edit = await render(TaskPage({ params: Promise.resolve({ id: task!.id }), searchParams: Promise.resolve({}) }));
    expect(textOf(edit)).toContain("From an email (no longer in Alex)");
    // The audit rows don't hold the subject, title or zone.
    const details = JSON.stringify((await audits()).map((a) => a.detail));
    expect(details).not.toContain("Pay");
    expect(details).not.toContain("America/New_York");
    expect(details).not.toContain("2026-12-01");
  });

  // ---- Real database errors through the real actions ---------------------------------------------

  it("a real Drizzle error (a trigger raises) in every write action is logged as {action, error, code} only; the marker never leaks", async () => {
    await setZone("Europe/London");
    const { thread: t } = await thread();
    const open = await raw({ title: "existing" });
    const done = await raw({ title: "existing-done", status: "done", completedAt: new Date() });
    const sugg = await raw({ title: "existing-sugg", status: "suggested" });
    await database.execute(sql.raw(`create function tester_fail() returns trigger language plpgsql as $$ begin raise exception 'tester forced failure'; end $$`));
    await database.execute(sql.raw(`create trigger tester_fail_tasks before insert or update or delete on tasks for each row execute function tester_fail()`));
    await database.execute(sql.raw(`create trigger tester_fail_users before update on users for each row execute function tester_fail()`));
    try {
      // Sensitivity: without the guard, the error message really carries the title and notes.
      let unguarded = "";
      try {
        await createTask(database, { userId, task: input(), now: new Date() });
      } catch (e) {
        unguarded = `${(e as Error).message} ${String((e as Error).stack)}`;
      }
      expect(unguarded).toContain(MARK);

      const tf = (extra: Record<string, string>) =>
        form({ title: `Title ${MARK}`, notes: `Notes ${MARK}`, priority: "high", due_kind: "datetime", due_date: "2026-07-01", due_time: "09:30", ...extra });
      const cases: [string, () => Promise<unknown>][] = [
        ["createTaskAction", () => actions.createTaskAction(tf({}))],
        ["createTaskFromThreadAction", () => actions.createTaskFromThreadAction(tf({ threadId: t.id }))],
        ["updateTaskAction", () => actions.updateTaskAction(tf({ taskId: open }))],
        ["completeTaskAction", () => actions.completeTaskAction(form({ taskId: open }))],
        ["reopenTaskAction", () => actions.reopenTaskAction(form({ taskId: done }))],
        ["acceptSuggestionAction", () => actions.acceptSuggestionAction(form({ taskId: sugg }))],
        ["dismissSuggestionAction", () => actions.dismissSuggestionAction(form({ taskId: sugg }))],
        ["deleteTaskAction", () => actions.deleteTaskAction(form({ taskId: open, confirm: "yes" }))],
        ["setTimeZoneAction", () => settingsActions.setTimeZoneAction(form({ zone: "Asia/Tokyo" }))],
      ];
      for (const [name, run] of cases) {
        const logged: unknown[][] = [];
        const spies = (["error", "warn", "log", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a)));
        let thrown: unknown;
        try {
          await run();
        } catch (e) {
          thrown = e;
        } finally {
          for (const s of spies) s.mockRestore();
        }
        expect((thrown as Error)?.name, name).toBe("TaskActionError");
        expect((thrown as Error).cause, name).toBeUndefined();
        const all = `${(thrown as Error).message} ${String((thrown as Error).stack)} ${JSON.stringify(logged)}`;
        expect(all, name).not.toContain(MARK);
        expect(all, name).not.toContain("Asia/Tokyo");
        expect(all, name).not.toContain("tester forced failure");
        expect(logged, name).toHaveLength(1);
        expect(logged[0]![1], name).toEqual({ action: expect.any(String), error: expect.stringMatching(/^[A-Za-z]+$/), code: "P0001" });
      }
    } finally {
      await database.execute(sql.raw(`drop trigger if exists tester_fail_tasks on tasks`));
      await database.execute(sql.raw(`drop trigger if exists tester_fail_users on users`));
      await database.execute(sql.raw(`drop function if exists tester_fail()`));
    }
    expect(await audits()).toEqual([]);
  });

  // ---- Races on a 12-connection pool, with tallies ----------------------------------------------

  it("double clicks: two concurrent Complete (and Delete, and Reopen) calls give exactly one success and one audit row", async () => {
    const tally: Record<string, number> = {};
    for (let round = 0; round < 25; round++) {
      const id = await raw({ title: `r${round}` });
      const r = await Promise.all([completeTask(poolDb, userId, id, new Date()), completeTask(poolDb, userId, id, new Date())]);
      expect(r.filter((x) => x.ok)).toHaveLength(1);
      const d = await Promise.all([deleteTask(poolDb, userId, id), deleteTask(poolDb, userId, id)]);
      expect(d.filter((x) => x.ok)).toHaveLength(1);
    }
    for (const a of await audits()) tally[a.action] = (tally[a.action] ?? 0) + 1;
    expect(tally).toEqual({ "task.completed": 25, "task.deleted": 25 });
  });

  it("complete vs delete vs update on the same task, staggered: no errors, and every success has exactly one audit row", async () => {
    const tally: Record<string, number> = {};
    for (let round = 0; round < 30; round++) {
      const id = await raw({ title: `s${round}` });
      const out = await Promise.all([
        (async () => (await sleep(round % 3), `c:${(await completeTask(poolDb, userId, id, new Date())).ok}`))(),
        (async () => (await sleep(round % 4), `d:${(await deleteTask(poolDb, userId, id)).ok}`))(),
        (async () => (await sleep(round % 5), `u:${(await updateTask(poolDb, { userId, taskId: id, task: input({ priority: "high" }), now: new Date() })).ok}`))(),
      ].map((p) => p.catch((e: unknown) => `error:${pgCode(e)}`)));
      for (const o of out) tally[o] = (tally[o] ?? 0) + 1;
    }
    scratch(`complete/delete/update tally ${JSON.stringify(tally)}`);
    expect(Object.keys(tally).filter((k) => k.startsWith("error"))).toEqual([]);
    const counts: Record<string, number> = {};
    for (const a of await audits()) counts[a.action] = (counts[a.action] ?? 0) + 1;
    expect(counts["task.completed"] ?? 0).toBe(tally["c:true"] ?? 0);
    expect(counts["task.deleted"] ?? 0).toBe(tally["d:true"] ?? 0);
    expect(counts["task.updated"] ?? 0).toBe(tally["u:true"] ?? 0);
    expect(tally["d:true"]).toBe(30);
  });

  it.each(["disconnect", "gmail-delete"] as const)(
    "createTask from a thread vs %s, staggered both ways: never an error, links match what still exists, audit 'linked' matches the row",
    { timeout: 240_000 },
    async (kind) => {
      const tally: Record<string, number> = {};
      for (let round = 0; round < 40; round++) {
        const acc = await makeGoogleAccount(database, userId, { email: `race-${kind}-${round}@example.com` });
        const { thread: t, gmailMessageId } = await thread(acc);
        const [c, g] = await Promise.all([
          (async () => {
            await sleep(round % 2 === 0 ? (round % 12) * 2 : 0);
            const r = await createTask(poolDb, { userId, task: input(), threadId: t.id, now: new Date() });
            return r.ok ? (r.linked ? "linked" : "unlinked") : r.error;
          })().catch((e: unknown) => `error:${pgCode(e)}`),
          (async () => {
            await sleep(round % 2 === 1 ? (round % 12) * 2 : 0);
            if (kind === "disconnect") await deleteAccount(poolDb, userId, acc.id, { attempts: 1 });
            else await deleteStoredMessage(poolDb, acc.id, gmailMessageId);
            return "gone";
          })().catch((e: unknown) => `error:${pgCode(e)}`),
        ]);
        tally[c] = (tally[c] ?? 0) + 1;
        expect(g, `round ${round}`).toBe("gone");
        expect(c.startsWith("error"), `round ${round}: ${c}`).toBe(false);
      }
      scratch(`create vs ${kind} tally ${JSON.stringify(tally)}`);
      // Every task left has no dangling link, and its audit's "linked" flag matches its creation.
      const rows = await database.select().from(schema.tasks).where(eq(schema.tasks.userId, userId));
      for (const r of rows) {
        expect(r.sourceThreadId).toBeNull();
        if (kind === "disconnect") expect(r.sourceAccountId).toBeNull();
      }
      const created = (await audits()).filter((a) => a.action === "task.created");
      expect(created).toHaveLength((tally.linked ?? 0) + (tally.unlinked ?? 0));
      expect(created.filter((a) => (a.detail as { linked: boolean }).linked)).toHaveLength(tally.linked ?? 0);
      expect(created.every((a) => a.accountId === null)).toBe(true);
      // Both orders really happened (else the race wasn't exercised).
      expect(tally.linked ?? 0, JSON.stringify(tally)).toBeGreaterThan(0);
      expect((tally.unlinked ?? 0) + (tally.thread_not_found ?? 0), JSON.stringify(tally)).toBeGreaterThan(0);
    },
  );

  it("two concurrent identical time-zone saves write one change and one audit row", async () => {
    for (let round = 0; round < 10; round++) {
      const zone = round % 2 === 0 ? "Asia/Tokyo" : "Europe/Paris";
      const r = await Promise.all([setTimeZone(poolDb, userId, zone), setTimeZone(poolDb, userId, zone)]);
      expect(r.filter(Boolean)).toHaveLength(1);
    }
    expect((await audits()).filter((a) => a.action === "settings.time_zone_changed")).toHaveLength(10);
    expect((await audits()).every((a) => JSON.stringify(a.detail) === "{}")).toBe(true);
  });

  it("the users.time_zone check refuses 65 characters even if the action were bypassed; normalizeTimeZone never returns more than 64", async () => {
    await expect(setTimeZone(database, userId, "A".repeat(65))).rejects.toSatisfy((e: unknown) => pgCode(e) === "23514");
    expect(T.normalizeTimeZone(`Etc/${"A".repeat(61)}`)).toBeNull();
    const [u] = await database.select().from(schema.users).where(and(eq(schema.users.id, userId)));
    expect(u!.timeZone).toBeNull();
  });
});
