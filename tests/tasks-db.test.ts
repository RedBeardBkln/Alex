import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./setup-env";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { deleteAccount } from "@/lib/accounts";
import { deleteStoredMessage } from "@/lib/gmail/store";
import { setTimeZone } from "@/lib/settings";
import {
  ACTIVE_LIMIT,
  acceptSuggestion,
  completeTask,
  countDueForNav,
  createTask,
  deleteTask,
  dismissSuggestion,
  getTaskForEdit,
  listDoneTasks,
  listTasks,
  reopenTask,
  updateTask,
} from "@/lib/tasks/service";
import { classifyDeadline, startOfLocalDay, zonedToInstant } from "@/lib/tasks/time";
import type { TaskInput } from "@/lib/tasks/validate";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Phase T (coder), Postgres only (TEST_DATABASE_URL, a disposable local database): the migration's
// checks and indexes (AC-M-1/2), SET NULL and cascade (AC-M-3), CRUD, transitions and audit
// (AC-T-1, AC-A-1/2), user scoping (AC-V-6), the counts against the classifier (AC-V-3/4/5),
// creation from a thread (AC-E-1..4), the read functions' parameters (AC-L-2), and the Disconnect
// and Gmail-delete races on a separate connection pool (AC-E-3, AC-DB-2).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pgCode = (err: unknown): string => {
  const e = err as { cause?: { code?: string }; code?: string };
  return e?.cause?.code ?? e?.code ?? (err instanceof Error ? err.name : "?");
};
const T0 = new Date("2026-06-10T16:00:00Z");
const MARK = "UNIQUE-MARKER-71c3";

const input = (over: Partial<TaskInput> = {}): TaskInput => ({ title: `Title ${MARK}`, notes: `Notes ${MARK}`, priority: "normal", due: { kind: "none" }, ...over });

