import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { makeUser, openTestDb, testDbUrl } from "./test-db";

// Phase T round 3 (coder), Postgres only (TEST_DATABASE_URL). The edit form as the REAL edit page
// renders it, submitted to the REAL updateTaskAction: None or Date with the pre-filled date/time
// left in place is accepted (None removes the deadline, Date keeps the shown date), other edits in
// the same submit are saved, and a changed leftover is still refused with nothing written.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));

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
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://alex.example.com" }) }));
vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<object>()),
  env: () => ({ GOOGLE_OAUTH_TESTING_MODE: true, APP_URL: "https://alex.example.com/" }),
}));

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
function inputValue(html: string, name: string): string {
  const tag = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0];
  if (!tag) throw new Error(`no input ${name}`);
  return /value="([^"]*)"/.exec(tag)?.[1] ?? "";
}

describe.skipIf(!testDbUrl)("edit form leftovers (round 3, Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let actions: typeof import("@/app/(app)/tasks/actions");
  let TaskPage: (p: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) => Promise<ReactNode>;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    actions = await import("@/app/(app)/tasks/actions");
    TaskPage = ((await import("@/app/(app)/tasks/[id]/page")) as unknown as { default: typeof TaskPage }).default;
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    await database.update(schema.users).set({ timeZone: "Europe/London" }).where(eq(schema.users.id, userId));
    state.db = database;
    state.user = (await database.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
  });

  async function raw(over: Partial<typeof schema.tasks.$inferInsert>) {
    const [r] = await database.insert(schema.tasks).values({ userId, title: "Pay invoice", source: "manual", status: "open", ...over }).returning({ id: schema.tasks.id });
    return r!.id;
  }
  const row = async (id: string) => (await database.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!;
  const snapshot = async () => ({
    tasks: await database.execute(sql`select * from tasks order by id`),
    audits: Number((await database.execute(sql`select count(*)::int as n from audit_log`))[0]!.n),
  });
  /** The rendered form's fields, then a submit with some of them overridden. */
  async function rendered(id: string) {
    const html = renderToStaticMarkup((await TaskPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as never);
    const base = { taskId: id, title: inputValue(html, "title"), notes: "", priority: "normal", due_date: inputValue(html, "due_date"), due_time: inputValue(html, "due_time") };
    return { html, base, submit: (over: Record<string, string>) => redirectOf(actions.updateTaskAction(form({ ...base, ...over }))) };
  }

  it("None with the pre-filled date and time removes a date-time deadline and saves the other edits", async () => {
    const id = await raw({ dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: "America/New_York" });
    const { html, base, submit } = await rendered(id);
    expect([base.due_date, base.due_time]).toEqual(["2026-12-01", "09:00"]);
    expect(html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'")).toContain(
      "Time zone: America/New_York (this task's zone; to use Europe/London, choose None and save, then enter the deadline again)",
    );
    expect(await submit({ due_kind: "none", title: "Pay invoice today", priority: "high" })).toBe(`/tasks/${id}?notice=saved`);
    const r = await row(id);
    expect([r.title, r.priority, r.dueDate, r.dueAt, r.dueTz]).toEqual(["Pay invoice today", "high", null, null, null]);
    const audits = await database.select().from(schema.auditLog).where(eq(schema.auditLog.action, "task.updated"));
    expect(audits.map((a) => a.detail)).toEqual([{ taskId: id, fields: ["title", "due", "priority"] }]);
  });

  it("a changed date or time with None, or with Date, is still refused and nothing is written", async () => {
    const id = await raw({ dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: "America/New_York" });
    const { submit } = await rendered(id);
    const before = await snapshot();
    for (const over of <Record<string, string>[]>[
      { due_kind: "none", due_date: "2026-12-02" },
      { due_kind: "none", due_time: "09:30" },
      { due_kind: "none", due_time: "14:00" },
      { due_kind: "date", due_date: "2026-12-02" },
      { due_kind: "date", due_time: "10:00" },
      { due_kind: "none", due_date: "2026-12-02", title: "Renamed" },
    ]) {
      expect(await submit(over), JSON.stringify(over)).toBe(`/tasks/${id}?error=due_kind_mismatch`);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("Date on a date-time task keeps the date the page showed (in due_tz) and drops the time", async () => {
    // 03:30 UTC on Dec 1 is 22:30 on Nov 30 in New York: the shown date is Nov 30.
    const id = await raw({ dueAt: new Date("2026-12-01T03:30:00Z"), dueTz: "America/New_York" });
    const { base, submit } = await rendered(id);
    expect([base.due_date, base.due_time]).toEqual(["2026-11-30", "22:30"]);
    expect(await submit({ due_kind: "date" })).toBe(`/tasks/${id}?notice=saved`);
    const r = await row(id);
    expect([r.dueDate, r.dueAt, r.dueTz]).toEqual(["2026-11-30", null, null]);
    // Then None with that date left in place removes it.
    const again = await rendered(id);
    expect([again.base.due_date, again.base.due_time]).toEqual(["2026-11-30", ""]);
    expect(await again.submit({ due_kind: "none" })).toBe(`/tasks/${id}?notice=saved`);
    expect([(await row(id)).dueDate, (await row(id)).dueAt]).toEqual([null, null]);
  });

  it("a stored due_tz the runtime doesn't know: the leftovers compared are the owner-zone values the page showed", async () => {
    const id = await raw({ dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: "Mars/Olympus" });
    const { base, submit } = await rendered(id);
    // Shown in the owner's zone (Europe/London, UTC+0 in December).
    expect([base.due_date, base.due_time]).toEqual(["2026-12-01", "14:00"]);
    const before = await snapshot();
    expect(await submit({ due_kind: "none", due_time: "09:00" })).toBe(`/tasks/${id}?error=due_kind_mismatch`);
    expect(await snapshot()).toEqual(before);
    expect(await submit({ due_kind: "none" })).toBe(`/tasks/${id}?notice=saved`);
    const r = await row(id);
    expect([r.dueDate, r.dueAt, r.dueTz]).toEqual([null, null, null]);
  });

  it("new task and Add task from a thread stay strict", async () => {
    const before = await snapshot();
    const due = { due_kind: "none", due_date: "2026-12-01", due_time: "09:00" };
    expect(await redirectOf(actions.createTaskAction(form({ title: "A", notes: "", priority: "normal", ...due })))).toBe("/tasks?error=due_kind_mismatch");
    const threadId = "00000000-0000-4000-8000-0000000000c3";
    expect(await redirectOf(actions.createTaskFromThreadAction(form({ title: "A", notes: "", priority: "normal", threadId, ...due })))).toBe(
      `/inbox/${threadId}?task=1&task_error=due_kind_mismatch#task`,
    );
    expect(await snapshot()).toEqual(before);
  });
});
