/**
 * Task input rules (Phase T, plan section 5.4). Import-free apart from the text helpers (themselves
 * import-free) and the time module. Every refusal is a fixed code; typed text never appears in one.
 */
import { isBidiControl, hasDisallowedControl, sliceOnCodePoint, stripAllControls, stripInvisible, wellFormed } from "@/lib/approvals/text";
import { isCalendarDate, isWallTime, zonedToInstant } from "./time";

export const TITLE_MAX = 500;
export const NOTES_MAX = 20_000;
/** What the form fields accept before the rules run (zod caps in the actions). */
export const TITLE_FORM_MAX = 2_000;
export const NOTES_FORM_MAX = 40_000;
/** Owner Q15: deadlines lie in 2000-01-01..2099-12-31. */
export const DATE_MIN = "2000-01-01";
export const DATE_MAX = "2099-12-31";

export const PRIORITIES = ["high", "normal", "low"] as const;
export type TaskPriority = (typeof PRIORITIES)[number];
export const DUE_KINDS = ["none", "date", "datetime"] as const;
export type DueKind = (typeof DUE_KINDS)[number];

export type TaskDue = { kind: "none" } | { kind: "date"; date: string } | { kind: "datetime"; at: Date; tz: string };
export type TaskInput = { title: string; notes: string | null; priority: TaskPriority; due: TaskDue };

export type TaskInputError =
  | "title_invalid"
  | "title_empty"
  | "title_too_long"
  | "notes_invalid"
  | "notes_too_long"
  | "date_invalid"
  | "time_invalid"
  | "time_in_gap"
  | "due_kind_mismatch"
  | "form_invalid";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: TaskInputError };

const normalizeNewlines = (s: string) => s.replace(/\r\n?/g, "\n");

/**
 * C0 controls (tab and newline included), DEL, C1 controls, bidi controls and the Unicode line and
 * paragraph separators U+2028/U+2029 (round 2, SF2): none belongs in a one-line title.
 */
function hasTitleForbidden(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0x2028 || c === 0x2029 || isBidiControl(c)) return true;
  }
  return false;
}

/** C1 or bidi controls (notes allow tab and newline; other C0 controls and DEL are checked separately). */
function hasC1OrBidi(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x80 && c <= 0x9f) || isBidiControl(c)) return true;
  }
  return false;
}

/**
 * One line, 1-500 UTF-16 units after trimming. Other invisible characters are allowed: U+200D
 * (ZWJ) is part of emoji sequences (owner Q13). But a title made only of invisible characters
 * would render as an empty-looking link, so it counts as empty (round 2, SF2); the stored value is
 * still the trimmed original, invisible characters included. Lone surrogates become U+FFFD.
 */
export function parseTitle(raw: string): Parsed<string> {
  const s = normalizeNewlines(raw);
  if (hasTitleForbidden(s)) return { ok: false, error: "title_invalid" };
  const t = s.trim();
  if (stripInvisible(t).trim().length === 0) return { ok: false, error: "title_empty" };
  if (t.length > TITLE_MAX) return { ok: false, error: "title_too_long" };
  return { ok: true, value: wellFormed(t) };
}

/** Tab and newline allowed; other controls and bidi controls refused. Empty means null. */
export function parseNotes(raw: string): Parsed<string | null> {
  const s = normalizeNewlines(raw);
  if (hasDisallowedControl(s) || hasC1OrBidi(s)) return { ok: false, error: "notes_invalid" };
  const t = s.trim();
  if (t.length === 0) return { ok: true, value: null };
  if (t.length > NOTES_MAX) return { ok: false, error: "notes_too_long" };
  return { ok: true, value: wellFormed(t) };
}

export function isDeadlineDate(s: string): boolean {
  return isCalendarDate(s) && s >= DATE_MIN && s <= DATE_MAX;
}

/**
 * The deadline fields. `zone` is the zone a date-time deadline is entered in: the owner's current
 * effective zone for a new deadline (owner Q4), or the task's own `due_tz` when editing one.
 * A field the chosen kind doesn't use must be empty: "none" with a date or time filled in, or
 * "date" with a time filled in, is refused as `due_kind_mismatch` rather than silently dropped,
 * and the kind is never inferred (round 2, SF1). Whitespace-only counts as empty.
 *
 * `prefill` is passed by the edit form only (round 3): the date and time the edit page pre-filled
 * for the stored deadline (`storedDueFields`). When every non-empty date or time field still equals
 * its pre-filled value, those leftovers are not something the owner typed, so "none" removes the
 * deadline and "date" keeps the (unchanged) stored date and drops the time. Any field that differs
 * from its pre-filled value is still refused. New tasks pass no prefill and stay strict.
 */
