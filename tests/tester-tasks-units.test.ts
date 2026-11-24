import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as T from "@/lib/tasks/time";
import { parseTitle, parseNotes, parseDue, subjectPrefill, taskErrorMessage } from "@/lib/tasks/validate";
import { deadlineText } from "@/lib/tasks/format";
import { noticeFor } from "@/app/(app)/tasks/task-ui";

// Tester additions for phase-t-tasks (03-test-report.md), no database:
// - a brute-force oracle for zonedToInstant / startOfLocalDay / classification over EVERY zone the
//   runtime knows, around every 2026 transition (not only the four zones the plan names);
// - the subject prefill always yields a title the title rules accept (or an empty field);
// - zone-name edge cases, boundary times, and notice/error lookups with prototype keys.

const MIN = 60_000;
const HOUR = 60 * MIN;
const root = path.resolve(import.meta.dirname, "..");

function wallKey(d: Date, z: string): string {
  const p = T.localParts(d, z);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}

describe("every runtime zone, every 2026 transition: brute-force oracle", () => {
  it("zonedToInstant (gap / earliest), startOfLocalDay and date-only classification match a minute-by-minute scan", { timeout: 180_000 }, () => {
    const zones = ["UTC", ...Intl.supportedValuesOf("timeZone")];
    const fails: string[] = [];
    let transitions = 0;
    let gaps = 0;
    let overlaps = 0;
    for (const zone of zones) {
      const start = Date.UTC(2026, 0, 1) - 2 * 86_400_000;
      const end = Date.UTC(2027, 0, 1) + 2 * 86_400_000;
      let prev = T.offsetAt(new Date(start), zone);
      const tr: number[] = [];
      for (let t = start + HOUR; t <= end; t += HOUR) {
        const o = T.offsetAt(new Date(t), zone);
        if (o !== prev) tr.push(t);
        prev = o;
      }
      transitions += tr.length;
      for (const tt of tr) {
        const earliest = new Map<string, number>();
        const seen = new Map<string, number>();
        const firstOfDate = new Map<string, number>();
        for (let t = tt - 36 * HOUR; t <= tt + 36 * HOUR; t += MIN) {
          const k = wallKey(new Date(t), zone);
          if (!earliest.has(k)) earliest.set(k, t);
          seen.set(k, (seen.get(k) ?? 0) + 1);
          const d = k.slice(0, 10);
          if (!firstOfDate.has(d)) firstOfDate.set(d, t);
        }
        const inner = [...firstOfDate.keys()].sort().slice(1, -1);
        for (const date of inner) {
          const got = T.startOfLocalDay(date, zone).getTime();
          if (got !== firstOfDate.get(date)) fails.push(`sod ${zone} ${date} got ${new Date(got).toISOString()}`);
          for (let m = 0; m < 1440; m += 15) {
            const hm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
            const k = `${date} ${hm}`;
            const r = T.zonedToInstant(date, hm, zone);
            const w = earliest.get(k);
            if (w === undefined) {
              gaps++;
              if (r.ok) fails.push(`z2i ${zone} ${k} got ${r.instant.toISOString()} want gap`);
            } else {
              if ((seen.get(k) ?? 0) > 1) overlaps++;
              if (!r.ok) fails.push(`z2i ${zone} ${k} gap, want ${new Date(w).toISOString()}`);
              else if (r.instant.getTime() !== w) fails.push(`z2i ${zone} ${k} got ${r.instant.toISOString()} want ${new Date(w).toISOString()}`);
            }
          }
        }
        for (let now = tt - 30 * HOUR; now <= tt + 30 * HOUR; now += 30 * MIN) {
          const today = T.localDate(new Date(now), zone);
          for (const date of inner) {
            const want = date < today ? "overdue" : date === today ? "today" : "upcoming";
            const got = T.classifyDeadline({ dueDate: date, dueAt: null }, new Date(now), zone);
            if (got !== want) fails.push(`cls ${zone} ${new Date(now).toISOString()} ${date} ${got}`);
          }
          const ts = T.dayBounds(new Date(now), zone).tomorrowStart.getTime();
          if (!(T.localDate(new Date(ts), zone) > today) || !(T.localDate(new Date(ts - 1000), zone) <= today)) {
            fails.push(`tomorrowStart ${zone} ${new Date(now).toISOString()}`);
          }
        }
      }
      if (fails.length > 50) break;
    }
    // Preconditions: the scan really covered gaps and overlaps in many zones (tzdata 2026a has ~60).
    expect(transitions).toBeGreaterThan(100);
    expect(gaps).toBeGreaterThan(100);
    expect(overlaps).toBeGreaterThan(100);
    expect(fails).toEqual([]);
  });

  it("date-time classification at the exact boundaries in the four plan zones (now, tomorrowStart, upcomingEnd)", () => {
    const cases: [string, string][] = [
      ["America/New_York", "2026-03-07T17:00:00Z"],
      ["America/New_York", "2026-10-31T17:00:00Z"],
      ["Europe/London", "2026-03-28T12:00:00Z"],
      ["Australia/Lord_Howe", "2026-04-04T02:00:00Z"],
      ["Australia/Lord_Howe", "2026-10-03T02:00:00Z"],
      ["America/Santiago", "2026-09-05T20:00:00Z"],
      ["America/Santiago", "2026-04-04T20:00:00Z"],
      // Upcoming's end falls across a transition 14 days later.
      ["America/New_York", "2026-02-25T17:00:00Z"],
      ["America/Santiago", "2026-08-23T15:00:00Z"],
    ];
    for (const [zone, iso] of cases) {
      const now = new Date(iso);
      const b = T.dayBounds(now, zone);
      const at = (ms: number) => T.classifyDeadline({ dueDate: null, dueAt: new Date(ms) }, now, zone);
      expect(at(now.getTime()), `${zone} now`).toBe("overdue");
      expect(at(now.getTime() + 1), `${zone} now+1ms`).toBe("today");
      expect(at(b.tomorrowStart.getTime() - 1), `${zone} ts-1`).toBe("today");
      expect(at(b.tomorrowStart.getTime()), `${zone} ts`).toBe("upcoming");
      expect(at(b.upcomingEnd.getTime() - 1), `${zone} ue-1`).toBe("upcoming");
      expect(at(b.upcomingEnd.getTime()), `${zone} ue`).toBe("later");
      // The bounds are real local-day starts: one ms before is the previous local date.
      expect(T.localDate(new Date(b.upcomingEnd.getTime() - 1), zone)).toBe(T.addDays(b.today, 14));
      expect(T.localDate(b.upcomingEnd, zone)).toBe(T.addDays(b.today, 15));
      // Date-only: day 14 upcoming, day 15 later.
      expect(T.classifyDeadline({ dueDate: T.addDays(b.today, 14), dueAt: null }, now, zone)).toBe("upcoming");
      expect(T.classifyDeadline({ dueDate: T.addDays(b.today, 15), dueAt: null }, now, zone)).toBe("later");
      expect(T.classifyDeadline({ dueDate: T.addDays(b.today, -1), dueAt: null }, now, zone)).toBe("overdue");
    }
  });
});

