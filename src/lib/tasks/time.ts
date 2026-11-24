/**
 * Time zones and deadlines for tasks (Phase T, plan section 6). Import-free and built only on
 * `Intl.DateTimeFormat`, so it needs no env and no dependency (owner Q14). Daylight-saving rules
 * come from the runtime's ICU data.
 *
 * Terms:
 * - an "instant" is a JS Date (a point in time);
 * - a "local date" is a `YYYY-MM-DD` string in some zone, and is never turned into a Date by
 *   `new Date("YYYY-MM-DD")` (that is UTC midnight, the day before in the Americas);
 * - a "wall time" is a local date plus `HH:MM` in some zone.
 */

export const DEFAULT_ZONE = "UTC";

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The canonical IANA name for `input`, or null if it isn't a zone this runtime knows. Refuses
 * offset strings such as `+05:30` (no DST rules) and anything with spaces or controls. `UTC`,
 * `Etc/UTC` and `GMT` give `UTC`; aliases are canonicalised the way the runtime's ICU does it.
 */
export function normalizeTimeZone(input: string): string | null {
  const name = input.trim();
  if (name.length < 1 || name.length > 64 || !ZONE_NAME.test(name)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (resolved.length < 1 || resolved.length > 64 || resolved.startsWith("+") || resolved.startsWith("-")) return null;
  if (resolved === "Etc/UTC" || resolved === "Etc/GMT" || resolved === "GMT") return DEFAULT_ZONE;
  return resolved;
}

export type EffectiveZone = {
  zone: string;
  /** False when the owner never chose a zone, or the stored one isn't recognised any more. */
  set: boolean;
};

/** The owner's zone, or UTC when it isn't set or the runtime no longer accepts it. Never throws. */
export function effectiveZone(user: { timeZone?: string | null }): EffectiveZone {
  const stored = user.timeZone;
  if (typeof stored !== "string") return { zone: DEFAULT_ZONE, set: false };
  const zone = normalizeTimeZone(stored);
  return zone ? { zone, set: true } : { zone: DEFAULT_ZONE, set: false };
}

/** Every zone the server offers in Settings: the runtime's list plus UTC (which the list omits). */
export function supportedZones(): string[] {
  const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [DEFAULT_ZONE, ...list.filter((z) => z !== DEFAULT_ZONE)];
}

// ---- Wall-clock parts -------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The wall-clock reading of `instant` in `zone`. */
export function localParts(instant: Date, zone: string): LocalParts {
  const out: LocalParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatterFor(zone).formatToParts(instant)) {
    if (p.type === "year") out.year = Number(p.value);
    else if (p.type === "month") out.month = Number(p.value);
    else if (p.type === "day") out.day = Number(p.value);
    else if (p.type === "hour") out.hour = Number(p.value);
    else if (p.type === "minute") out.minute = Number(p.value);
    else if (p.type === "second") out.second = Number(p.value);
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad4 = (n: number) => String(n).padStart(4, "0");

function partsToUtcMs(p: LocalParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The zone's offset from UTC at `instant`, in minutes (east positive), whole seconds kept. */
export function offsetAt(instant: Date, zone: string): number {
  const ms = instant.getTime();
  const wholeSecond = ms - (((ms % 1000) + 1000) % 1000);
  return (partsToUtcMs(localParts(instant, zone)) - wholeSecond) / MINUTE;
}

/** `+05:30`-style text for an offset in minutes (ASCII minus). */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.round(Math.abs(minutes));
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** `instant`'s local date in `zone`, as `YYYY-MM-DD`. */
export function localDate(instant: Date, zone: string): string {
  const p = localParts(instant, zone);
  return `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** `instant`'s local `HH:MM` in `zone`. */
export function localTime(instant: Date, zone: string): string {
  const p = localParts(instant, zone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

// ---- Local dates ------------------------------------------------------------------------------

/** True for a real `YYYY-MM-DD` calendar date (any year 0000-9999). */
export function isCalendarDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const t = new Date(Date.UTC(2000, mo - 1, d));
  t.setUTCFullYear(y);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function isWallTime(s: string): boolean {
  return TIME_RE.test(s);
}

function dateParts(date: string): { y: number; m: number; d: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError("not a YYYY-MM-DD date");
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Midnight UTC of the date's numbers, as ms (an arithmetic anchor, never shown as a time). */
function dateAnchor(date: string): number {
  const { y, m, d } = dateParts(date);
  const t = new Date(Date.UTC(2000, m - 1, d));
  t.setUTCFullYear(y);
  return t.getTime();
}

function anchorToDate(ms: number): string {
  const t = new Date(ms);
  return `${pad4(t.getUTCFullYear())}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** `date` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  return anchorToDate(dateAnchor(date) + days * DAY);
}

// ---- Wall time to instant ---------------------------------------------------------------------

export type ZonedResult = { ok: true; instant: Date } | { ok: false; gap: true };

function sameWall(instant: Date, zone: string, wall: LocalParts): boolean {
  const p = localParts(instant, zone);
  return p.year === wall.year && p.month === wall.month && p.day === wall.day && p.hour === wall.hour && p.minute === wall.minute && p.second === wall.second;
}

/**
 * The instant at which `zone`'s clock reads `date` `time` (`HH:MM`). In a DST gap (the wall time
 * doesn't exist) the result is `{gap: true}` (owner Q3: refused). In an overlap (it happens twice)
 * it is the earlier instant, the pre-transition offset (Temporal's "compatible" rule).
 *
 * Method: treat the wall time as if it were UTC, then try every offset the zone has within two
 * days of it; a candidate is valid if the zone's clock really reads that wall time at it.
 */
export function zonedToInstant(date: string, time: string, zone: string): ZonedResult {
  const tm = TIME_RE.exec(time);
  if (!tm || !isCalendarDate(date)) throw new RangeError("invalid date or time");
  const { y, m, d } = dateParts(date);
  const wall: LocalParts = { year: y, month: m, day: d, hour: Number(tm[1]), minute: Number(tm[2]), second: 0 };
  const wallMs = dateAnchor(date) + wall.hour * HOUR + wall.minute * MINUTE;
  const offsets = new Set<number>();
  for (const k of [-2, -1, 0, 1, 2]) offsets.add(offsetAt(new Date(wallMs + k * DAY), zone));
  for (const o of [...offsets]) offsets.add(offsetAt(new Date(wallMs - o * MINUTE), zone));
  const valid: number[] = [];
  for (const o of offsets) {
    const candidate = wallMs - o * MINUTE;
    if (sameWall(new Date(candidate), zone, wall)) valid.push(candidate);
  }
  if (valid.length === 0) return { ok: false, gap: true };
  return { ok: true, instant: new Date(Math.min(...valid)) };
}

/**
 * The first instant whose local date in `zone` is `date`. Usually local 00:00, but on a day whose
 * midnight falls in a DST gap (America/Santiago 2026-09-06) it is the transition instant, the
 * first wall time that exists on that day (local 01:00 there).
 */
export function startOfLocalDay(date: string, zone: string): Date {
  const midnight = zonedToInstant(date, "00:00", zone);
  if (midnight.ok) return midnight.instant;
  // Midnight is in a gap: binary-search the first second whose local date is `date`. Offsets are
  // within -12h..+14h, so 15 h either side of the date's UTC midnight brackets the change.
  const anchor = dateAnchor(date);
  let lo = (anchor - 15 * HOUR) / 1000; // local date before `date`
  let hi = (anchor + 15 * HOUR) / 1000; // local date `date` or later
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(new Date(mid * 1000), zone) >= date) hi = mid;
    else lo = mid;
  }
  return new Date(hi * 1000);
}

// ---- Deadlines --------------------------------------------------------------------------------

export type DeadlineFields = { dueDate: string | null; dueAt: Date | null };
export type DeadlineClass = "overdue" | "today" | "upcoming" | "later" | "none";

/** How many days after today Upcoming covers (roadmap; owner Q7). Beyond that is Later. */
export const UPCOMING_DAYS = 14;

export type DayBounds = { today: string; tomorrowStart: Date; upcomingEnd: Date; lastUpcomingDate: string };

/** The owner's day boundaries at `now`, computed once per page. */
export function dayBounds(now: Date, zone: string): DayBounds {
  const today = localDate(now, zone);
  return {
    today,
    tomorrowStart: startOfLocalDay(addDays(today, 1), zone),
    upcomingEnd: startOfLocalDay(addDays(today, UPCOMING_DAYS + 1), zone),
    lastUpcomingDate: addDays(today, UPCOMING_DAYS),
  };
}

/**
 * Plan section 6.3. A date-only deadline is overdue once its date has ended in the owner's zone; a
 * date-time deadline is overdue from its instant on (a deadline exactly at `now` is overdue).
 */
export function classifyDeadline(task: DeadlineFields, now: Date, zone: string, bounds: DayBounds = dayBounds(now, zone)): DeadlineClass {
  if (task.dueDate !== null) {
    const d = task.dueDate;
    if (d < bounds.today) return "overdue";
    if (d === bounds.today) return "today";
    if (d <= bounds.lastUpcomingDate) return "upcoming";
    return "later";
  }
  if (task.dueAt !== null) {
    const t = task.dueAt.getTime();
    if (t <= now.getTime()) return "overdue";
    if (t < bounds.tomorrowStart.getTime()) return "today";
    if (t < bounds.upcomingEnd.getTime()) return "upcoming";
    return "later";
  }
  return "none";
}

/**
 * The instant a deadline becomes overdue, the first sort key within a group: `due_at` for a
 * date-time deadline, the start of the next local day for a date-only one. Null without a deadline.
 */
export function overdueFrom(task: DeadlineFields, zone: string): Date | null {
  if (task.dueAt !== null) return task.dueAt;
  if (task.dueDate !== null) return startOfLocalDay(addDays(task.dueDate, 1), zone);
  return null;
}

// ---- Display ----------------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `Sun, Mar 8, 2026` from a `YYYY-MM-DD` string, by arithmetic only: the server's own time zone
 * (`TZ`) can't shift it (AC-TZ-10).
 */
export function formatLocalDate(date: string): string {
  const { y, m, d } = dateParts(date);
  const weekday = new Date(dateAnchor(date)).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** `Tue, Mar 10, 2026, 09:00 (UTC-04:00)`: the instant's wall time in `zone`, with the offset. */
export function formatInstantIn(instant: Date, zone: string): string {
  return `${formatLocalDate(localDate(instant, zone))}, ${localTime(instant, zone)} (UTC${formatOffset(offsetAt(instant, zone))})`;
}
