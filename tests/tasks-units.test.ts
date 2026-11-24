import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addDays,
  classifyDeadline,
  effectiveZone,
  formatLocalDate,
  isCalendarDate,
  localDate,
  localParts,
  normalizeTimeZone,
  offsetAt,
  startOfLocalDay,
  supportedZones,
  zonedToInstant,
  type DeadlineFields,
} from "@/lib/tasks/time";
import { parseDue, parseNotes, parseTaskInput, parseTitle, subjectPrefill, taskErrorMessage } from "@/lib/tasks/validate";
import { deadlineText, storedDueFields } from "@/lib/tasks/format";
import { changedFields, compareTasks, groupTasks, type TaskRow } from "@/lib/tasks/service";
import { taskCreatedDetail, taskIdDetail, taskUpdatedDetail, timeZoneChangedDetail } from "@/lib/tasks/audit-details";
import { TASK_ACTION_ERROR_MESSAGE, TaskActionError, guardedWrite } from "@/lib/tasks/errors";

// Phase T unit tests (no database): the time module (AC-TZ-1..11), the input rules (AC-T-2, AC-T-3,
// prefill), classification and sorting (AC-V-1, AC-V-2), audit detail key sets and static checks
// (AC-S-1, AC-S-3). DST expectations use tzdata as of 2026a (plan risk 1).

const root = path.resolve(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf8");
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const at = (iso: string) => new Date(iso);
const iso = (r: ReturnType<typeof zonedToInstant>) => (r.ok ? r.instant.toISOString() : "gap");
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

const dateTask = (d: string): DeadlineFields => ({ dueDate: d, dueAt: null });
const timeTask = (s: string): DeadlineFields => ({ dueDate: null, dueAt: at(s) });

describe("normalizeTimeZone (AC-TZ-1)", () => {
  it("accepts and canonicalises zone names", () => {
    expect(normalizeTimeZone("UTC")).toBe("UTC");
    expect(normalizeTimeZone("Etc/UTC")).toBe("UTC");
    expect(normalizeTimeZone(" America/New_York ")).toBe("America/New_York");
    expect(normalizeTimeZone("america/new_york")).toBe("America/New_York");
    const eastern = normalizeTimeZone("US/Eastern");
    expect(eastern).not.toBeNull();
    expect(normalizeTimeZone(eastern!)).toBe(eastern);
    for (const z of ["Asia/Kolkata", "Asia/Calcutta"]) {
      const c = normalizeTimeZone(z);
      expect(c, z).not.toBeNull();
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: c! })).not.toThrow();
      expect(normalizeTimeZone(c!)).toBe(c);
    }
  });

  it("refuses offsets, unknown names, empty, too long, spaces and controls", () => {
    for (const z of ["+05:30", "-0800", "GMT+5", "Bogus/Zone", "", "   ", "A".repeat(65), "America/New York", `America/New_York${cp(0)}`, `Europe/${cp(10)}London`, "../etc"]) {
      expect(normalizeTimeZone(z), JSON.stringify(z)).toBeNull();
    }
  });

  it("supportedZones lists UTC first and only names normalizeTimeZone accepts", () => {
    const zones = supportedZones();
    expect(zones[0]).toBe("UTC");
    expect(new Set(zones).size).toBe(zones.length);
    for (const z of zones.slice(0, 40)) expect(normalizeTimeZone(z), z).not.toBeNull();
  });

  it("effectiveZone falls back to UTC when unset or unrecognised, and never throws (AC-TZ-11)", () => {
    expect(effectiveZone({ timeZone: null })).toEqual({ zone: "UTC", set: false });
    expect(effectiveZone({})).toEqual({ zone: "UTC", set: false });
    expect(effectiveZone({ timeZone: "Bogus/Zone" })).toEqual({ zone: "UTC", set: false });
    expect(effectiveZone({ timeZone: "+05:30" })).toEqual({ zone: "UTC", set: false });
    expect(effectiveZone({ timeZone: "Europe/London" })).toEqual({ zone: "Europe/London", set: true });
    expect(effectiveZone({ timeZone: "UTC" })).toEqual({ zone: "UTC", set: true });
  });
});

