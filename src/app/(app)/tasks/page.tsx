import Link from "next/link";
import { db } from "@/db";
import { ACTIVE_LIMIT, DONE_DAYS, listDoneTasks, listTasks, type TaskGroups, type TaskRow } from "@/lib/tasks/service";
import { effectiveZone, formatLocalDate } from "@/lib/tasks/time";
import { taskErrorMessage } from "@/lib/tasks/validate";
import { requireUser } from "@/lib/session";
import { createTaskAction } from "./actions";
import { EMPTY_TASK_FIELDS, TaskFields } from "./task-fields";
import { noticeFor, TaskItem, ZoneBanner } from "./task-ui";

export const dynamic = "force-dynamic";

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ view?: string; notice?: string; error?: string }> }) {
  const user = await requireUser();
  const params = await searchParams;
  const { zone, set } = effectiveZone(user);
  const now = new Date();
  const notice = noticeFor(params.notice);
  const error = typeof params.error === "string" ? taskErrorMessage(params.error, zone) : null;
  const doneView = params.view === "done";
  // Fetched here, so the sections below are plain (synchronous) components.
  const done = doneView ? await listDoneTasks(db(), user.id, now) : null;
  const open = doneView ? null : await listTasks(db(), user.id, now, zone);

  return (
    <div className="space-y-6">
      <ZoneBanner stored={user.timeZone} set={set} />
      {notice && (
        <p role="status" className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-[var(--warn-bg)] px-3 py-2 text-sm">
          {error}
        </p>
      )}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Tasks</h1>
          <p className="flex gap-3 text-sm">
            {doneView ? (
              <Link href="/tasks" className="underline">
                Open tasks
              </Link>
            ) : (
              <Link href="/tasks?view=done" className="underline">
                Done (last {DONE_DAYS} days)
              </Link>
            )}
          </p>
        </div>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Your to-dos. Overdue and due-today tasks show in the top bar and on the Accounts page. Days follow your time zone ({zone}).
        </p>
      </section>

      {done ? <DoneList done={done} zone={zone} /> : open ? <OpenLists groups={open.groups} truncated={open.truncated} zone={zone} /> : null}
    </div>
  );
}

function DoneList({ done, zone }: { done: TaskRow[]; zone: string }) {
  if (done.length === 0) return <p className="text-sm text-[var(--muted)]">No tasks completed in the last {DONE_DAYS} days.</p>;
  return (
    <ul className="space-y-2">
      {done.map((t) => (
        <TaskItem key={t.id} task={t} zone={zone} returnTo="done" />
      ))}
    </ul>
  );
}

function OpenLists({ groups, truncated, zone }: { groups: TaskGroups; truncated: boolean; zone: string }) {
  const empty =
    groups.suggested.length + groups.overdue.length + groups.today.length + groups.upcoming.length + groups.later.length + groups.none.length === 0;
  return (
    <>
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="mb-3 text-lg font-semibold">New task</h2>
        <form action={createTaskAction} className="space-y-3">
          <TaskFields defaults={EMPTY_TASK_FIELDS} zoneNote={`Time zone: ${zone}`} idPrefix="new" />
          <button className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--bg)]">Add task</button>
        </form>
      </section>

      {truncated && <p className="text-sm text-[var(--muted)]">Showing the first {ACTIVE_LIMIT.toLocaleString("en-US")} open tasks.</p>}

      {groups.suggested.length > 0 && (
        <TaskSection title="Suggested" note="Proposed for you. They don't count until you accept them.">
          {groups.suggested.map((t) => (
            <TaskItem key={t.id} task={t} zone={zone} returnTo="list" />
          ))}
        </TaskSection>
      )}
      {groups.overdue.length > 0 && (
        <TaskSection title="Overdue" danger>
          {groups.overdue.map((t) => (
            <TaskItem key={t.id} task={t} zone={zone} returnTo="list" />
          ))}
        </TaskSection>
      )}
      {groups.today.length > 0 && (
        <TaskSection title="Today">
          {groups.today.map((t) => (
            <TaskItem key={t.id} task={t} zone={zone} returnTo="list" />
          ))}
        </TaskSection>
      )}
      {groups.upcoming.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Upcoming</h2>
          <div className="space-y-3">
            {groups.upcoming.map((day) => (
              <div key={day.date}>
                <h3 className="mb-1 text-sm font-medium text-[var(--muted)]">{formatLocalDate(day.date)}</h3>
                <ul className="space-y-2">
                  {day.tasks.map((t) => (
                    <TaskItem key={t.id} task={t} zone={zone} returnTo="list" />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
      {groups.later.length > 0 && (
        <TaskSection title="Later">
          {groups.later.map((t) => (
            <TaskItem key={t.id} task={t} zone={zone} returnTo="list" />
          ))}
        </TaskSection>
      )}
      {groups.none.length > 0 && (
        <TaskSection title="No date">
          {groups.none.map((t) => (
            <TaskItem key={t.id} task={t} zone={zone} returnTo="list" />
          ))}
        </TaskSection>
      )}
      {empty && <p className="text-sm text-[var(--muted)]">No open tasks.</p>}
    </>
  );
}

function TaskSection({ title, note, danger, children }: { title: string; note?: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <section>
      <h2 className={`mb-1 text-lg font-semibold ${danger ? "text-[var(--danger)]" : ""}`}>{title}</h2>
      {note && <p className="mb-2 text-sm text-[var(--muted)]">{note}</p>}
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

