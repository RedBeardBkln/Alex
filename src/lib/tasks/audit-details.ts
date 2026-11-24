/**
 * `detail` payloads for the task and settings audit entries (Phase T, plan section 7). Content-free:
 * no titles, notes, deadlines, subjects or zone names, only ids, kinds and field names. Every task
 * and settings entry carries `user_id` and a null `account_id`. Import-free.
 */

export type TaskAuditAction =
  | "task.created"
  | "task.updated"
  | "task.completed"
  | "task.reopened"
  | "task.deleted"
  | "task.suggestion_accepted"
  | "task.suggestion_dismissed";

/** The editable field groups `task.updated` can list. */
export const TASK_FIELDS = ["title", "notes", "due", "priority"] as const;
export type TaskField = (typeof TASK_FIELDS)[number];

/** `task.created`. `linked` is false for an email task whose thread vanished before the insert. */
export function taskCreatedDetail(input: { taskId: string; source: "manual" | "email"; due: "none" | "date" | "datetime"; linked: boolean }): Record<string, unknown> {
  return { taskId: input.taskId, source: input.source, due: input.due, linked: input.linked };
}

/** `task.updated`: the names of the fields that actually changed. */
export function taskUpdatedDetail(taskId: string, fields: readonly TaskField[]): Record<string, unknown> {
  return { taskId, fields: TASK_FIELDS.filter((f) => fields.includes(f)) };
}

/** `task.completed`, `task.reopened`, `task.deleted`, `task.suggestion_accepted`, `task.suggestion_dismissed`. */
export function taskIdDetail(taskId: string): Record<string, unknown> {
  return { taskId };
}

/** `settings.time_zone_changed`: nothing. The zone isn't recorded (it shows roughly where the owner is). */
export function timeZoneChangedDetail(): Record<string, unknown> {
  return {};
}
