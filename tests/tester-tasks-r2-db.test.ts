import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester additions for phase-t-tasks round 2 (SF1, SF2), Postgres only (TEST_DATABASE_URL).
// Through the REAL actions and a real database:
// - SF1: every deadline-kind mismatch on all three forms (new task, edit, Add task from a thread)
//   is refused with due_kind_mismatch, and nothing is written to tasks or audit_log;
// - SF1 on the edit page (rewritten for round 3): the form exactly as the real page renders it,
//   with None/Date picked and the pre-filled date/time left, saves; changed values are refused,
//   and the create and thread forms stay strict;
// - SF2: U+2028/U+2029 and invisible-only titles are refused on every form; nothing is written.
// Characters outside ASCII are built with String.fromCodePoint so no tool can rewrite them.

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
vi.mock("@/app/(app)/inbox/[threadId]/message-body", () => ({ MessageBody: () => null }));
vi.mock("@/app/(app)/inbox/[threadId]/ai-panel", () => ({ AiPanel: () => null }));

const cp = (...c: number[]) => String.fromCodePoint(...c);
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
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The value attribute of the first <input> whose name is `name` in `html`. */
function inputValue(html: string, name: string): string | null {
  const tag = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0];
  if (!tag) return null;
  const v = /value="([^"]*)"/.exec(tag);
  return v ? unescape(v[1]!) : "";
}
function checkedKind(html: string): string | null {
  for (const tag of html.match(/<input[^>]*name="due_kind"[^>]*>/g) ?? []) if (/checked=""/.test(tag)) return /value="([^"]*)"/.exec(tag)![1]!;
  return null;
}