/** Pauses a transaction right before its first insert into one of `tables` (see followups-db). */
function pauseBeforeFirstInsert(base: Database, tables: unknown[]) {
  let hit = false;
  let onPaused!: () => void;
  const paused = new Promise<void>((r) => (onPaused = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const wrap = (b: object): object => {
    const proxy: object = new Proxy(b, {
      get(t, p) {
        if (p === "then") {
          const then = (t as PromiseLike<unknown>).then.bind(t);
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            (async () => {
              onPaused();
              await released;
            })().then(() => then(res, rej), rej);
        }
        const v = Reflect.get(t, p, t);
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          const out = (v as (...x: unknown[]) => unknown).apply(t, a);
          if (out === t) return proxy;
          return out && typeof out === "object" ? wrap(out) : out;
        };
      },
    });
    return proxy;
  };
  const wrapTx = (tx: object): object =>
    new Proxy(tx, {
      get(t, p) {
        const v = Reflect.get(t, p, t);
        if (p === "insert")
          return (table: unknown) => {
            const b = (v as (x: unknown) => object).call(t, table);
            if (!hit && tables.includes(table)) {
              hit = true;
              return wrap(b);
            }
            return b;
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  const db = new Proxy(base, {
    get(t, p) {
      if (p === "transaction") return (fn: (tx: unknown) => Promise<unknown>, cfg?: unknown) => (t.transaction as (f: unknown, c?: unknown) => Promise<unknown>)((tx: object) => fn(wrapTx(tx)), cfg);
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Database;
  return { db, paused, release, hit: () => hit };
}

describe.skipIf(!testDbUrl)("Phase T tasks (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;
  let userId: string;
  let account: ConnectedAccount;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    pool = postgres(testDbUrl!, { max: 8, onnotice: () => {} });
    poolDb = drizzle(pool, { schema }) as unknown as Database;
  });
  afterAll(async () => {
    await pool.end();
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    account = await makeGoogleAccount(database, userId, { email: "work@example.com" });
  });

  let seq = 0;
  /** A stored thread with one INBOX message, inserted directly. */
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
  const taskRow = async (id: string) => (await database.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0];
  const audits = async () =>
    database
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.action} like 'task.%' or ${schema.auditLog.action} like 'settings.%'`)
      .orderBy(schema.auditLog.createdAt);
  async function made(over: Partial<TaskInput> = {}, ex: Database = database) {
    const r = await createTask(ex, { userId, task: input(over), now: T0 });
    if (!r.ok) throw new Error(r.error);
    return r.taskId;
  }

  // ---- Migration (AC-M-1, AC-M-2) -------------------------------------------------------------------

  it("0005 adds a nullable users.time_zone, the tasks table, its checks and the partial indexes", async () => {
    const cols = await database.execute(sql`select column_name, is_nullable, column_default from information_schema.columns where table_name = 'users' and column_name = 'time_zone'`);
    expect(cols).toEqual([{ column_name: "time_zone", is_nullable: "YES", column_default: null }]);
    const checks = (await database.execute(sql`select conname from pg_constraint where conrelid = 'tasks'::regclass and contype = 'c' order by conname`)).map((r) => r.conname);
    expect(checks).toEqual(["tasks_completed_chk", "tasks_due_shape_chk", "tasks_due_tz_len_chk", "tasks_manual_source_chk", "tasks_notes_len_chk", "tasks_title_len_chk"]);
    const fks = await database.execute(sql`select conname, confdeltype from pg_constraint where conrelid = 'tasks'::regclass and contype = 'f' order by conname`);
    expect(fks.map((r) => [r.conname, r.confdeltype])).toEqual([
      ["tasks_source_account_id_connected_accounts_id_fk", "n"],
      ["tasks_source_thread_id_mail_threads_id_fk", "n"],
      ["tasks_user_id_users_id_fk", "c"],
    ]);
    const idx = await database.execute(sql`select indexname, indexdef from pg_indexes where tablename = 'tasks' order by indexname`);
    const byName = Object.fromEntries(idx.map((r) => [r.indexname as string, r.indexdef as string]));
    expect(Object.keys(byName).sort()).toEqual(
      ["tasks_done_idx", "tasks_open_due_at_idx", "tasks_open_due_date_idx", "tasks_pkey", "tasks_source_account_idx", "tasks_source_thread_idx", "tasks_user_status_idx"].sort(),
    );
    expect(byName.tasks_open_due_date_idx).toMatch(/WHERE \(\(status = 'open'::task_status\) AND \(due_date IS NOT NULL\)\)/);
    expect(byName.tasks_open_due_at_idx).toMatch(/WHERE \(\(status = 'open'::task_status\) AND \(due_at IS NOT NULL\)\)/);
    expect(byName.tasks_done_idx).toMatch(/WHERE \(status = 'done'::task_status\)/);
  });

  it("the database refuses malformed rows with 23514", async () => {
    const { thread: t } = await thread();
    const base = { userId, title: "x", source: "manual" as const };
    const bad: [string, Partial<typeof schema.tasks.$inferInsert>][] = [
      ["both deadlines", { dueDate: "2026-01-01", dueAt: new Date(), dueTz: "UTC" }],
      ["due_at without due_tz", { dueAt: new Date() }],
      ["due_tz without due_at", { dueTz: "UTC" }],
      ["done without completed_at", { status: "done" }],
      ["completed_at while open", { completedAt: new Date() }],
      ["manual with a thread", { sourceThreadId: t.id }],
      ["manual with an account", { sourceAccountId: account.id }],
      ["empty title", { title: "" }],
      ["501-character title", { title: "x".repeat(501) }],
      ["20,001-character notes", { notes: "n".repeat(20_001) }],
      ["65-character due_tz", { dueAt: new Date(), dueTz: "z".repeat(65) }],
    ];
    for (const [name, over] of bad) {
      const err = await database.insert(schema.tasks).values({ ...base, ...over }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(pgCode(err), name).toBe("23514");
    }
    const tz = await database.update(schema.users).set({ timeZone: "z".repeat(65) }).where(eq(schema.users.id, userId)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(pgCode(tz)).toBe("23514");
    // The boundaries are allowed.
    await database.insert(schema.tasks).values({ ...base, title: "x".repeat(500), notes: "n".repeat(20_000) });
    await database.insert(schema.tasks).values({ ...base, source: "email", status: "done", completedAt: new Date() });
  });

  // ---- Create, update, transitions, audit -----------------------------------------------------------

  it("creates manual tasks; a date-only deadline round-trips as the same YYYY-MM-DD string; audit is content-free", async () => {
    const a = await made({ due: { kind: "date", date: "2026-03-08" }, priority: "high" });
    const at = zonedToInstant("2026-03-10", "09:00", "America/New_York");
    const b = await made({ due: { kind: "datetime", at: at.ok ? at.instant : new Date(0), tz: "America/New_York" }, notes: null });
    const ra = await taskRow(a);
    expect(ra).toMatchObject({ status: "open", source: "manual", priority: "high", dueDate: "2026-03-08", dueAt: null, dueTz: null, sourceAccountId: null, sourceThreadId: null, completedAt: null });
    expect(typeof ra!.dueDate).toBe("string");
    expect(ra!.createdAt.getTime()).toBe(T0.getTime());
    const rb = await taskRow(b);
    expect(rb!.dueAt!.toISOString()).toBe("2026-03-10T13:00:00.000Z");
    expect(rb!.dueTz).toBe("America/New_York");
    expect(rb!.notes).toBeNull();
    const rows = await audits();
    expect(rows.map((r) => [r.action, r.accountId, r.userId, r.detail])).toEqual([
      ["task.created", null, userId, { taskId: a, source: "manual", due: "date", linked: false }],
      ["task.created", null, userId, { taskId: b, source: "manual", due: "datetime", linked: false }],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${MARK}|2026-03-08|America`));
  });

  it("updateTask writes only real changes, lists the changed fields, and refuses suggested/dismissed tasks", async () => {
    const id = await made();
    expect(await updateTask(database, { userId, taskId: id, task: input(), now: T0 })).toEqual({ ok: true, fields: [] });
    expect((await audits()).filter((r) => r.action === "task.updated")).toEqual([]);
    const later = new Date(T0.getTime() + 60_000);
    const r = await updateTask(database, { userId, taskId: id, task: input({ title: `New ${MARK}`, due: { kind: "date", date: "2026-07-01" } }), now: later });
    expect(r).toEqual({ ok: true, fields: ["title", "due"] });
    expect(await taskRow(id)).toMatchObject({ title: `New ${MARK}`, dueDate: "2026-07-01", updatedAt: later });
    const updated = (await audits()).filter((x) => x.action === "task.updated");
    expect(updated.map((x) => x.detail)).toEqual([{ taskId: id, fields: ["title", "due"] }]);
    expect(JSON.stringify(updated)).not.toContain(MARK);
    // Done tasks can be edited; suggested and dismissed can't.
    await completeTask(database, userId, id, T0);
    expect(await updateTask(database, { userId, taskId: id, task: input({ priority: "low" }), now: T0 })).toMatchObject({ ok: true, fields: ["title", "due", "priority"] });
    for (const status of ["suggested", "dismissed"] as const) {
      const [s] = await database.insert(schema.tasks).values({ userId, title: "s", source: "manual", status }).returning();
      expect(await updateTask(database, { userId, taskId: s!.id, task: input(), now: T0 })).toEqual({ ok: false, error: "not_found_or_stale" });
    }
  });

  it("transitions move only from their source state; a second call is stale with no audit (AC-T-1, AC-A-2)", async () => {
    const id = await made();
    expect(await reopenTask(database, userId, id, T0)).toEqual({ ok: false, error: "not_found_or_stale" });
    expect(await completeTask(database, userId, id, T0)).toEqual({ ok: true });
    expect((await taskRow(id))!.completedAt!.getTime()).toBe(T0.getTime());
    expect(await completeTask(database, userId, id, T0)).toEqual({ ok: false, error: "not_found_or_stale" });
    expect(await reopenTask(database, userId, id, T0)).toEqual({ ok: true });
    expect(await taskRow(id)).toMatchObject({ status: "open", completedAt: null });
    expect(await acceptSuggestion(database, userId, id, T0)).toEqual({ ok: false, error: "not_found_or_stale" });
    const [s] = await database.insert(schema.tasks).values({ userId, title: "suggested", source: "manual", status: "suggested" }).returning();
    const [s2] = await database.insert(schema.tasks).values({ userId, title: "suggested 2", source: "manual", status: "suggested" }).returning();
    expect(await completeTask(database, userId, s!.id, T0)).toEqual({ ok: false, error: "not_found_or_stale" });
    expect(await acceptSuggestion(database, userId, s!.id, T0)).toEqual({ ok: true });
    expect(await acceptSuggestion(database, userId, s!.id, T0)).toEqual({ ok: false, error: "not_found_or_stale" });
    expect(await dismissSuggestion(database, userId, s2!.id, T0)).toEqual({ ok: true });
    expect(await dismissSuggestion(database, userId, s2!.id, T0)).toEqual({ ok: false, error: "not_found_or_stale" });
    expect(await taskRow(s2!.id)).toMatchObject({ status: "dismissed" });
    expect(await deleteTask(database, userId, s2!.id)).toEqual({ ok: true });
    expect(await deleteTask(database, userId, s2!.id)).toEqual({ ok: false, error: "not_found_or_stale" });
    expect(await taskRow(s2!.id)).toBeUndefined();
    const rows = await audits();
    expect(rows.map((r) => [r.action, r.detail])).toEqual([
      ["task.created", { taskId: id, source: "manual", due: "none", linked: false }],
      ["task.completed", { taskId: id }],
      ["task.reopened", { taskId: id }],
      ["task.suggestion_accepted", { taskId: s!.id }],
      ["task.suggestion_dismissed", { taskId: s2!.id }],
      ["task.deleted", { taskId: s2!.id }],
    ]);
    expect(rows.every((r) => r.accountId === null)).toBe(true);
  });

  it("setTimeZone audits settings.time_zone_changed {} only when the value changes", async () => {
    expect(await setTimeZone(database, userId, "Europe/London")).toBe(true);
    expect(await setTimeZone(database, userId, "Europe/London")).toBe(false);
    expect(await setTimeZone(database, userId, "UTC")).toBe(true);
    const rows = await audits();
    expect(rows.map((r) => [r.action, r.accountId, r.detail])).toEqual([
      ["settings.time_zone_changed", null, {}],
      ["settings.time_zone_changed", null, {}],
    ]);
    expect((await database.select().from(schema.users).where(eq(schema.users.id, userId)))[0]!.timeZone).toBe("UTC");
  });

  // ---- Scoping (AC-V-6) -----------------------------------------------------------------------------

  it("another user's tasks are never listed, counted, edited, completed or deleted", async () => {
    const other = await makeUser(database, "second@example.com");
    const [theirs] = await database
      .insert(schema.tasks)
      .values({ userId: other.id, title: "theirs", source: "manual", dueDate: "2026-06-01" })
      .returning();
    const id = theirs!.id;
    expect((await listTasks(database, userId, T0, "UTC")).groups.overdue).toEqual([]);
    expect(await countDueForNav(database, userId, T0, "UTC")).toEqual({ overdue: 0, today: 0 });
    expect(await getTaskForEdit(database, userId, id)).toBeNull();
    expect(await updateTask(database, { userId, taskId: id, task: input(), now: T0 })).toEqual({ ok: false, error: "not_found_or_stale" });
    for (const fn of [completeTask, reopenTask, acceptSuggestion, dismissSuggestion]) expect(await fn(database, userId, id, T0)).toEqual({ ok: false, error: "not_found_or_stale" });
    expect(await deleteTask(database, userId, id)).toEqual({ ok: false, error: "not_found_or_stale" });
    expect(await taskRow(id)).toMatchObject({ title: "theirs", status: "open" });
    expect(await audits()).toEqual([]);
    // A thread of the other user's can't be linked (AC-E-2).
    const otherAccount = await makeGoogleAccount(database, other.id, { email: "theirs@example.com" });
    const { thread: t } = await thread(otherAccount);
    expect(await createTask(database, { userId, task: input(), threadId: t.id, now: T0 })).toEqual({ ok: false, error: "thread_not_found" });
    expect(await createTask(database, { userId, task: input(), threadId: "00000000-0000-4000-8000-000000000000", now: T0 })).toEqual({ ok: false, error: "thread_not_found" });
    expect(await database.select().from(schema.tasks).where(eq(schema.tasks.userId, userId))).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  // ---- From a thread, Disconnect and Gmail delete (AC-E-1..4, AC-M-3) ---------------------------------

  it("a task from a thread links the thread and its account; Disconnect and Gmail delete set the links null; user delete cascades", async () => {
    const { thread: t } = await thread();
    const r = await createTask(database, { userId, task: input(), threadId: t.id, now: T0 });
    expect(r).toMatchObject({ ok: true, linked: true });
    const id = r.ok ? r.taskId : "";
    const before = await taskRow(id);
    expect(before).toMatchObject({ source: "email", sourceAccountId: account.id, sourceThreadId: t.id });
    expect((await audits())[0]!.detail).toEqual({ taskId: id, source: "email", due: "none", linked: true });
    const listed = (await listTasks(database, userId, T0, "UTC")).groups.none[0]!;
    expect(listed).toMatchObject({ id, threadExists: true, threadSubject: "Invoice due", sourceThreadId: t.id });

    // Gmail delete path: deleting the thread's only message deletes the thread (nulls only the thread link).
    const other = await thread();
    const r2 = await createTask(database, { userId, task: input(), threadId: other.thread.id, now: T0 });
    const id2 = r2.ok ? r2.taskId : "";
    expect(await deleteStoredMessage(database, account.id, other.gmailMessageId)).toBe(true);
    const after2 = await taskRow(id2);
    expect(after2).toMatchObject({ sourceAccountId: account.id, sourceThreadId: null, title: before!.title, notes: before!.notes, source: "email" });

    // Disconnect: both links null, every other column unchanged.
    await deleteAccount(database, userId, account.id);
    const after = await taskRow(id);
    expect(after).toEqual({ ...before, sourceAccountId: null, sourceThreadId: null });
    const gone = (await listTasks(database, userId, T0, "UTC")).groups.none.find((x) => x.id === id)!;
    expect(gone).toMatchObject({ threadExists: false, threadSubject: null, sourceThreadId: null, source: "email" });

    await database.delete(schema.users).where(eq(schema.users.id, userId));
    expect(await database.select().from(schema.tasks)).toEqual([]);
  });

  it("AC-E-3 (forced): the account is disconnected between the outside read and the transaction: null links, linked false, no 23503", async () => {
    const { thread: t } = await thread();
    const hooked = new Proxy(database, {
      get(target, p) {
        if (p === "transaction")
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            await deleteAccount(database, userId, account.id);
            return (target.transaction as (f: unknown) => Promise<unknown>)(fn);
          };
        const v = Reflect.get(target, p, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Database;
    const r = await createTask(hooked, { userId, task: input(), threadId: t.id, now: T0 });
    expect(r).toMatchObject({ ok: true, linked: false });
    const row = await taskRow(r.ok ? r.taskId : "");
    expect(row).toMatchObject({ source: "email", sourceAccountId: null, sourceThreadId: null });
    expect((await audits()).map((a) => a.detail)).toEqual([{ taskId: row!.id, source: "email", due: "none", linked: false }]);
  });

  // ---- Views and counts (AC-V-3, AC-V-4, AC-V-5) --------------------------------------------------------

  it("countDueForNav equals the classifier's overdue + today on 240 seeded tasks across zones and DST days", async () => {
    const zones = ["America/New_York", "Europe/London", "Australia/Lord_Howe", "America/Santiago", "Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"];
    const nows = ["2026-03-08T12:00:00Z", "2026-11-01T05:30:00Z", "2026-09-06T04:00:00Z", "2026-04-05T03:30:00Z", "2026-04-04T13:15:00Z", "2026-03-29T00:59:59Z"].map((s) => new Date(s));
    let rnd = 12345;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31), rnd / 2 ** 31);
    const values: (typeof schema.tasks.$inferInsert)[] = [];
    for (let i = 0; i < 240; i++) {
      const base = nows[i % nows.length]!.getTime();
      const status = (["open", "open", "open", "open", "suggested", "done", "dismissed"] as const)[i % 7]!;
      const kind = i % 3;
      const offsetMs = Math.round((rand() - 0.45) * 20 * 86_400_000);
      const v: typeof schema.tasks.$inferInsert = { userId, title: `t${i}`, source: "manual", status, completedAt: status === "done" ? new Date(base) : null };
      if (kind === 1) v.dueDate = new Date(base + offsetMs).toISOString().slice(0, 10);
      if (kind === 2) Object.assign(v, { dueAt: new Date(base + offsetMs), dueTz: "UTC" });
      // Exact edges: due exactly at a now, and at local midnights.
      if (i % 37 === 0) Object.assign(v, { dueDate: null, dueAt: new Date(base), dueTz: "UTC" });
      if (i % 41 === 0) Object.assign(v, { dueDate: null, dueAt: startOfLocalDay("2026-03-09", "America/New_York"), dueTz: "America/New_York" });
      values.push(v);
    }
    await database.insert(schema.tasks).values(values);
    const all = await database.select().from(schema.tasks).where(eq(schema.tasks.userId, userId));
    expect(all.length).toBe(240);
    let compared = 0;
    for (const zone of zones) {
      for (const now of nows) {
        const expected = { overdue: 0, today: 0 };
        for (const t of all) {
          if (t.status !== "open") continue;
          const c = classifyDeadline(t, now, zone);
          if (c === "overdue") expected.overdue++;
          if (c === "today") expected.today++;
        }
        expect(await countDueForNav(database, userId, now, zone), `${zone} ${now.toISOString()}`).toEqual(expected);
        // listTasks agrees, and never shows suggested/done/dismissed in the dated sections (AC-V-4).
        const { groups } = await listTasks(database, userId, now, zone);
        expect(groups.overdue.length + groups.today.length).toBe(expected.overdue + expected.today);
        const sections = [...groups.overdue, ...groups.today, ...groups.upcoming.flatMap((d) => d.tasks), ...groups.later, ...groups.none];
        expect(sections.every((t) => t.status === "open")).toBe(true);
        expect(sections.length).toBe(all.filter((t) => t.status === "open").length);
        expect(groups.suggested.length).toBe(all.filter((t) => t.status === "suggested").length);
        compared++;
      }
    }
    expect(compared).toBe(42);
  });

  it("listTasks caps at ACTIVE_LIMIT; Done shows only the last 30 days, newest first", async () => {
    const rows = Array.from({ length: ACTIVE_LIMIT + 5 }, (_, i) => ({ userId, title: `t${i}`, source: "manual" as const }));
    await database.insert(schema.tasks).values(rows);
    const r = await listTasks(database, userId, T0, "UTC");
    expect(r.truncated).toBe(true);
    expect(r.groups.none.length).toBe(ACTIVE_LIMIT);
    await database.delete(schema.tasks);
    const day = 86_400_000;
    const done = (title: string, ago: number) => ({ userId, title, source: "manual" as const, status: "done" as const, completedAt: new Date(T0.getTime() - ago) });
    await database.insert(schema.tasks).values([done("new", 1000), done("29d", 29 * day), done("31d", 31 * day), done("old", 400 * day)]);
    expect((await listDoneTasks(database, userId, T0)).map((t) => t.title)).toEqual(["new", "29d"]);
    expect((await listTasks(database, userId, T0, "UTC")).truncated).toBe(false);
  });

  it("the page read functions bind no title or notes (AC-L-2)", async () => {
    const { thread: t } = await thread();
    const id = await made({ due: { kind: "date", date: "2026-06-10" } });
    await createTask(database, { userId, task: input(), threadId: t.id, now: T0 });
    const params: unknown[] = [];
    const logged = drizzle(client, { schema, logger: { logQuery: (_q: string, p: unknown[]) => void params.push(...p) } }) as unknown as Database;
    await listTasks(logged, userId, T0, "America/New_York");
    await listDoneTasks(logged, userId, T0);
    await getTaskForEdit(logged, userId, id);
    await countDueForNav(logged, userId, T0, "America/New_York");
    expect(params.length).toBeGreaterThan(5);
    expect(params.filter((p) => typeof p === "string" && p.includes(MARK))).toEqual([]);
    expect(params.filter((p) => typeof p === "string" && p.includes("Invoice"))).toEqual([]);
  });

  // ---- Races on a separate pool (AC-DB-2) ------------------------------------------------------------

  it("createTask paused before its insert holds the account: Disconnect waits, then sets the links null (no 40P01/23503)", async () => {
    const { thread: t } = await thread();
    const g = pauseBeforeFirstInsert(poolDb, [schema.tasks]);
    const create = createTask(g.db, { userId, task: input(), threadId: t.id, now: T0 }).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, code: pgCode(e) }),
    );
    await Promise.race([g.paused, create]);
    let done = false;
    const disconnect = deleteAccount(poolDb, userId, account.id, { attempts: 1 }).then(
      () => ((done = true), "ok"),
      (e: unknown) => ((done = true), `error:${pgCode(e)}`),
    );
    await sleep(250);
    expect(done, "Disconnect waits for the task transaction").toBe(false);
    g.release();
    const c = await create;
    expect(c).toMatchObject({ ok: true, v: { ok: true, linked: true } });
    expect(await disconnect).toBe("ok");
    const id = c.ok && c.v.ok ? c.v.taskId : "";
    expect(await taskRow(id)).toMatchObject({ source: "email", sourceAccountId: null, sourceThreadId: null });
  });

  it("createTask paused before its insert holds the thread: a Gmail delete waits, then sets the thread link null", async () => {
    const { thread: t, gmailMessageId } = await thread();
    const g = pauseBeforeFirstInsert(poolDb, [schema.tasks]);
    const create = createTask(g.db, { userId, task: input(), threadId: t.id, now: T0 }).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, code: pgCode(e) }),
    );
    await Promise.race([g.paused, create]);
    let done = false;
    const del = deleteStoredMessage(poolDb, account.id, gmailMessageId).then(
      (v) => ((done = true), `ok:${v}`),
      (e: unknown) => ((done = true), `error:${pgCode(e)}`),
    );
    await sleep(250);
    expect(done, "the thread delete waits for the task transaction").toBe(false);
    g.release();
    const c = await create;
    expect(c).toMatchObject({ ok: true, v: { ok: true, linked: true } });
    expect(await del).toBe("ok:true");
    const id = c.ok && c.v.ok ? c.v.taskId : "";
    expect(await taskRow(id)).toMatchObject({ source: "email", sourceAccountId: account.id, sourceThreadId: null });
  });

  it("a Gmail delete committed before createTask's transaction leaves null links (no 23503)", async () => {
    const { thread: t, gmailMessageId } = await thread();
    const hooked = new Proxy(database, {
      get(target, p) {
        if (p === "transaction")
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            await deleteStoredMessage(database, account.id, gmailMessageId);
            return (target.transaction as (f: unknown) => Promise<unknown>)(fn);
          };
        const v = Reflect.get(target, p, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Database;
    const r = await createTask(hooked, { userId, task: input(), threadId: t.id, now: T0 });
    expect(r).toMatchObject({ ok: true, linked: false });
    expect(await taskRow(r.ok ? r.taskId : "")).toMatchObject({ source: "email", sourceAccountId: null, sourceThreadId: null });
  });

  it("complete, update and delete paused before their audit insert (task row locked) vs Disconnect: no errors", async () => {
    const results: string[] = [];
    for (const op of ["complete", "update", "delete"] as const) {
      const acc = await makeGoogleAccount(database, userId, { email: `${op}@example.com` });
      const { thread: t } = await thread(acc);
      const r = await createTask(database, { userId, task: input(), threadId: t.id, now: T0 });
      const id = r.ok ? r.taskId : "";
      const g = pauseBeforeFirstInsert(poolDb, [schema.auditLog]);
      const run =
        op === "complete"
          ? completeTask(g.db, userId, id, T0)
          : op === "update"
            ? updateTask(g.db, { userId, taskId: id, task: input({ title: "changed" }), now: T0 })
            : deleteTask(g.db, userId, id);
      const write = run.then(
        (v) => `ok:${v.ok}`,
        (e: unknown) => `error:${pgCode(e)}`,
      );
      await Promise.race([g.paused, write]);
      const disconnect = deleteAccount(poolDb, userId, acc.id, { attempts: 1 }).then(
        () => "ok",
        (e: unknown) => `error:${pgCode(e)}`,
      );
      await sleep(150);
      g.release();
      results.push(`${op} ${await write} ${await disconnect}`);
      const row = await taskRow(id);
      if (op === "delete") expect(row).toBeUndefined();
      else expect(row).toMatchObject({ sourceAccountId: null, sourceThreadId: null, status: op === "complete" ? "done" : "open" });
    }
    expect(results).toEqual(["complete ok:true ok", "update ok:true ok", "delete ok:true ok"]);
  });

  it("staggered races, retries off: Disconnect and Gmail delete vs create/complete/update/delete on linked tasks, 0 deadlocks, 0 FK errors", { timeout: 240_000 }, async () => {
    const errors: string[] = [];
    let linkedCreates = 0;
    let unlinkedCreates = 0;
    for (let round = 0; round < 60; round++) {
      const acc = await makeGoogleAccount(database, userId, { email: `r${round}@example.com` });
      const a = await thread(acc);
      const b = await thread(acc);
      const ids: string[] = [];
      for (const th of [a, b, a]) {
        const r = await createTask(database, { userId, task: input(), threadId: th.thread.id, now: T0 });
        ids.push(r.ok ? r.taskId : "");
      }
      const viaGmail = round % 2 === 1;
      const ops: Promise<string>[] = [
        (async () => {
          await sleep(round % 5);
          const r = await createTask(poolDb, { userId, task: input(), threadId: (round % 3 === 0 ? b : a).thread.id, now: T0 });
          if (r.ok && r.linked) linkedCreates++;
          else if (r.ok) unlinkedCreates++;
          return r.ok ? "ok" : r.error;
        })(),
        (async () => {
          await sleep(round % 3);
          return `c:${(await completeTask(poolDb, userId, ids[0]!, T0)).ok}`;
        })(),
        (async () => {
          await sleep(round % 4);
          return `u:${(await updateTask(poolDb, { userId, taskId: ids[1]!, task: input({ priority: "high" }), now: T0 })).ok}`;
        })(),
        (async () => {
          await sleep(round % 6);
          return `d:${(await deleteTask(poolDb, userId, ids[2]!)).ok}`;
        })(),
        (async () => {
          await sleep(round % 7);
          if (viaGmail) {
            await deleteStoredMessage(poolDb, acc.id, a.gmailMessageId);
            await deleteStoredMessage(poolDb, acc.id, b.gmailMessageId);
          } else {
            await deleteAccount(poolDb, userId, acc.id, { attempts: 1 });
          }
          return "gone";
        })(),
      ].map((p) => p.catch((e: unknown) => `error:${pgCode(e)}`));
      const out = await Promise.all(ops);
      for (const o of out) if (o.startsWith("error:") || o === "thread_not_found") errors.push(`round ${round}: ${o}`);
      // Every remaining task of this round has no dangling link.
      const left = await database
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.userId, userId), inArray(schema.tasks.sourceThreadId, [a.thread.id, b.thread.id])));
      expect(left, `round ${round}`).toEqual([]);
    }
    // thread_not_found is a legitimate outcome when the thread was gone before the outside read.
    expect(errors.filter((e) => !e.endsWith("thread_not_found"))).toEqual([]);
    expect(linkedCreates + unlinkedCreates).toBeGreaterThan(0);
  });
});
