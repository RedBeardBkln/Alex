/**
 * Deadline text for the task pages (plan section 6.4), rendered on the server so it doesn't depend
 * on the browser's zone. Import-free apart from the time module (and a type from the rules).
 */
import { formatInstantIn, formatLocalDate, localDate, localTime, normalizeTimeZone } from "./time";
import type { DueKind } from "./validate";

export type DeadlineDisplay = Readonly<{ dueDate: string | null; dueAt: Date | null; dueTz: string | null }>;

/**
 * `Sun, Mar 8, 2026` for a date-only deadline (from its string, never through a Date of the
 * server's zone). For a date-time deadline, its wall time in the zone it was entered in, with the
 * zone and offset, and the owner's own time too when that zone differs ("= 14:00 in Europe/London",
 * with the date when the date differs). Null without a deadline.
 */
export function deadlineText(task: DeadlineDisplay, ownerZone: string): string | null {
  if (task.dueDate !== null) return formatLocalDate(task.dueDate);
  if (task.dueAt === null) return null;
  const entered = task.dueTz !== null ? normalizeTimeZone(task.dueTz) : null;
  if (entered === null) {
    // A zone the runtime no longer knows (an ICU change): show the owner's zone only.
    return `${formatInstantIn(task.dueAt, ownerZone)} ${ownerZone}`;
  }
  const main = `${formatInstantIn(task.dueAt, entered)} ${entered}`;
  if (entered === ownerZone) return main;
  const sameDay = localDate(task.dueAt, entered) === localDate(task.dueAt, ownerZone);
  const there = sameDay ? localTime(task.dueAt, ownerZone) : `${formatLocalDate(localDate(task.dueAt, ownerZone))}, ${localTime(task.dueAt, ownerZone)}`;
  return `${main} = ${there} in ${ownerZone}`;
}

/** The edit form's default date and time for a date-time deadline, in its own zone. */
export function wallTimeIn(instant: Date, zone: string): { date: string; time: string } {
  return { date: localDate(instant, zone), time: localTime(instant, zone) };
}

export type StoredDueFields = { kind: DueKind; date: string; time: string; zone: string | null };

/**
 * The deadline fields the edit page pre-fills for a stored task (round 3). A date-only deadline is
 * its `due_date` string and an empty time. A date-time deadline is its wall date and `HH:MM` in its
 * own `due_tz`, or in the owner's zone when the runtime no longer knows that zone (`zone` says
 * which). No deadline is all empty. The edit page renders exactly these values and
 * `updateTaskAction` compares leftover fields against this same function, so the two can't drift.
 */
export function storedDueFields(task: DeadlineDisplay, ownerZone: string): StoredDueFields {
  if (task.dueDate !== null) return { kind: "date", date: task.dueDate, time: "", zone: null };
  if (task.dueAt !== null) {
    const zone = (task.dueTz !== null ? normalizeTimeZone(task.dueTz) : null) ?? ownerZone;
    return { kind: "datetime", ...wallTimeIn(task.dueAt, zone), zone };
  }
  return { kind: "none", date: "", time: "", zone: null };
}
