import { and, asc, desc, eq, gt, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { mailThreads, tasks, type Task } from "@/db/schema";
import { audit } from "@/lib/audit";
import { lockAccountForWrite } from "@/lib/db-locks";
import { taskCreatedDetail, taskIdDetail, taskUpdatedDetail, type TaskAuditAction, type TaskField } from "./audit-details";
import { classifyDeadline, dayBounds, localDate, overdueFrom, type DeadlineClass } from "./time";
import type { TaskInput } from "./validate";

/**
 * Tasks (Phase T, plan section 5). Every function takes an Executor and is scoped by user: every
 * WHERE includes `user_id`. Writes are one transaction each, the row change plus its audit entry.
 *
 * Lock order (src/lib/db-locks.ts): only createTask locks the account first. Its task insert's
 * foreign-key checks take KEY SHARE on the account and the thread, while Disconnect takes FOR
 * UPDATE on the account and then deletes the threads; taken late, the two orders could cross
 * (40P01). The other writes don't change a foreign-key column, so Postgres takes no lock on the
 * account or thread for them, and their audit rows carry a null account id (only the users row
 * is checked, which neither Disconnect nor a Gmail delete locks). At worst a Disconnect's SET NULL
 * cascade waits for the task row until that write commits. tests/tasks-db.test.ts runs the races.
 */

export type TaskStatus = Task["status"];

/** Cap on the open and suggested rows one page reads (plan 5.2). */
export const ACTIVE_LIMIT = 1_000;
/** The Done view: tasks completed in the last 30 days, at most 200. */
export const DONE_DAYS = 30;
export const DONE_LIMIT = 200;

const PRIORITY_RANK: Record<Task["priority"], number> = { high: 0, normal: 1, low: 2 };

function dueKind(t: Pick<Task, "dueDate" | "dueAt">): "none" | "date" | "datetime" {
  return t.dueDate !== null ? "date" : t.dueAt !== null ? "datetime" : "none";
}

function dueColumns(input: TaskInput): Pick<Task, "dueDate" | "dueAt" | "dueTz"> {
  switch (input.due.kind) {
    case "date":
      return { dueDate: input.due.date, dueAt: null, dueTz: null };
    case "datetime":
      return { dueDate: null, dueAt: input.due.at, dueTz: input.due.tz };
    default:
      return { dueDate: null, dueAt: null, dueTz: null };
  }
}

async function auditTask(tx: Executor, userId: string, action: TaskAuditAction, detail: Record<string, unknown>): Promise<void> {
  await audit({ userId, accountId: null, action, detail }, tx);
}

// ---- Create -------------------------------------------------------------------------------------

export type CreateTaskResult = { ok: true; taskId: string; linked: boolean } | { ok: false; error: "thread_not_found" };

/**
 * Creates an `open` task. With a `threadId` (the thread page's "Add task"), the thread must be the
 * user's; its account comes from the thread row, never from the form. If the thread or its account
 * disappears between that read and the insert (a Disconnect or a Gmail delete), the task is still
 * created as an email task with null links (`linked: false`), never a foreign-key error.
 */
export async function createTask(ex: Executor, input: { userId: string; task: TaskInput; threadId?: string; now: Date }): Promise<CreateTaskResult> {
  const { userId, task, threadId, now } = input;
  let accountId: string | null = null;
  if (threadId !== undefined) {
    const [thread] = await ex
      .select({ accountId: mailThreads.accountId })
      .from(mailThreads)
      .where(and(eq(mailThreads.id, threadId), eq(mailThreads.userId, userId)))
      .limit(1);
    if (!thread) return { ok: false, error: "thread_not_found" };
    accountId = thread.accountId;
  }
  return ex.transaction(async (tx) => {
    if (accountId) await lockAccountForWrite(tx, accountId);
    // Re-read the thread under KEY SHARE: a Gmail delete committed meanwhile leaves no row (the
    // links are then null), and one not yet started waits for this commit and then sets them null.
    let link: { accountId: string; threadId: string } | null = null;
    if (threadId !== undefined && accountId !== null) {
      const [row] = await tx
        .select({ id: mailThreads.id, accountId: mailThreads.accountId })
        .from(mailThreads)
        .where(and(eq(mailThreads.id, threadId), eq(mailThreads.userId, userId), eq(mailThreads.accountId, accountId)))
        .for("key share");
      if (row) link = { accountId: row.accountId, threadId: row.id };
    }
    const source = threadId !== undefined ? ("email" as const) : ("manual" as const);
    const [row] = await tx
      .insert(tasks)
      .values({
        userId,
        title: task.title,
        notes: task.notes,
        priority: task.priority,
        ...dueColumns(task),
        status: "open",
        source,
        sourceAccountId: link?.accountId ?? null,
        sourceThreadId: link?.threadId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });
    const taskId = row!.id;
    await auditTask(tx, userId, "task.created", taskCreatedDetail({ taskId, source, due: dueKind(dueColumns(task)), linked: link !== null }));
    return { ok: true as const, taskId, linked: link !== null };
  });
}

// ---- Update -------------------------------------------------------------------------------------

export type StaleResult = { ok: false; error: "not_found_or_stale" };

/** Which editable fields differ between the stored row and the input. */
export function changedFields(current: Pick<Task, "title" | "notes" | "priority" | "dueDate" | "dueAt" | "dueTz">, input: TaskInput): TaskField[] {
  const next = dueColumns(input);
  const fields: TaskField[] = [];
  if (current.title !== input.title) fields.push("title");
  if ((current.notes ?? null) !== input.notes) fields.push("notes");
  if (
    current.dueDate !== next.dueDate ||
    (current.dueAt?.getTime() ?? null) !== (next.dueAt?.getTime() ?? null) ||
    current.dueTz !== next.dueTz
  ) {
    fields.push("due");
  }
  if (current.priority !== input.priority) fields.push("priority");
  return fields;
}

/**
 * Edits an `open` or `done` task's title, notes, deadline and priority. Last write wins (single
 * owner, owner Q9). Nothing is written, and nothing audited, when nothing changed.
 */
export async function updateTask(
  ex: Executor,
  input: { userId: string; taskId: string; task: TaskInput; now: Date },
): Promise<{ ok: true; fields: TaskField[] } | StaleResult> {
  const { userId, taskId, task, now } = input;
  return ex.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), inArray(tasks.status, ["open", "done"])))
      .for("no key update");
    if (!current) return { ok: false as const, error: "not_found_or_stale" as const };
    const fields = changedFields(current, task);
    if (fields.length === 0) return { ok: true as const, fields };
    await tx
      .update(tasks)
      .set({ title: task.title, notes: task.notes, priority: task.priority, ...dueColumns(task), updatedAt: now })
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
    await auditTask(tx, userId, "task.updated", taskUpdatedDetail(taskId, fields));
    return { ok: true as const, fields };
  });
}

