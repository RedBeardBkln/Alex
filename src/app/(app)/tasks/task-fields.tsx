import { DATE_MAX, DATE_MIN, NOTES_MAX, TITLE_MAX, type DueKind, type TaskPriority } from "@/lib/tasks/validate";

export type TaskFieldDefaults = {
  title: string;
  notes: string;
  priority: TaskPriority;
  kind: DueKind;
  date: string;
  time: string;
};

export const EMPTY_TASK_FIELDS: TaskFieldDefaults = { title: "", notes: "", priority: "normal", kind: "none", date: "", time: "" };

const input = "rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm";

/**
 * The task form's fields (Phase T, plan section 9), shared by /tasks, /tasks/[id] and the thread
 * page's "Add task". `zoneNote` says which zone a time is read in. Plain HTML: the browser limits
 * lengths and formats, and the server checks everything again.
 */
export function TaskFields({ defaults, zoneNote, idPrefix }: { defaults: TaskFieldDefaults; zoneNote: string; idPrefix: string }) {
  const id = (s: string) => `${idPrefix}-${s}`;
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={id("title")} className="block text-sm font-medium">
          Title
        </label>
        <input id={id("title")} name="title" required maxLength={TITLE_MAX} defaultValue={defaults.title} dir="auto" className={`${input} mt-1 w-full`} />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Deadline</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(
            [
              ["none", "None"],
              ["date", "Date"],
              ["datetime", "Date and time"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1">
              <input type="radio" name="due_kind" value={value} defaultChecked={defaults.kind === value} />
              {label}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={id("date")}>Date</label>
          <input id={id("date")} type="date" name="due_date" min={DATE_MIN} max={DATE_MAX} defaultValue={defaults.date} className={input} />
          <label htmlFor={id("time")}>Time</label>
          <input id={id("time")} type="time" name="due_time" defaultValue={defaults.time} className={input} />
          <span className="text-[var(--muted)]">{zoneNote}</span>
        </div>
      </fieldset>
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor={id("priority")} className="font-medium">
          Priority
        </label>
        <select id={id("priority")} name="priority" defaultValue={defaults.priority} className={input}>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
      </div>
      <details open={defaults.notes !== ""}>
        <summary className="cursor-pointer text-sm font-medium">Notes</summary>
        <textarea name="notes" rows={4} maxLength={NOTES_MAX} defaultValue={defaults.notes} dir="auto" className={`${input} mt-1 w-full`} />
      </details>
    </div>
  );
}