describe("the subject prefill always gives a title the title rules accept", () => {
  it("random hostile subjects (controls, C1, bidi, invisible, tags, surrogates, whitespace) never produce a refused title", () => {
    const pool: number[] = [
      ...Array.from({ length: 0x20 }, (_, i) => i), 0x7f, ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i),
      0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x2060, 0x2061, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0x00a0, 0x3000, 0x1680, 0x2000, 0x205f,
      0xd800, 0xdc00, 0x41, 0x62, 0x20, 0x28, 0x29,
    ];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      const len = 1 + Math.floor(rnd() * 40);
      let s = "";
      for (let j = 0; j < len; j++) {
        const r = rnd();
        if (r < 0.05) s += String.fromCodePoint(0xe0000 + Math.floor(rnd() * 0x80));
        else if (r < 0.1) s += "\u{1F600}";
        else s += String.fromCharCode(pool[Math.floor(rnd() * pool.length)]!);
      }
      if (rnd() < 0.05) s = "x".repeat(495) + s; // near the 500 cut
      const pre = subjectPrefill(s);
      expect(pre.length).toBeLessThanOrEqual(500);
      if (pre === "") continue;
      const t = parseTitle(pre);
      expect(t.ok, JSON.stringify(s)).toBe(true);
      accepted++;
    }
    expect(accepted).toBeGreaterThan(1000);
  });

  it("the prefill never keeps an RLO/LRI or a C1 control, and never splits a surrogate pair at the cut", () => {
    const evil = `Invoice \u202Egnp.exe\u202C \u2066x\u2069 \u0085\u009b31m ${"z".repeat(480)}\u{1F600}\u{1F600}`;
    const pre = subjectPrefill(evil);
    for (const c of [0x202e, 0x202c, 0x2066, 0x2069, 0x85, 0x9b]) expect(pre.includes(String.fromCharCode(c))).toBe(false);
    expect(pre.length).toBeLessThanOrEqual(500);
    expect(pre.isWellFormed()).toBe(true);
  });
});