// ---- State transitions --------------------------------------------------------------------------

/** One conditional UPDATE from `from` plus its audit, in one transaction. No row: stale. */
async function transition(
  ex: Executor,
  userId: string,
  taskId: string,
  from: TaskStatus,
  set: Partial<Pick<Task, "status" | "completedAt" | "updatedAt">>,
  action: TaskAuditAction,
): Promise<{ ok: true } | StaleResult> {
  return ex.transaction(async (tx) => {
    const [row] = await tx
      .update(tasks)
      .set(set)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), eq(tasks.status, from)))
      .returning({ id: tasks.id });
    if (!row) return { ok: false as const, error: "not_found_or_stale" as const };
    await auditTask(tx, userId, action, taskIdDetail(taskId));
    return { ok: true as const };
  });
}

/** open -> done. */
export const completeTask = (ex: Executor, userId: string, taskId: string, now: Date) =>
  transition(ex, userId, taskId, "open", { status: "done", completedAt: now, updatedAt: now }, "task.completed");

/** done -> open. */
export const reopenTask = (ex: Executor, userId: string, taskId: string, now: Date) =>
  transition(ex, userId, taskId, "done", { status: "open", completedAt: null, updatedAt: now }, "task.reopened");

/** suggested -> open (the owner's one click, owner Q3). */
export const acceptSuggestion = (ex: Executor, userId: string, taskId: string, now: Date) =>
  transition(ex, userId, taskId, "suggested", { status: "open", updatedAt: now }, "task.suggestion_accepted");