export function parseDue(
  fields: { kind: DueKind; date: string; time: string },
  zone: string,
  prefill?: { date: string; time: string },
): Parsed<TaskDue> {
  const date = fields.date.trim();
  const time = fields.time.trim();
  const leftover = (v: string, p: string) => v === "" || (p !== "" && v === p);
  const onlyPrefill = prefill !== undefined && leftover(date, prefill.date) && leftover(time, prefill.time);
  if (fields.kind === "none") {
    if ((date !== "" || time !== "") && !onlyPrefill) return { ok: false, error: "due_kind_mismatch" };
    return { ok: true, value: { kind: "none" } };
  }
  if (fields.kind === "date" && time !== "" && !onlyPrefill) return { ok: false, error: "due_kind_mismatch" };
  if (!isDeadlineDate(date)) return { ok: false, error: "date_invalid" };
  if (fields.kind === "date") return { ok: true, value: { kind: "date", date } };
  if (!isWallTime(time)) return { ok: false, error: "time_invalid" };
  const r = zonedToInstant(date, time, zone);
  if (!r.ok) return { ok: false, error: "time_in_gap" };
  return { ok: true, value: { kind: "datetime", at: r.instant, tz: zone } };
}

export type TaskFormFields = { title: string; notes: string; priority: TaskPriority; kind: DueKind; date: string; time: string };

/**
 * All task fields at once; the first refusal wins (title, notes, then the deadline). `prefill` is
 * the edit form's pre-filled deadline fields (see `parseDue`); the create forms pass none.
 */
export function parseTaskInput(fields: TaskFormFields, zone: string, prefill?: { date: string; time: string }): Parsed<TaskInput> {
  const title = parseTitle(fields.title);
  if (!title.ok) return title;
  const notes = parseNotes(fields.notes);
  if (!notes.ok) return notes;
  const due = parseDue({ kind: fields.kind, date: fields.date, time: fields.time }, zone, prefill);
  if (!due.ok) return due;
  return { ok: true, value: { title: title.value, notes: notes.value, priority: fields.priority, due: due.value } };
}

/**
 * The title field's default value on a thread's "Add task" form, from the stored subject (attacker
 * controlled, so stripped rather than refused): whitespace runs collapsed, controls, bidi and
 * invisible characters removed, trimmed, cut to 500 on a code point. "(no subject)" gives "".
 */
export function subjectPrefill(subject: string | null | undefined): string {
  if (!subject) return "";
  let s = subject.replace(/\s+/g, " ");
  s = stripInvisible(stripAllControls(s));
  s = s.replace(/\s+/g, " ").trim();
  if (s === "(no subject)") return "";
  return sliceOnCodePoint(s, TITLE_MAX).trim();
}

/** Fixed messages for the refusal codes, shown by allowlisted key. `zone` names the zone for a gap. */
export function taskErrorMessage(code: string, zone: string): string | null {
  switch (code) {
    case "title_invalid":
      return "The title can't contain tabs, line breaks, control characters or text-direction characters. Nothing was saved.";
    case "title_empty":
      return "The task needs a title. Nothing was saved.";
    case "title_too_long":
      return `The title can be at most ${TITLE_MAX} characters. Nothing was saved.`;
    case "notes_invalid":
      return "The notes can't contain control characters or text-direction characters. Nothing was saved.";
    case "notes_too_long":
      return `The notes can be at most ${NOTES_MAX.toLocaleString("en-US")} characters. Nothing was saved.`;
    case "date_invalid":
      return "Enter a real date between 2000-01-01 and 2099-12-31. Nothing was saved.";
    case "time_invalid":
      return "Enter a time as HH:MM (00:00 to 23:59). Nothing was saved.";
    case "time_in_gap":
      return `That time doesn't exist on that day in ${zone} because of the clock change. Nothing was saved.`;
    case "due_kind_mismatch":
      return "The deadline choice doesn't match the fields filled in. A date needs “Date” or “Date and time”, and a time needs “Date and time”. Pick the matching choice or clear the extra field. Nothing was saved.";
    case "form_invalid":
      return "That form couldn't be read. Nothing was saved.";
    case "confirm_delete":
      return "Tick “Yes, delete this task” to delete it. Nothing was deleted.";
    default:
      return null;
  }
}
