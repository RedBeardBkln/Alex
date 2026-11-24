import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { deadlineText, storedDueFields } from "@/lib/tasks/format";
import { getTaskForEdit, type TaskRow } from "@/lib/tasks/service";
import { effectiveZone } from "@/lib/tasks/time";
import { taskErrorMessage } from "@/lib/tasks/validate";
import { requireUser } from "@/lib/session";
import { acceptSuggestionAction, completeTaskAction, deleteTaskAction, dismissSuggestionAction, reopenTaskAction, updateTaskAction } from "../actions";
import { TaskFields, type TaskFieldDefaults } from "../task-fields";
import { noticeFor, TaskSource, ZoneBanner } from "../task-ui";

export const dynamic = "force-dynamic";

/**
 * The form defaults; a date-time deadline is shown in its own zone (or the owner's, if the runtime
 * no longer knows it). The deadline fields come from `storedDueFields`, the same function
 * `updateTaskAction` compares leftover fields against (round 3).
 */
function defaultsFor(t: TaskRow, ownerZone: string): { defaults: TaskFieldDefaults; zone: string | null } {
  const { kind, date, time, zone } = storedDueFields(t, ownerZone);
  return { defaults: { title: t.title, notes: t.notes ?? "", priority: t.priority, kind, date, time }, zone };
}

function Button({ action, taskId, label, danger }: { action: (f: FormData) => Promise<void>; taskId: string; label: string; danger?: boolean }) {
  return (
    <form action={action}>
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="return" value="detail" />
      <button className={`rounded-md border border-[var(--border)] px-3 py-1.5 text-sm ${danger ? "text-[var(--danger)]" : ""}`}>{label}</button>
    </form>
  );
}

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const task = await getTaskForEdit(db(), user.id, id);
  if (!task) notFound();
  const { zone: ownerZone, set } = effectiveZone(user);
  const { defaults, zone: taskZone } = defaultsFor(task, ownerZone);
  const notice = noticeFor(query.notice);
  const error = typeof query.error === "string" ? taskErrorMessage(query.error, taskZone ?? ownerZone) : null;
  const editable = task.status === "open" || task.status === "done";
  const deadline = deadlineText(task, ownerZone);

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href="/tasks" className="underline">
          ← Tasks
        </Link>
      </p>
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

      <section className="space-y-1">
        <h1 className="text-xl font-semibold">
          <bdi>{task.title}</bdi>
        </h1>
        <p className="text-sm text-[var(--muted)]">
          {task.status === "done" ? "Done" : task.status === "suggested" ? "Suggested" : task.status === "dismissed" ? "Dismissed" : "Open"}
          {deadline && ` · Due ${deadline}`}
        </p>
        {task.source === "email" && (
          <p className="text-sm text-[var(--muted)]">
            <TaskSource task={task} />
          </p>
        )}
      </section>

      {editable ? (
        <>
          <form action={updateTaskAction} className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
            <input type="hidden" name="taskId" value={task.id} />
            <TaskFields
              defaults={defaults}
              idPrefix="edit"
              zoneNote={
                taskZone && taskZone !== ownerZone
                  ? `Time zone: ${taskZone} (this task's zone; to use ${ownerZone}, choose None and save, then enter the deadline again)`
                  : `Time zone: ${taskZone ?? ownerZone}`
              }
            />
            <button className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--bg)]">Save</button>
          </form>
          <div className="flex flex-wrap gap-2">
            {task.status === "open" ? (
              <Button action={completeTaskAction} taskId={task.id} label="Complete" />
            ) : (
              <Button action={reopenTaskAction} taskId={task.id} label="Reopen" />
            )}
          </div>
        </>
      ) : (
        <section className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
          {task.notes && (
            <p dir="auto" className="whitespace-pre-wrap">
              {task.notes}
            </p>
          )}
          {task.status === "suggested" && (
            <div className="flex flex-wrap gap-2">
              <Button action={acceptSuggestionAction} taskId={task.id} label="Accept" />
              <Button action={dismissSuggestionAction} taskId={task.id} label="Dismiss" />
            </div>
          )}
        </section>
      )}

      <form action={deleteTaskAction} className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-4 text-sm">
        <input type="hidden" name="taskId" value={task.id} />
        <label className="flex items-center gap-1">
          <input type="checkbox" name="confirm" value="yes" />
          Yes, delete this task
        </label>
        <button className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--danger)]">Delete</button>
      </form>
    </div>
  );
}
