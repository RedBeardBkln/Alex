import { deadlineText } from "@/lib/tasks/format";
import type { TaskRow } from "@/lib/tasks/service";
import { sliceOnCodePoint } from "@/lib/approvals/text";
import { subjectPrefill } from "@/lib/tasks/validate";
import { acceptSuggestionAction, completeTaskAction, dismissSuggestionAction, reopenTaskAction } from "./actions";

// Shared pieces of the task pages (Phase T): notices, the zone banner and a task row.

/** Fixed notices by allowlisted key; any other value shows nothing and is never echoed. */
export const TASK_NOTICES: Record<string, string> = {
  saved: "Saved.",
  deleted: "Task deleted.",
  stale: "That task has changed or no longer exists, so nothing was done. The list below is current.",
};

export function noticeFor(key: unknown): string | null {
  return typeof key === "string" && Object.hasOwn(TASK_NOTICES, key) ? TASK_NOTICES[key]! : null;
}

export function ZoneBanner({ stored, set }: { stored: string | null | undefined; set: boolean }) {
  if (set) return null;
  return (
    <p role="status" className="rounded-md bg-[var(--warn-bg)] px-3 py-2 text-sm">
      {typeof stored === "string"
        ? "Alex doesn't recognise your saved time zone, so it is using UTC. "
        : "Your time zone isn't set, so Alex is using UTC. "}
      Set it in{" "}
      <a href="/settings" className="underline">
        Settings
      </a>
      .
    </p>
  );
}

function QuickAction({ action, taskId, returnTo, label }: { action: (f: FormData) => Promise<void>; taskId: string; returnTo: string; label: string }) {
  return (
    <form action={action}>
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="return" value={returnTo} />
      <button className="rounded-md border border-[var(--border)] px-2 py-1 text-xs">{label}</button>
    </form>
  );
}

/** Where an email task came from: its thread's current subject, or a note that it's gone. */
export function TaskSource({ task }: { task: Pick<TaskRow, "source" | "sourceThreadId" | "threadExists" | "threadSubject"> }) {
  if (task.source !== "email") return null;
  if (!task.threadExists || !task.sourceThreadId) return <span>From an email (no longer in Alex)</span>;
  const subject = subjectPrefill(task.threadSubject) || "(no subject)";
  return (
    <span>
      From an email:{" "}
      <a href={`/inbox/${task.sourceThreadId}`} className="underline">
        Open the conversation
      </a>{" "}
      (<bdi>{subject.length > 120 ? `${sliceOnCodePoint(subject, 120)}…` : subject}</bdi>)
    </span>
  );
}

export function TaskItem({ task: t, zone, returnTo }: { task: TaskRow; zone: string; returnTo: "list" | "done" }) {
  const deadline = deadlineText(t, zone);
  return (
    <li className="flex items-start gap-3 rounded-md border border-[var(--border)] p-3">
      <div className="shrink-0 pt-0.5">
        {t.status === "open" && <QuickAction action={completeTaskAction} taskId={t.id} returnTo={returnTo} label="Complete" />}
        {t.status === "done" && <QuickAction action={reopenTaskAction} taskId={t.id} returnTo={returnTo} label="Reopen" />}
        {t.status === "suggested" && (
          <div className="flex gap-1">
            <QuickAction action={acceptSuggestionAction} taskId={t.id} returnTo={returnTo} label="Accept" />
            <QuickAction action={dismissSuggestionAction} taskId={t.id} returnTo={returnTo} label="Dismiss" />
          </div>
        )}
      </div>
      <div className="min-w-0 space-y-0.5 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <a href={`/tasks/${t.id}`} className={`font-medium underline-offset-4 hover:underline ${t.status === "done" ? "line-through" : ""}`}>
            <bdi>{t.title}</bdi>
          </a>
          {t.priority === "high" && <span className="rounded-full bg-[var(--warn-bg)] px-2 py-0.5 text-xs text-[var(--danger)]">High</span>}
          {t.priority === "low" && <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">Low</span>}
        </p>
        {deadline && <p className="text-[var(--muted)]">Due {deadline}</p>}
        {t.source === "email" && (
          <p className="text-[var(--muted)]">
            <TaskSource task={t} />
          </p>
        )}
      </div>
    </li>
  );
}

/** "2 tasks overdue · 1 due today" (plan 9.2), or null when nothing is due. */
export function dueSummary(counts: { overdue: number; today: number }): string | null {
  const parts: string[] = [];
  const tasks = (n: number) => (n === 1 ? "task" : "tasks");
  if (counts.overdue > 0) parts.push(`${counts.overdue} ${tasks(counts.overdue)} overdue`);
  if (counts.today > 0) parts.push(counts.overdue > 0 ? `${counts.today} due today` : `${counts.today} ${tasks(counts.today)} due today`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The Accounts page's in-app reminder (owner Q12). Renders nothing when nothing is due. */
export function DueBanner({ counts }: { counts: { overdue: number; today: number } }) {
  const summary = dueSummary(counts);
  if (!summary) return null;
  return (
    <p role="status" className={`rounded-md px-3 py-2 text-sm ${counts.overdue > 0 ? "bg-[var(--warn-bg)]" : "border border-[var(--border)] bg-[var(--surface)]"}`}>
      {summary} →{" "}
      <a href="/tasks" className="underline">
        Tasks
      </a>
    </p>
  );
}