describe("zone names and times: edge cases", () => {
  it("offset-like and pseudo zones are refused; ICU aliases are canonicalised to a name the runtime accepts", () => {
    for (const z of ["UTC+5", "UTC+05:00", "GMT-3", "+14:00", "-00:00", "Z", "Etc/Unknown", "Factory", "localtime", "posixrules", "Europe/London\u0000", "Europe /London", "America//New_York", "America/New_York/", "\u0130stanbul"]) {
      expect(T.normalizeTimeZone(z), JSON.stringify(z)).toBeNull();
    }
    for (const z of ["UCT", "Zulu", "Universal", "Etc/Greenwich", "GMT0", "Etc/GMT0"]) expect(T.normalizeTimeZone(z), z).toBe("UTC");
    for (const z of ["Asia/Kolkata", "Asia/Ho_Chi_Minh", "Europe/Kyiv", "America/Argentina/Buenos_Aires", "EST5EDT", "Cuba"]) {
      const c = T.normalizeTimeZone(z);
      expect(c, z).not.toBeNull();
      expect(T.normalizeTimeZone(c!), z).toBe(c); // idempotent
      expect(T.effectiveZone({ timeZone: c }).set).toBe(true);
    }
  });

  it("time and date boundaries: 00:00 and 23:59 accepted; 24:00, seconds, 1-digit hours and full-width digits refused", () => {
    expect(parseDue({ kind: "datetime", date: "2026-05-01", time: "00:00" }, "UTC").ok).toBe(true);
    expect(parseDue({ kind: "datetime", date: "2026-05-01", time: "23:59" }, "UTC").ok).toBe(true);
    for (const time of ["24:00", "23:60", "09:00:00", "9:00", "\uFF10\uFF19:00", "", "0900"]) {
      expect(parseDue({ kind: "datetime", date: "2026-05-01", time }, "UTC"), time).toEqual({ ok: false, error: "time_invalid" });
    }
    for (const date of ["1999-12-31", "2100-01-01", "2026-02-29", "2026-04-31", "2026-1-01", "\uFF12026-01-01", "2026-01-01T00:00"]) {
      expect(parseDue({ kind: "date", date, time: "" }, "UTC"), date).toEqual({ ok: false, error: "date_invalid" });
    }
    expect(parseDue({ kind: "date", date: "2096-02-29", time: "" }, "UTC").ok).toBe(true);
    // Extremes of the range in the extreme zones still give an instant (no throw).
    expect(parseDue({ kind: "datetime", date: "2000-01-01", time: "00:00" }, "Pacific/Kiritimati").ok).toBe(true);
    expect(parseDue({ kind: "datetime", date: "2099-12-31", time: "23:59" }, "Pacific/Pago_Pago").ok).toBe(true);
  });

  it("gap refusals in the other 2026 shapes: Chatham (+12:45/+13:45) and Havana (gap at midnight)", () => {
    expect(T.zonedToInstant("2026-09-27", "02:45", "Pacific/Chatham")).toEqual({ ok: false, gap: true });
    expect(T.zonedToInstant("2026-03-08", "00:30", "America/Havana")).toEqual({ ok: false, gap: true });
    expect(T.startOfLocalDay("2026-03-08", "America/Havana").toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });

  it("an overlap deadline displays with the offset of the occurrence chosen (the earlier one)", () => {
    const r = T.zonedToInstant("2026-11-01", "01:30", "America/New_York");
    expect(r).toEqual({ ok: true, instant: new Date("2026-11-01T05:30:00Z") });
    expect(deadlineText({ dueDate: null, dueAt: new Date("2026-11-01T05:30:00Z"), dueTz: "America/New_York" }, "America/New_York")).toBe(
      "Sun, Nov 1, 2026, 01:30 (UTC-04:00) America/New_York",
    );
    // The second 01:30 (EST) is shown with its own offset, so the two never look the same.
    expect(deadlineText({ dueDate: null, dueAt: new Date("2026-11-01T06:30:00Z"), dueTz: "America/New_York" }, "America/New_York")).toBe(
      "Sun, Nov 1, 2026, 01:30 (UTC-05:00) America/New_York",
    );
  });
});

describe("notice and error lookups never echo or crash on prototype keys", () => {
  it("noticeFor and taskErrorMessage return null for unknown and prototype keys", () => {
    for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "SAVED", " saved", "saved ", "<b>x</b>"]) {
      expect(noticeFor(k), k).toBeNull();
      expect(taskErrorMessage(k, "UTC"), k).toBeNull();
    }
    expect(noticeFor(["saved"])).toBeNull();
  });

  it("the settings page and the inbox look notices up with Object.hasOwn (static)", () => {
    const settings = readFileSync(path.join(root, "src/app/(app)/settings/page.tsx"), "utf8");
    expect(settings).toMatch(/Object\.hasOwn\(table, key\)/);
    const inbox = readFileSync(path.join(root, "src/app/(app)/inbox/page.tsx"), "utf8");
    expect(inbox).toMatch(/Object\.hasOwn\(NOTICES, params\.notice\)/);
  });
});

describe("notes edge cases", () => {
  it("CRLF-doubled notes at the cap are accepted (the 40,000 form cap leaves room for CRLF)", () => {
    expect(parseNotes("x\r\n".repeat(10_000)).ok).toBe(true); // 30,000 raw, 20,000 after CRLF->LF... minus trim
    expect(parseNotes("x".repeat(20_000)).ok).toBe(true);
    expect(parseNotes("x".repeat(20_001))).toEqual({ ok: false, error: "notes_too_long" });
    expect(parseNotes("a\u2028b").ok).toBe(true); // other invisible characters are allowed (owner Q13)
    expect(parseNotes("a\u0085b")).toEqual({ ok: false, error: "notes_invalid" });
  });
});