describe("date-only deadlines across DST days (AC-TZ-2, AC-TZ-3)", () => {
  function boundary(date: string, zone: string, todayFrom: string, overdueFrom: string) {
    const ms = (s: string) => new Date(s).getTime();
    expect(classifyDeadline(dateTask(date), new Date(ms(todayFrom) - 1), zone)).toBe("upcoming");
    expect(classifyDeadline(dateTask(date), at(todayFrom), zone)).toBe("today");
    expect(classifyDeadline(dateTask(date), new Date(ms(overdueFrom) - 1), zone)).toBe("today");
    expect(classifyDeadline(dateTask(date), at(overdueFrom), zone)).toBe("overdue");
  }
  it("New York 23-hour and 25-hour days", () => {
    boundary("2026-03-08", "America/New_York", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z");
    boundary("2026-11-01", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z");
  });
  it("Lord Howe's 30-minute shift", () => {
    // 2026-04-05: +11:00 until 02:00 local, then +10:30.
    boundary("2026-04-05", "Australia/Lord_Howe", "2026-04-04T13:00:00Z", "2026-04-05T13:30:00Z");
    expect(offsetAt(at("2026-04-04T12:00:00Z"), "Australia/Lord_Howe")).toBe(660);
    expect(offsetAt(at("2026-04-05T12:00:00Z"), "Australia/Lord_Howe")).toBe(630);
  });
  it("Santiago: midnight that doesn't exist, and the repeated hour", () => {
    expect(startOfLocalDay("2026-09-06", "America/Santiago").toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(localParts(at("2026-09-06T04:00:00Z"), "America/Santiago")).toMatchObject({ day: 6, hour: 1, minute: 0 });
    expect(localDate(at("2026-09-06T03:59:59Z"), "America/Santiago")).toBe("2026-09-05");
    expect(classifyDeadline(dateTask("2026-09-05"), at("2026-09-06T03:59:59Z"), "America/Santiago")).toBe("today");
    expect(classifyDeadline(dateTask("2026-09-05"), at("2026-09-06T04:00:00Z"), "America/Santiago")).toBe("overdue");
    // 2026-04-04 23:00-23:59 happens twice; the day ends after the second 23:59.
    expect(startOfLocalDay("2026-04-05", "America/Santiago").toISOString()).toBe("2026-04-05T04:00:00.000Z");
    expect(localDate(at("2026-04-05T03:59:59Z"), "America/Santiago")).toBe("2026-04-04");
    expect(classifyDeadline(dateTask("2026-04-04"), at("2026-04-05T03:30:00Z"), "America/Santiago")).toBe("today");
    expect(classifyDeadline(dateTask("2026-04-04"), at("2026-04-05T04:00:00Z"), "America/Santiago")).toBe("overdue");
  });
});

describe("changing the owner zone (AC-TZ-4) and far-apart zones (AC-TZ-9)", () => {
  it("date-only tasks follow each zone's date; date-time overdue status never changes", () => {
    const now = at("2026-06-10T23:30:00Z"); // 19:30 in New York (June 10), 00:30 in London (June 11)
    expect(classifyDeadline(dateTask("2026-06-10"), now, "America/New_York")).toBe("today");
    expect(classifyDeadline(dateTask("2026-06-10"), now, "Europe/London")).toBe("overdue");
    for (const t of ["2026-06-10T20:00:00Z", "2026-06-10T23:30:00Z", "2026-06-11T01:00:00Z", "2026-07-01T00:00:00Z"]) {
      const a = classifyDeadline(timeTask(t), now, "America/New_York") === "overdue";
      const b = classifyDeadline(timeTask(t), now, "Europe/London") === "overdue";
      expect(a, t).toBe(b);
    }
    // 23:30 New York time on June 11 = 03:30Z June 12. In New York (June 10 evening) it's tomorrow;
    // in London (00:30 June 11) it is June 12 at 04:30, also not today. Earlier in the day:
    const early = at("2026-06-11T12:00:00Z");
    const task = timeTask("2026-06-12T03:30:00Z"); // 23:30 June 11 in New York, 04:30 June 12 in London
    expect(classifyDeadline(task, early, "America/New_York")).toBe("today");
    expect(classifyDeadline(task, early, "Europe/London")).toBe("upcoming");
  });
  it("Kiritimati and Pago Pago have different todays at the same instant", () => {
    const now = at("2026-06-10T12:00:00Z");
    expect(localDate(now, "Pacific/Kiritimati")).toBe("2026-06-11");
    expect(localDate(now, "Pacific/Pago_Pago")).toBe("2026-06-10");
    expect(classifyDeadline(dateTask("2026-06-10"), now, "Pacific/Kiritimati")).toBe("overdue");
    expect(classifyDeadline(dateTask("2026-06-10"), now, "Pacific/Pago_Pago")).toBe("today");
  });
});

describe("zonedToInstant: gaps and overlaps (AC-TZ-5, AC-TZ-6, AC-TZ-7)", () => {
  it("refuses wall times in a gap", () => {
    expect(iso(zonedToInstant("2026-03-08", "02:30", "America/New_York"))).toBe("gap");
    expect(iso(zonedToInstant("2026-03-29", "01:30", "Europe/London"))).toBe("gap");
    expect(iso(zonedToInstant("2026-10-04", "02:15", "Australia/Lord_Howe"))).toBe("gap");
    expect(iso(zonedToInstant("2026-09-06", "00:30", "America/Santiago"))).toBe("gap");
    expect(parseDue({ kind: "datetime", date: "2026-03-08", time: "02:30" }, "America/New_York")).toEqual({ ok: false, error: "time_in_gap" });
  });
  it("takes the earlier instant in an overlap", () => {
    expect(iso(zonedToInstant("2026-11-01", "01:30", "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(zonedToInstant("2026-10-25", "01:30", "Europe/London"))).toBe("2026-10-25T00:30:00.000Z");
    expect(iso(zonedToInstant("2026-04-04", "23:30", "America/Santiago"))).toBe("2026-04-05T02:30:00.000Z");
  });
  it("entries either side of New York's spring change display as 09:00 there and 13:00/14:00 in London", () => {
    const after = zonedToInstant("2026-03-10", "09:00", "America/New_York");
    const before = zonedToInstant("2026-03-06", "09:00", "America/New_York");
    expect(iso(after)).toBe("2026-03-10T13:00:00.000Z");
    expect(iso(before)).toBe("2026-03-06T14:00:00.000Z");
    const show = (r: typeof after) => deadlineText({ dueDate: null, dueAt: r.ok ? r.instant : null, dueTz: "America/New_York" }, "Europe/London");
    expect(show(after)).toBe("Tue, Mar 10, 2026, 09:00 (UTC-04:00) America/New_York = 13:00 in Europe/London");
    expect(show(before)).toBe("Fri, Mar 6, 2026, 09:00 (UTC-05:00) America/New_York = 14:00 in Europe/London");
    expect(deadlineText({ dueDate: null, dueAt: at("2026-03-10T13:00:00Z"), dueTz: "America/New_York" }, "America/New_York")).toBe(
      "Tue, Mar 10, 2026, 09:00 (UTC-04:00) America/New_York",
    );
    // A different local date in the owner's zone shows the date too.
    expect(deadlineText({ dueDate: null, dueAt: at("2026-03-10T23:00:00Z"), dueTz: "America/New_York" }, "Asia/Tokyo")).toBe(
      "Tue, Mar 10, 2026, 19:00 (UTC-04:00) America/New_York = Wed, Mar 11, 2026, 08:00 in Asia/Tokyo",
    );
    // A stored zone the runtime doesn't know: shown in the owner's zone, no throw.
    expect(deadlineText({ dueDate: null, dueAt: at("2026-03-10T13:00:00Z"), dueTz: "Bogus/Zone" }, "UTC")).toBe("Tue, Mar 10, 2026, 13:00 (UTC+00:00) UTC");
  });

  it("round trip every 15 minutes across each 2026 transition (AC-TZ-8)", () => {
    const windows: [string, string[]][] = [
      ["America/New_York", ["2026-03-08T07:00:00Z", "2026-11-01T06:00:00Z"]],
      ["Europe/London", ["2026-03-29T01:00:00Z", "2026-10-25T01:00:00Z"]],
      ["Australia/Lord_Howe", ["2026-04-04T15:00:00Z", "2026-10-03T15:30:00Z"]],
      ["America/Santiago", ["2026-04-05T03:00:00Z", "2026-09-06T04:00:00Z"]],
    ];
    let checked = 0;
    let overlaps = 0;
    for (const [zone, transitions] of windows) {
      for (const tr of transitions) {
        const center = at(tr).getTime();
        for (let t = center - 6 * 3_600_000; t <= center + 6 * 3_600_000; t += 15 * 60_000) {
          const instant = new Date(t);
          const p = localParts(instant, zone);
          const date = `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
          const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
          const r = zonedToInstant(date, time, zone);
          expect(r.ok, `${zone} ${instant.toISOString()}`).toBe(true);
          const back = r.ok ? r.instant.getTime() : NaN;
          if (back !== t) {
            // Only the second occurrence of a repeated wall time may map elsewhere: to the earlier one.
            expect(back, `${zone} ${instant.toISOString()}`).toBeLessThan(t);
            expect(localParts(new Date(back), zone)).toEqual(p);
            expect(offsetAt(new Date(back), zone)).toBeGreaterThan(offsetAt(instant, zone));
            overlaps++;
          }
          checked++;
        }
      }
    }
    expect(checked).toBe(8 * 49);
    // 4 fall-back transitions: NY/London/Santiago one hour (4 steps each), Lord Howe 30 min (2 steps).
    expect(overlaps).toBe(14);
  });
});

describe("dates (AC-T-3, AC-TZ-10)", () => {
  it("only real dates in 2000..2099, and HH:MM times", () => {
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-2-3")).toBe(false);
    for (const d of ["1999-12-31", "2100-01-01", "2026-02-30", "2026-13-01", "26-01-01", ""]) {
      expect(parseDue({ kind: "date", date: d, time: "" }, "UTC"), d).toEqual({ ok: false, error: "date_invalid" });
    }
    for (const d of ["2000-01-01", "2099-12-31"]) expect(parseDue({ kind: "date", date: d, time: "" }, "UTC")).toEqual({ ok: true, value: { kind: "date", date: d } });
    for (const t of ["24:00", "9:00", "09:60", "09:00:00", ""]) {
      expect(parseDue({ kind: "datetime", date: "2026-05-01", time: t }, "UTC"), t).toEqual({ ok: false, error: "time_invalid" });
    }
    expect(parseDue({ kind: "none", date: "", time: "" }, "UTC")).toEqual({ ok: true, value: { kind: "none" } });
    expect(parseDue({ kind: "none", date: "  ", time: " " }, "UTC")).toEqual({ ok: true, value: { kind: "none" } });
    expect(parseDue({ kind: "datetime", date: "2026-05-01", time: "23:59" }, "Europe/London")).toEqual({
      ok: true,
      value: { kind: "datetime", at: at("2026-05-01T22:59:00Z"), tz: "Europe/London" },
    });
  });
  it("a filled-in field the chosen kind doesn't use is refused, not dropped, and the kind is never inferred (round 2, SF1)", () => {
    const mismatch = { ok: false, error: "due_kind_mismatch" };
    expect(parseDue({ kind: "none", date: "2026-05-01", time: "" }, "UTC")).toEqual(mismatch);
    expect(parseDue({ kind: "none", date: "", time: "09:00" }, "UTC")).toEqual(mismatch);
    expect(parseDue({ kind: "none", date: "2026-05-01", time: "09:00" }, "UTC")).toEqual(mismatch);
    expect(parseDue({ kind: "none", date: "garbage", time: "garbage" }, "UTC")).toEqual(mismatch);
    expect(parseDue({ kind: "date", date: "2026-05-01", time: "09:00" }, "UTC")).toEqual(mismatch);
    // The mismatch is reported before the date is checked.
    expect(parseDue({ kind: "date", date: "bad", time: "09:00" }, "UTC")).toEqual(mismatch);
    expect(parseDue({ kind: "date", date: "2026-05-01", time: "  " }, "UTC")).toEqual({ ok: true, value: { kind: "date", date: "2026-05-01" } });
    // "Date and time" uses both fields, so nothing extra can be left over.
    expect(parseDue({ kind: "datetime", date: "", time: "09:00" }, "UTC")).toEqual({ ok: false, error: "date_invalid" });
    const base = { title: "Pay rent", notes: "", priority: "normal" as const, kind: "none" as const, date: "2026-05-01", time: "" };
    expect(parseTaskInput(base, "UTC")).toEqual(mismatch);
    expect(taskErrorMessage("due_kind_mismatch", "UTC")).toBe(
      "The deadline choice doesn't match the fields filled in. A date needs “Date” or “Date and time”, and a time needs “Date and time”. Pick the matching choice or clear the extra field. Nothing was saved.",
    );
  });
  it("addDays crosses months, years and leap days", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-03-08", 15)).toBe("2026-03-23");
  });
  it("a date-only deadline renders as its own date whatever the process TZ is", () => {
    expect(formatLocalDate("2026-03-08")).toBe("Sun, Mar 8, 2026");
    expect(deadlineText({ dueDate: "2026-03-08", dueAt: null, dueTz: null }, "Pacific/Kiritimati")).toBe("Sun, Mar 8, 2026");
    const out = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "-e", `import("${pathToFileURL(path.join(root, "src/lib/tasks/time.ts")).href}").then((m) => process.stdout.write(m.formatLocalDate("2026-03-08") + "|" + new Date(2026, 0, 1).getTimezoneOffset()))`],
      { env: { ...process.env, TZ: "America/Los_Angeles" }, encoding: "utf8" },
    );
    expect(out).toBe("Sun, Mar 8, 2026|480");
  });
});

describe("title and notes rules (AC-T-2) and the subject prefill (AC-E-1)", () => {
  it("titles: one line, no controls or bidi, 1..500 after trim, lone surrogates repaired", () => {
    for (const bad of [`a${cp(0)}b`, "a\tb", "a\nb", "a\r\nb", `a${cp(0x7f)}`, `a${cp(0x85)}`, `a${cp(0x202e)}b`, `a${cp(0x2066)}b`, `a${cp(0x200f)}`]) {
      expect(parseTitle(bad), JSON.stringify(bad)).toEqual({ ok: false, error: "title_invalid" });
    }
    expect(parseTitle("   ")).toEqual({ ok: false, error: "title_empty" });
    expect(parseTitle("")).toEqual({ ok: false, error: "title_empty" });
    expect(parseTitle("x".repeat(500))).toEqual({ ok: true, value: "x".repeat(500) });
    expect(parseTitle(` ${"x".repeat(500)} `)).toEqual({ ok: true, value: "x".repeat(500) });
    expect(parseTitle("x".repeat(501))).toEqual({ ok: false, error: "title_too_long" });
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(parseTitle(`Call ${family}`)).toEqual({ ok: true, value: `Call ${family}` });
    expect(parseTitle(`a${String.fromCharCode(0xd800)}b`)).toEqual({ ok: true, value: `a${cp(0xfffd)}b` });
  });
  it("titles refuse U+2028/U+2029 and count an invisible-only title as empty; ZWJ emoji still pass (round 2, SF2)", () => {
    for (const bad of [`a${cp(0x2028)}b`, `a${cp(0x2029)}b`, `${cp(0x2028)}`, ` x ${cp(0x2029)}`]) {
      expect(parseTitle(bad), JSON.stringify(bad)).toEqual({ ok: false, error: "title_invalid" });
    }
    for (const empty of [cp(0x200b), cp(0x200d), cp(0xfeff), ` ${cp(0x200b, 0x2060, 0x180e)} `, cp(0x200c, 0x20, 0x2061), cp(0xe0041, 0xe007f), `${cp(0x3000)}${cp(0x200b)}`]) {
      expect(parseTitle(empty), JSON.stringify(empty)).toEqual({ ok: false, error: "title_empty" });
    }
    // A visible character keeps the title, and the stored value is the trimmed original, invisible characters included.
    expect(parseTitle(` ${cp(0x200b)}a `)).toEqual({ ok: true, value: `${cp(0x200b)}a` });
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(parseTitle(family)).toEqual({ ok: true, value: family });
    expect(taskErrorMessage("title_empty", "UTC")).toBe("The task needs a title. Nothing was saved.");
    // The subject prefill already strips these, so it never produces a refused title.
    expect(subjectPrefill(`Lunch${cp(0x2028)}friday${cp(0x2029)}`)).toBe("Lunch friday");
    expect(subjectPrefill(cp(0x200b, 0x200d, 0x2028))).toBe("");
  });
  it("notes: tab and newline kept, CRLF stored as LF, other controls refused, 20,000 cap, empty is null", () => {
    expect(parseNotes("a\r\nb\rc\td")).toEqual({ ok: true, value: "a\nb\nc\td" });
    for (const bad of [`a${cp(0)}`, `a${cp(0x1b)}`, `a${cp(0x7f)}`, `a${cp(0x9b)}`, `a${cp(0x202e)}`]) {
      expect(parseNotes(bad), JSON.stringify(bad)).toEqual({ ok: false, error: "notes_invalid" });
    }
    expect(parseNotes("  \n ")).toEqual({ ok: true, value: null });
    expect(parseNotes("n".repeat(20_000))).toEqual({ ok: true, value: "n".repeat(20_000) });
    expect(parseNotes("n".repeat(20_001))).toEqual({ ok: false, error: "notes_too_long" });
  });
  it("parseTaskInput reports the first refusal and passes priority through", () => {
    const base = { title: "Pay rent", notes: "", priority: "high" as const, kind: "date" as const, date: "2026-05-01", time: "" };
    expect(parseTaskInput(base, "UTC")).toEqual({ ok: true, value: { title: "Pay rent", notes: null, priority: "high", due: { kind: "date", date: "2026-05-01" } } });
    expect(parseTaskInput({ ...base, title: "", date: "bad" }, "UTC")).toEqual({ ok: false, error: "title_empty" });
    expect(parseTaskInput({ ...base, notes: cp(0), date: "bad" }, "UTC")).toEqual({ ok: false, error: "notes_invalid" });
  });
  it("the prefill strips bidi, invisible and control characters, collapses whitespace and caps at 500", () => {
    expect(subjectPrefill(`  Re:\t${cp(0x202e)}Invoice${cp(0x200b)}\r\n  due ${cp(0x85)}soon${cp(0xe0041)}  `)).toBe("Re: Invoice due soon");
    expect(subjectPrefill(null)).toBe("");
    expect(subjectPrefill("(no subject)")).toBe("");
    const long = subjectPrefill(`${"a".repeat(499)}${cp(0x1f600)}tail`);
    expect(long.length).toBe(499);
    expect(subjectPrefill("x".repeat(800)).length).toBe(500);
    // The prefill always passes the title rules.
    expect(parseTitle(subjectPrefill(`Lunch${cp(0x2066)} ${cp(0x7f)}friday`)).ok).toBe(true);
  });
  it("error messages are fixed, by allowlisted code", () => {
    expect(taskErrorMessage("time_in_gap", "America/New_York")).toBe("That time doesn't exist on that day in America/New_York because of the clock change. Nothing was saved.");
    expect(taskErrorMessage("<script>", "UTC")).toBeNull();
    expect(taskErrorMessage("toString", "UTC")).toBeNull();
  });
});

function row(over: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    title: "t",
    notes: null,
    status: "open",
    priority: "normal",
    dueDate: null,
    dueAt: null,
    dueTz: null,
    completedAt: null,
    source: "manual",
    sourceThreadId: null,
    createdAt: at("2026-01-01T00:00:00Z"),
    threadSubject: null,
    threadExists: false,
    ...over,
  };
}

describe("views and sorting (AC-V-1, AC-V-2, AC-V-4)", () => {
  const zone = "America/New_York";
  const now = at("2026-06-10T16:00:00Z"); // 12:00 June 10 in New York
  it("sections follow plan 6.3, including the exact-now and tomorrowStart edges", () => {
    const tomorrowStart = startOfLocalDay("2026-06-11", zone);
    expect(tomorrowStart.toISOString()).toBe("2026-06-11T04:00:00.000Z");
    const rows = [
      row({ id: "a", dueAt: now }), // exactly now: overdue
      row({ id: "b", dueAt: new Date(now.getTime() + 1) }),
      row({ id: "c", dueAt: tomorrowStart }), // upcoming
      row({ id: "d", dueAt: new Date(tomorrowStart.getTime() - 1) }), // today
      row({ id: "e", dueDate: "2026-06-09" }),
      row({ id: "f", dueDate: "2026-06-10" }),
      row({ id: "g", dueDate: "2026-06-24" }), // today + 14: upcoming
      row({ id: "h", dueDate: "2026-06-25" }), // later
      row({ id: "i", dueAt: startOfLocalDay("2026-06-25", zone) }), // later
      row({ id: "j", dueAt: new Date(startOfLocalDay("2026-06-25", zone).getTime() - 1) }), // upcoming (June 24)
      row({ id: "k" }),
      row({ id: "s", status: "suggested", dueDate: "2026-06-01" }),
      row({ id: "x", status: "done", dueDate: "2026-06-01", completedAt: now }),
      row({ id: "y", status: "dismissed", dueDate: "2026-06-01" }),
    ];
    const g = groupTasks(rows, now, zone);
    const ids = (l: TaskRow[]) => l.map((r) => r.id);
    expect(ids(g.overdue)).toEqual(["e", "a"]); // e was overdue from June 10 00:00 local, a from now
    expect(ids(g.today)).toEqual(["b", "d", "f"]);
    expect(g.upcoming.map((d) => [d.date, ids(d.tasks)])).toEqual([
      ["2026-06-11", ["c"]],
      ["2026-06-24", ["j", "g"]],
    ]);
    expect(ids(g.later)).toEqual(["i", "h"]);
    expect(ids(g.none)).toEqual(["k"]);
    expect(ids(g.suggested)).toEqual(["s"]);
  });
  it("sorts by overdue instant (timed before date-only on a day), then priority, creation, id", () => {
    const c1 = at("2026-01-01T00:00:00Z");
    const c2 = at("2026-01-02T00:00:00Z");
    const rows = [
      row({ id: "d1", dueDate: "2026-06-10", priority: "low" }),
      row({ id: "d2", dueDate: "2026-06-10", priority: "high", createdAt: c2 }),
      row({ id: "d3", dueDate: "2026-06-10", priority: "high", createdAt: c1 }),
      row({ id: "t1", dueAt: at("2026-06-10T22:00:00Z") }),
      row({ id: "t0", dueAt: at("2026-06-10T21:00:00Z"), priority: "low" }),
      row({ id: "n2", priority: "low" }),
      row({ id: "n1", priority: "high", createdAt: c2 }),
      row({ id: "n0", priority: "high", createdAt: c2 }),
    ];
    const g = groupTasks(rows, now, zone);
    expect(g.today.map((r) => r.id)).toEqual(["t0", "t1", "d3", "d2", "d1"]);
    expect(g.none.map((r) => r.id)).toEqual(["n0", "n1", "n2"]);
    expect(compareTasks(rows[0]!, rows[0]!, zone)).toBe(0);
  });
});

describe("changedFields and audit details (AC-A-1 key sets)", () => {
  it("lists only the field groups that differ", () => {
    const current = { title: "A", notes: null, priority: "normal" as const, dueDate: "2026-05-01", dueAt: null, dueTz: null };
    const same = { title: "A", notes: null, priority: "normal" as const, due: { kind: "date" as const, date: "2026-05-01" } };
    expect(changedFields(current, same)).toEqual([]);
    expect(changedFields(current, { ...same, title: "B", priority: "high" })).toEqual(["title", "priority"]);
    expect(changedFields(current, { ...same, notes: "n", due: { kind: "none" } })).toEqual(["notes", "due"]);
    const timed = { ...current, dueDate: null, dueAt: at("2026-05-01T10:00:00Z"), dueTz: "UTC" };
    expect(changedFields(timed, { ...same, due: { kind: "datetime", at: at("2026-05-01T10:00:00Z"), tz: "UTC" } })).toEqual([]);
    expect(changedFields(timed, { ...same, due: { kind: "datetime", at: at("2026-05-01T10:00:00Z"), tz: "Europe/London" } })).toEqual(["due"]);
  });
  it("detail objects have exactly the planned keys", () => {
    expect(Object.keys(taskCreatedDetail({ taskId: "i", source: "email", due: "datetime", linked: false })).sort()).toEqual(["due", "linked", "source", "taskId"]);
    expect(taskUpdatedDetail("i", ["priority", "title"])).toEqual({ taskId: "i", fields: ["title", "priority"] });
    expect(taskIdDetail("i")).toEqual({ taskId: "i" });
    expect(timeZoneChangedDetail()).toEqual({});
  });
});

describe("content-free action errors (AC-L-1, unit)", () => {
  it("guardedWrite logs only {action, error, code} and throws a fixed error without the original", async () => {
    const marker = "MARKER-7f3a-title-and-notes";
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    let thrown: unknown;
    try {
      await guardedWrite("createTask", async () => {
        throw Object.assign(new Error(`Failed query: insert into tasks params: ${marker}`), { cause: { code: "08006", message: marker } });
      });
    } catch (err) {
      thrown = err;
    } finally {
      console.error = orig;
    }
    expect(thrown).toBeInstanceOf(TaskActionError);
    const e = thrown as Error;
    expect(e.message).toBe(TASK_ACTION_ERROR_MESSAGE);
    expect(e.cause).toBeUndefined();
    expect(String(e.stack)).not.toContain(marker);
    expect(logged).toEqual([["task action failed", { action: "createTask", error: "Error", code: "08006" }]]);
    expect(JSON.stringify(logged)).not.toContain(marker);
  });
});

describe("static checks (AC-S-1, AC-S-3, AC-L-2)", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }
  it("every exported action in tasks/actions.ts and settings/actions.ts calls requireActionUser() first", () => {
    for (const file of ["src/app/(app)/tasks/actions.ts", "src/app/(app)/settings/actions.ts"]) {
      const t = code(read(file)).replace(/\r\n/g, "\n");
      expect(t.startsWith('"use server";'), file).toBe(true);
      const exported = [...t.matchAll(/export async function (\w+)\(formData: FormData\) \{\n\s*([^\n]+)/g)];
      const all = [...t.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)].map((m) => m[1]);
      expect(exported.map((m) => m[1]).sort(), file).toEqual(all.sort());
      expect(exported.length, file).toBeGreaterThan(0);
      for (const m of exported) expect(m[2]!.trim(), `${file} ${m[1]}`).toBe("const user = await requireActionUser();");
    }
  });
  it("src/lib/tasks imports nothing from gmail (except types), google*.ts or ai", () => {
    const files = walk(path.join(root, "src", "lib", "tasks"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of [...files, path.join(root, "src", "lib", "settings.ts")]) {
      const t = code(readFileSync(f, "utf8"));
      for (const m of t.matchAll(/import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g)) {
        const spec = m[2]!;
        expect(/google|\/ai\/|\/ai$|anthropic/.test(spec), `${f}: ${spec}`).toBe(false);
        if (/gmail/.test(spec)) expect(m[1], `${f}: ${spec}`).toBeTruthy();
      }
      expect(t, f).not.toMatch(/googleapis|fetch\(/);
    }
  });
  it("the page read functions bind no title or notes (AC-L-2, static)", () => {
    const t = code(read("src/lib/tasks/service.ts"));
    for (const fn of ["listTasks", "listDoneTasks", "getTaskForEdit", "countDueForNav"]) {
      const start = t.indexOf(`export async function ${fn}(`);
      expect(start, fn).toBeGreaterThan(0);
      const body = t.slice(start, t.indexOf("\n}\n", start));
      expect(body, fn).not.toMatch(/\b(title|notes)\b/);
    }
  });
});

describe("edit form: leftover deadline fields equal to the pre-filled values (round 3)", () => {
  const NY = "America/New_York";
  const dt = { dueDate: null, dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: NY };
  it("storedDueFields renders date-only, date-time (in due_tz) and no deadline, and falls back for an unknown zone", () => {
    expect(storedDueFields({ dueDate: "2026-05-01", dueAt: null, dueTz: null }, NY)).toEqual({ kind: "date", date: "2026-05-01", time: "", zone: null });
    expect(storedDueFields(dt, "Europe/London")).toEqual({ kind: "datetime", date: "2026-12-01", time: "09:00", zone: NY });
    // The wall date in due_tz, not the owner's or UTC's: 03:30 UTC is still Nov 30 in New York.
    expect(storedDueFields({ ...dt, dueAt: new Date("2026-12-01T03:30:00Z") }, "Europe/London")).toEqual({ kind: "datetime", date: "2026-11-30", time: "22:30", zone: NY });
    expect(storedDueFields({ ...dt, dueTz: "Mars/Olympus" }, "Europe/London")).toEqual({ kind: "datetime", date: "2026-12-01", time: "14:00", zone: "Europe/London" });
    expect(storedDueFields({ dueDate: null, dueAt: null, dueTz: null }, NY)).toEqual({ kind: "none", date: "", time: "", zone: null });
  });
  it("None or Date with only pre-filled leftovers is accepted; anything changed is still a mismatch", () => {
    const p = { date: "2026-12-01", time: "09:00" };
    const d = (kind: "none" | "date", date: string, time: string, prefill: { date: string; time: string } = p) => parseDue({ kind, date, time }, NY, prefill);
    expect(d("none", "2026-12-01", "09:00")).toEqual({ ok: true, value: { kind: "none" } });
    expect(d("none", "2026-12-01", "")).toEqual({ ok: true, value: { kind: "none" } });
    expect(d("none", "", "09:00")).toEqual({ ok: true, value: { kind: "none" } });
    expect(d("none", " 2026-12-01 ", " 09:00")).toEqual({ ok: true, value: { kind: "none" } });
    expect(d("date", "2026-12-01", "09:00")).toEqual({ ok: true, value: { kind: "date", date: "2026-12-01" } });
    expect(d("date", "", "09:00")).toEqual({ ok: false, error: "date_invalid" });
    for (const [kind, date, time] of [
      ["none", "2026-12-02", "09:00"],
      ["none", "2026-12-01", "09:30"],
      ["none", "2026-12-02", ""],
      ["none", "", "9:00"],
      ["date", "2026-12-02", "09:00"],
      ["date", "2026-12-01", "10:00"],
    ] as const) {
      expect(d(kind, date, time), `${kind} ${date} ${time}`).toEqual({ ok: false, error: "due_kind_mismatch" });
    }
    // A date-only task's prefill has no time, so a typed time is still a mismatch; a no-deadline task stays strict.
    expect(d("none", "2026-05-01", "", { date: "2026-05-01", time: "" })).toEqual({ ok: true, value: { kind: "none" } });
    expect(d("date", "2026-05-01", "09:00", { date: "2026-05-01", time: "" })).toEqual({ ok: false, error: "due_kind_mismatch" });
    expect(d("none", "2026-05-01", "", { date: "", time: "" })).toEqual({ ok: false, error: "due_kind_mismatch" });
    // Without a prefill (the create forms) the strict round-2 rule applies.
    expect(parseDue({ kind: "none", date: "2026-12-01", time: "09:00" }, NY)).toEqual({ ok: false, error: "due_kind_mismatch" });
    expect(parseDue({ kind: "date", date: "2026-12-01", time: "09:00" }, NY)).toEqual({ ok: false, error: "due_kind_mismatch" });
    // Date and time ignores the prefill.
    expect(parseDue({ kind: "datetime", date: "2026-12-02", time: "10:00" }, NY, p)).toEqual({ ok: true, value: { kind: "datetime", at: new Date("2026-12-02T15:00:00Z"), tz: NY } });
    // parseTaskInput passes it through.
    expect(parseTaskInput({ title: "A", notes: "", priority: "normal", kind: "none", date: "2026-12-01", time: "09:00" }, NY, p)).toEqual({
      ok: true,
      value: { title: "A", notes: null, priority: "normal", due: { kind: "none" } },
    });
    expect(parseTaskInput({ title: "A", notes: "", priority: "normal", kind: "none", date: "2026-12-01", time: "09:00" }, NY)).toEqual({ ok: false, error: "due_kind_mismatch" });
  });
});