/** suggested -> dismissed (kept in the database, shown nowhere; owner Q9). */
export const dismissSuggestion = (ex: Executor, userId: string, taskId: string, now: Date) =>
  transition(ex, userId, taskId, "suggested", { status: "dismissed", updatedAt: now }, "task.suggestion_dismissed");

/** Hard delete, any status (owner Q9), audited by id. */
export async function deleteTask(ex: Executor, userId: string, taskId: string): Promise<{ ok: true } | StaleResult> {
  return ex.transaction(async (tx) => {
    const [row] = await tx
      .delete(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
      .returning({ id: tasks.id });
    if (!row) return { ok: false as const, error: "not_found_or_stale" as const };
    await auditTask(tx, userId, "task.deleted", taskIdDetail(taskId));
    return { ok: true as const };
  });
}

// ---- Reads (they bind only ids, dates and zone-derived bounds) -----------------------------------

export type TaskRow = Pick<
  Task,
  "id" | "title" | "notes" | "status" | "priority" | "dueDate" | "dueAt" | "dueTz" | "completedAt" | "source" | "sourceThreadId" | "createdAt"
> & {
  /** The linked thread's current subject; null when there is no linked thread (or it has no subject). */
  threadSubject: string | null;
  /** True while the linked thread row exists. */
  threadExists: boolean;
};

function taskRowQuery(ex: Executor, userId: string) {
  return ex
    .select({
      id: tasks.id,
      title: tasks.title,
      notes: tasks.notes,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      dueAt: tasks.dueAt,
      dueTz: tasks.dueTz,
      completedAt: tasks.completedAt,
      source: tasks.source,
      sourceThreadId: tasks.sourceThreadId,
      createdAt: tasks.createdAt,
      threadSubject: mailThreads.subject,
      threadId: mailThreads.id,
    })
    .from(tasks)
    .leftJoin(mailThreads, and(eq(mailThreads.id, tasks.sourceThreadId), eq(mailThreads.userId, userId)));
}

type RawRow = Awaited<ReturnType<typeof taskRowQuery>>[number];

function toTaskRow(r: RawRow): TaskRow {
  const { threadId, ...rest } = r;
  return { ...rest, threadSubject: threadId ? r.threadSubject : null, threadExists: threadId !== null };
}

/** Sorts tasks within a group (plan 6.3): overdue instant, then priority, then creation, then id. */
export function compareTasks(a: TaskRow, b: TaskRow, zone: string): number {
  const ta = overdueFrom(a, zone)?.getTime() ?? Number.POSITIVE_INFINITY;
  const tb = overdueFrom(b, zone)?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  const pa = PRIORITY_RANK[a.priority];
  const pb = PRIORITY_RANK[b.priority];
  if (pa !== pb) return pa - pb;
  const ca = a.createdAt.getTime();
  const cb = b.createdAt.getTime();
  if (ca !== cb) return ca - cb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type TaskGroups = {
  suggested: TaskRow[];
  overdue: TaskRow[];
  today: TaskRow[];
  /** Grouped by the owner's local date, in date order. */
  upcoming: { date: string; tasks: TaskRow[] }[];
  later: TaskRow[];
  none: TaskRow[];
};

/** Puts open and suggested rows into the /tasks sections (pure; plan 6.3). */
export function groupTasks(rows: TaskRow[], now: Date, zone: string): TaskGroups {
  const bounds = dayBounds(now, zone);
  const groups: Record<DeadlineClass, TaskRow[]> = { overdue: [], today: [], upcoming: [], later: [], none: [] };
  const suggested: TaskRow[] = [];
  for (const r of rows) {
    if (r.status === "suggested") suggested.push(r);
    else if (r.status === "open") groups[classifyDeadline(r, now, zone, bounds)].push(r);
  }
  const cmp = (a: TaskRow, b: TaskRow) => compareTasks(a, b, zone);
  for (const list of Object.values(groups)) list.sort(cmp);
  suggested.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byDate = new Map<string, TaskRow[]>();
  for (const r of groups.upcoming) {
    const d = r.dueDate ?? localDate(r.dueAt!, zone);
    const list = byDate.get(d) ?? [];
    list.push(r);
    byDate.set(d, list);
  }
  const upcoming = [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, list]) => ({ date, tasks: list }));
  return { suggested, overdue: groups.overdue, today: groups.today, upcoming, later: groups.later, none: groups.none };
}