describe.skipIf(!testDbUrl)("Phase T tester round 2 (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
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
    account = await makeGoogleAccount(database, userId, { email: "work@example.com" });
    await database.update(schema.users).set({ timeZone: "America/New_York" }).where(eq(schema.users.id, userId));
    state.db = database;
    state.user = (await database.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
  });

  let seq = 0;
  async function thread() {
    seq++;
    const [t] = await database
      .insert(schema.mailThreads)
      .values({ userId, accountId: account.id, gmailThreadId: `r2-${seq}-${Math.random()}`, subject: "Invoice due", lastMessageAt: new Date(), messageCount: 1, inInbox: true, hasUnread: false })
      .returning();
    return t!;
  }
  async function raw(over: Partial<typeof schema.tasks.$inferInsert>) {
    const [r] = await database.insert(schema.tasks).values({ userId, title: "Pay invoice", source: "manual", status: "open", ...over }).returning({ id: schema.tasks.id });
    return r!.id;
  }
  /** Everything a refusal must leave alone. */
  const snapshot = async () => ({
    tasks: await database.execute(sql`select * from tasks order by id`),
    audits: Number((await database.execute(sql`select count(*)::int as n from audit_log`))[0]!.n),
  });
  const render = async (id: string) => renderToStaticMarkup((await TaskPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as never);

  const MISMATCHES: [string, Record<string, string>][] = [
    ["none + date", { due_kind: "none", due_date: "2026-12-01", due_time: "" }],
    ["none + time", { due_kind: "none", due_date: "", due_time: "09:00" }],
    ["none + date + time", { due_kind: "none", due_date: "2026-12-01", due_time: "09:00" }],
    ["none + garbage date", { due_kind: "none", due_date: "garbage", due_time: "" }],
    ["no due_kind field + date", { due_date: "2026-12-01", due_time: "" }],
    ["date + date + time", { due_kind: "date", due_date: "2026-12-01", due_time: "09:00" }],
    ["date + no date + time", { due_kind: "date", due_date: "", due_time: "09:00" }],
    ["date + bad date + time", { due_kind: "date", due_date: "2026-02-30", due_time: "09:00" }],
    ["none + padded date", { due_kind: "none", due_date: "  2026-12-01 ", due_time: "  " }],
    ["none + ZWSP time (not whitespace)", { due_kind: "none", due_date: "", due_time: cp(0x200b) }],
  ];

  it("SF1: each mismatch is refused on all three forms, and nothing is written or audited", async () => {
    const th = await thread();
    const existing = await raw({ dueDate: "2026-11-30" });
    let checked = 0;
    for (const [label, due] of MISMATCHES) {
      const before = await snapshot();
      const base = { title: "Pay invoice", notes: "", priority: "normal", ...due };
      expect(await redirectOf(actions.createTaskAction(form(base))), label).toBe("/tasks?error=due_kind_mismatch");
      expect(await redirectOf(actions.updateTaskAction(form({ ...base, taskId: existing }))), label).toBe(`/tasks/${existing}?error=due_kind_mismatch`);
      expect(await redirectOf(actions.createTaskFromThreadAction(form({ ...base, threadId: th.id }))), label).toBe(
        `/inbox/${th.id}?task=1&task_error=due_kind_mismatch#task`,
      );
      expect(await snapshot(), label).toEqual(before);
      checked++;
    }
    expect(checked).toBe(MISMATCHES.length);
    expect((await database.select().from(schema.tasks)).length).toBe(1);
  });

  it("SF1: matching forms still save, whitespace-only fields count as empty, and the kind is never guessed", async () => {
    const ok = async (due: Record<string, string>) => {
      expect(await redirectOf(actions.createTaskAction(form({ title: "A", notes: "", priority: "normal", ...due })))).toBe("/tasks?notice=saved");
      const rows = await database.select().from(schema.tasks).orderBy(sql`created_at desc, id`);
      return rows[0]!;
    };
    const ws = cp(0x20, 0x09, 0xa0, 0x3000);
    let r = await ok({ due_kind: "none", due_date: ws, due_time: ws });
    expect([r.dueDate, r.dueAt, r.dueTz]).toEqual([null, null, null]);
    r = await ok({ due_kind: "date", due_date: "2026-12-01", due_time: ws });
    expect([r.dueDate, r.dueAt, r.dueTz]).toEqual(["2026-12-01", null, null]);
    r = await ok({ due_kind: "datetime", due_date: "2026-12-01", due_time: "09:00" });
    expect([r.dueDate, r.dueAt?.toISOString(), r.dueTz]).toEqual([null, "2026-12-01T14:00:00.000Z", "America/New_York"]);
    // datetime with a missing part is the old date/time error, not a mismatch (and not a guess)
    expect(await redirectOf(actions.createTaskAction(form({ title: "A", due_kind: "datetime", due_date: "", due_time: "09:00" })))).toBe("/tasks?error=date_invalid");
    expect(await redirectOf(actions.createTaskAction(form({ title: "A", due_kind: "datetime", due_date: "2026-12-01", due_time: "" })))).toBe("/tasks?error=time_invalid");
    expect((await database.select().from(schema.tasks)).length).toBe(3);
  });

  // Round 3 (01a-approval.md Round 3) replaced the round-2 pin "the rendered pre-filled form with only
  // the radio changed is refused": on the edit form only, leftovers equal to what the page rendered
  // for the stored deadline don't count, while any changed value is still refused, and the new-task
  // and Add-task-from-thread forms stay strict.
  it("SF1 + round 3 on the edit page: rendered pre-filled leftovers are accepted for None/Date, changed values are refused, create and thread stay strict", async () => {
    const dt = await raw({ dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: "America/New_York" });
    const html = await render(dt);
    expect(checkedKind(html)).toBe("datetime");
    const date = inputValue(html, "due_date");
    const time = inputValue(html, "due_time");
    const title = inputValue(html, "title");
    expect([date, time, title]).toEqual(["2026-12-01", "09:00", "Pay invoice"]);
    const submit = (over: Record<string, string>) =>
      redirectOf(actions.updateTaskAction(form({ taskId: dt, title: title!, notes: "", priority: "normal", due_kind: "datetime", due_date: date!, due_time: time!, ...over })));

    // Changed leftovers are still refused, with nothing written.
    let before = await snapshot();
    for (const over of <Record<string, string>[]>[
      { due_kind: "none", due_date: "2026-12-02" },
      { due_kind: "none", due_time: "09:01" },
      { due_kind: "none", due_date: "", due_time: "10:00" },
      { due_kind: "date", due_time: "09:30" },
      { due_kind: "date", due_date: "2026-12-02" }, // changed date with the pre-filled time left in place
      { due_kind: "none", due_time: "14:00" }, // the UTC wall time, not what the page showed
      { due_kind: "none", due_date: "2026-12-01", due_time: "9:00" },
      { due_kind: "none", due_time: "09:00:00" },
      { due_kind: "none", title: "Pay invoice today", due_time: "08:00" },
    ]) expect(await submit(over), JSON.stringify(over)).toBe(`/tasks/${dt}?error=due_kind_mismatch`);
    expect(await snapshot()).toEqual(before);

    // The same pre-filled values on the new-task and thread forms are still refused.
    const th = await thread();
    const strict = { title: "New", notes: "", priority: "normal", due_kind: "none", due_date: date!, due_time: time! };
    expect(await redirectOf(actions.createTaskAction(form(strict)))).toBe("/tasks?error=due_kind_mismatch");
    expect(await redirectOf(actions.createTaskAction(form({ ...strict, due_kind: "date" })))).toBe("/tasks?error=due_kind_mismatch");
    expect(await redirectOf(actions.createTaskFromThreadAction(form({ ...strict, threadId: th.id })))).toBe(`/inbox/${th.id}?task=1&task_error=due_kind_mismatch#task`);
    expect(await redirectOf(actions.createTaskFromThreadAction(form({ ...strict, due_kind: "date", threadId: th.id })))).toBe(`/inbox/${th.id}?task=1&task_error=due_kind_mismatch#task`);
    expect(await snapshot()).toEqual(before);

    // Date with the rendered values untouched: the shown date is kept, the time dropped.
    expect(await submit({ due_kind: "date" })).toBe(`/tasks/${dt}?notice=saved`);
    let row = (await database.select().from(schema.tasks).where(eq(schema.tasks.id, dt)))[0]!;
    expect([row.dueDate, row.dueAt, row.dueTz]).toEqual(["2026-12-01", null, null]);

    // Now date-only: a typed time with None is refused (an empty pre-filled time never matches).
    const html2 = await render(dt);
    expect([checkedKind(html2), inputValue(html2, "due_date"), inputValue(html2, "due_time")]).toEqual(["date", "2026-12-01", ""]);
    before = await snapshot();
    expect(await submit({ due_kind: "none", due_date: "2026-12-01", due_time: "09:00" })).toBe(`/tasks/${dt}?error=due_kind_mismatch`);
    expect(await submit({ due_kind: "date", due_date: "2026-12-01", due_time: "09:00" })).toBe(`/tasks/${dt}?error=due_kind_mismatch`);
    expect(await snapshot()).toEqual(before);
    // None with its pre-filled date left (padded, as trimming applies) and a title change: both saved.
    expect(await submit({ due_kind: "none", due_date: ` ${inputValue(html2, "due_date")!} `, due_time: "", title: "Pay invoice today" })).toBe(`/tasks/${dt}?notice=saved`);
    row = (await database.select().from(schema.tasks).where(eq(schema.tasks.id, dt)))[0]!;
    expect([row.title, row.dueDate, row.dueAt, row.dueTz]).toEqual(["Pay invoice today", null, null, null]);
    const updates = await database.select().from(schema.auditLog).where(eq(schema.auditLog.action, "task.updated"));
    expect(updates.map((a) => a.detail)).toEqual([
      { taskId: dt, fields: ["due"] },
      { taskId: dt, fields: ["title", "due"] },
    ]);

    // No deadline: typed values with None or Date are refused; the unchanged resubmit writes nothing.
    const html3 = await render(dt);
    expect([checkedKind(html3), inputValue(html3, "due_date"), inputValue(html3, "due_time")]).toEqual(["none", "", ""]);
    before = await snapshot();
    expect(await submit({ title: "Pay invoice today", due_kind: "none", due_date: "2026-12-01", due_time: "" })).toBe(`/tasks/${dt}?error=due_kind_mismatch`);
    expect(await submit({ title: "Pay invoice today", due_kind: "date", due_date: "2026-12-01", due_time: "09:00" })).toBe(`/tasks/${dt}?error=due_kind_mismatch`);
    expect(await snapshot()).toEqual(before);
    expect(await submit({ title: "Pay invoice today", due_kind: "none", due_date: "", due_time: "" })).toBe(`/tasks/${dt}?notice=saved`);
    expect((await snapshot()).audits).toBe(before.audits);
  });

  it("SF2: U+2028/U+2029 and invisible-only titles are refused on all three forms; nothing is written", async () => {
    const th = await thread();
    const existing = await raw({});
    const cases: [string, string][] = [
      [cp(0x2028), "title_invalid"],
      [`Pay${cp(0x2028)}invoice`, "title_invalid"],
      [`Pay invoice${cp(0x2029)}`, "title_invalid"],
      [`${cp(0x2029)}Pay`, "title_invalid"],
      [cp(0x200b), "title_empty"],
      [cp(0x200d), "title_empty"],
      [cp(0xfeff, 0x20, 0x200c, 0x3000, 0x2060), "title_empty"],
      [cp(0x180e), "title_empty"],
      [cp(0xe0041, 0xe0042, 0xe007f), "title_empty"],
      [cp(0x200b).repeat(600), "title_empty"],
    ];
    for (const [title, code] of cases) {
      const before = await snapshot();
      const base = { title, notes: "", priority: "normal", due_kind: "none", due_date: "", due_time: "" };
      const label = JSON.stringify(title.slice(0, 8));
      expect(await redirectOf(actions.createTaskAction(form(base))), label).toBe(`/tasks?error=${code}`);
      expect(await redirectOf(actions.updateTaskAction(form({ ...base, taskId: existing }))), label).toBe(`/tasks/${existing}?error=${code}`);
      expect(await redirectOf(actions.createTaskFromThreadAction(form({ ...base, threadId: th.id }))), label).toBe(`/inbox/${th.id}?task=1&task_error=${code}#task`);
      expect(await snapshot(), label).toEqual(before);
    }
  });

  it("the thread page and the edit page show the new refusal messages by code", async () => {
    const th = await thread();
    await database.insert(schema.mailMessages).values({
      userId,
      accountId: account.id,
      threadId: th.id,
      gmailMessageId: `r2m-${Math.random()}`,
      gmailThreadId: th.gmailThreadId,
      internalDate: new Date(),
      labelIds: ["INBOX"],
      isSent: false,
      subject: "Invoice due",
      headers: [],
      bodyText: "Hello",
    });
    const ThreadPage = ((await import("@/app/(app)/inbox/[threadId]/page")) as unknown as {
      default: (p: { params: Promise<{ threadId: string }>; searchParams: Promise<Record<string, string>> }) => Promise<ReactNode>;
    }).default;
    const id = await raw({});
    for (const [code, text] of [
      ["due_kind_mismatch", "The deadline choice doesn't match the fields filled in."],
      ["title_empty", "The task needs a title. Nothing was saved."],
      ["title_invalid", "line breaks"],
    ] as const) {
      const t = unescape(renderToStaticMarkup((await ThreadPage({ params: Promise.resolve({ threadId: th.id }), searchParams: Promise.resolve({ task: "1", task_error: code }) })) as never));
      expect(t, code).toContain(text);
      const e = unescape(renderToStaticMarkup((await TaskPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ error: code }) })) as never));
      expect(e, code).toContain(text);
    }
  });

  it("SF2: emoji with ZWJ, tag-sequence flags and keycaps are accepted and stored unchanged", async () => {
    const titles = [
      cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), // family (ZWJ)
      cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f), // England flag (tag characters)
      cp(0x31, 0xfe0f, 0x20e3), // keycap 1
      `Call ${cp(0x1f469, 0x200d, 0x1f4bb)} re: launch`,
    ];
    for (const title of titles) {
      expect(await redirectOf(actions.createTaskAction(form({ title, notes: "", priority: "normal", due_kind: "none" })))).toBe("/tasks?notice=saved");
    }
    const stored = (await database.select({ t: schema.tasks.title }).from(schema.tasks)).map((r) => r.t).sort();
    expect(stored).toEqual([...titles].sort());
  });
});