/**
 * The open and suggested tasks, grouped for /tasks. One query, ordered by id and capped at
 * ACTIVE_LIMIT (`truncated` says the cap was hit), then classified in TS.
 */
export async function listTasks(ex: Executor, userId: string, now: Date, zone: string): Promise<{ groups: TaskGroups; truncated: boolean }> {
  const rows = await taskRowQuery(ex, userId)
    .where(and(eq(tasks.userId, userId), inArray(tasks.status, ["open", "suggested"])))
    .orderBy(asc(tasks.id))
    .limit(ACTIVE_LIMIT + 1);
  const truncated = rows.length > ACTIVE_LIMIT;
  return { groups: groupTasks(rows.slice(0, ACTIVE_LIMIT).map(toTaskRow), now, zone), truncated };
}

/** Done tasks completed in the last DONE_DAYS days, newest first, at most DONE_LIMIT. */
export async function listDoneTasks(ex: Executor, userId: string, now: Date): Promise<TaskRow[]> {
  const since = new Date(now.getTime() - DONE_DAYS * 86_400_000);
  const rows = await taskRowQuery(ex, userId)
    .where(and(eq(tasks.userId, userId), eq(tasks.status, "done"), gt(tasks.completedAt, since)))
    .orderBy(desc(tasks.completedAt), asc(tasks.id))
    .limit(DONE_LIMIT);
  return rows.map(toTaskRow);
}

/** One task of the user's, any status, for the edit page. */
export async function getTaskForEdit(ex: Executor, userId: string, taskId: string): Promise<TaskRow | null> {
  const [row] = await taskRowQuery(ex, userId)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  return row ? toTaskRow(row) : null;
}

export type DueCounts = { overdue: number; today: number };

/**
 * The nav badge and the Accounts banner: open tasks that are overdue or due today in the owner's
 * zone, the same rule as classifyDeadline. One count query over the partial indexes.
 */
export async function countDueForNav(ex: Executor, userId: string, now: Date, zone: string): Promise<DueCounts> {
  const { today, tomorrowStart } = dayBounds(now, zone);
  const overdue = or(and(isNotNull(tasks.dueDate), lt(tasks.dueDate, today)), and(isNotNull(tasks.dueAt), lte(tasks.dueAt, now)));
  const dueToday = or(and(isNotNull(tasks.dueDate), eq(tasks.dueDate, today)), and(isNotNull(tasks.dueAt), gt(tasks.dueAt, now), lt(tasks.dueAt, tomorrowStart)));
  const [row] = await ex
    .select({
      overdue: sql<number>`count(*) filter (where ${overdue})::int`,
      today: sql<number>`count(*) filter (where ${dueToday})::int`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, "open"),
        or(and(isNotNull(tasks.dueDate), lte(tasks.dueDate, today)), and(isNotNull(tasks.dueAt), lt(tasks.dueAt, tomorrowStart))),
      ),
    );
  return { overdue: row?.overdue ?? 0, today: row?.today ?? 0 };
}
