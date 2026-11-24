import { describe, expect, it } from "vitest";
import { stripInvisible } from "@/lib/approvals/text";
import { DUE_KINDS, parseDue, parseTitle, subjectPrefill } from "@/lib/tasks/validate";

// Tester additions for phase-t-tasks round 2 (SF1, SF2), no database.
// - SF1: parseDue over the whole kind x date x time matrix against an independent rule.
// - SF2: parseTitle over random strings: anything accepted is one line, has a visible character
//   and is stored as typed (trimmed); the prefill, over a new seed and a wider pool, still only
//   produces titles that parseTitle accepts.
// Non-ASCII characters are built with String.fromCodePoint so no tool can rewrite them.

const cp = (...c: number[]) => String.fromCodePoint(...c);

describe("SF1: parseDue matrix", () => {
  it("refuses exactly the fields the chosen kind doesn't use, never guesses, and keeps the old errors otherwise", () => {
    const WS = ["", " ", cp(0x09, 0x20), cp(0xa0, 0x3000)];
    const dates = [...WS, "2026-12-01", "2026-02-30", "garbage", " 2026-12-01 "];
    const times = [...WS, "09:00", "24:00", "garbage", cp(0x200b)];
    const blank = (s: string) => s.trim() === "";
    const validDate = (s: string) => ["2026-12-01", " 2026-12-01 "].includes(s);
    const validTime = (s: string) => s === "09:00";
    let n = 0;
    const seen = new Set<string>();
    for (const kind of DUE_KINDS) {
      for (const date of dates) {
        for (const time of times) {
          const r = parseDue({ kind, date, time }, "America/New_York");
          let want: string;
          if (kind === "none") want = blank(date) && blank(time) ? "ok:none" : "due_kind_mismatch";
          else if (kind === "date") want = !blank(time) ? "due_kind_mismatch" : validDate(date) ? "ok:date" : "date_invalid";
          else want = !validDate(date) ? "date_invalid" : !validTime(time) ? "time_invalid" : "ok:datetime";
          const got = r.ok ? `ok:${r.value.kind}` : r.error;
          expect(got, JSON.stringify({ kind, date, time })).toBe(want);
          if (r.ok && r.value.kind === "date") expect(r.value.date).toBe("2026-12-01");
          if (r.ok && r.value.kind === "datetime") expect(r.value.at.toISOString()).toBe("2026-12-01T14:00:00.000Z");
          seen.add(want);
          n++;
        }
      }
    }
    expect(n).toBe(3 * dates.length * times.length);
    expect([...seen].sort()).toEqual(["date_invalid", "due_kind_mismatch", "ok:date", "ok:datetime", "ok:none", "time_invalid"]);
  });
});

describe("SF2: parseTitle and the prefill", () => {
  const pool: number[] = [
    0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x85, 0x9b, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e,
    0x2060, 0x2064, 0x2066, 0x2069, 0xfeff, 0xa0, 0x3000, 0x1680, 0x2000, 0x205f, 0x20, 0x20, 0x41, 0x62, 0xe9, 0x2d, 0xd800, 0xdc00,
    0xfe0f, 0x20e3, 0xad, 0x034f, 0x2800, 0x3164,
  ];
  const gen = (seed: number) => {
    let s0 = seed;
    const rnd = () => ((s0 = (s0 * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    return (maxLen: number) => {
      const len = Math.floor(rnd() * maxLen);
      let s = "";
      for (let j = 0; j < len; j++) {
        const r = rnd();
        if (r < 0.05) s += cp(0xe0000 + Math.floor(rnd() * 0x80));
        else if (r < 0.1) s += cp(0x1f468, 0x200d, 0x1f469);
        else s += String.fromCharCode(pool[Math.floor(rnd() * pool.length)]!);
      }
      if (rnd() < 0.05) s = "x".repeat(495) + s;
      return s;
    };
  };

  it("an accepted title is one line, has something visible, and is stored as typed (trimmed, well formed)", () => {
    const next = gen(98765);
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 20000; i++) {
      const s = next(12);
      const r = parseTitle(s);
      if (!r.ok) {
        refused++;
        continue;
      }
      accepted++;
      expect(r.value.includes(cp(0x2028)) || r.value.includes(cp(0x2029)), JSON.stringify(s)).toBe(false);
      expect(stripInvisible(r.value).trim().length, JSON.stringify(s)).toBeGreaterThan(0);
      expect(r.value).toBe(s.trim().toWellFormed());
    }
    expect(accepted).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(500);
  });

  it("prefill over 4,000 new hostile subjects (wider pool, new seed) gives only titles parseTitle accepts, unchanged apart from lone surrogates", () => {
    const next = gen(424242);
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      const s = next(40);
      const pre = subjectPrefill(s);
      expect(pre.length).toBeLessThanOrEqual(500);
      if (pre === "") continue;
      const t = parseTitle(pre);
      // A lone surrogate survives the prefill and becomes U+FFFD in parseTitle (stored subjects
      // can't hold one: Postgres text is UTF-8), so compare with the well-formed prefill.
      expect(t, JSON.stringify(s)).toEqual({ ok: true, value: pre.toWellFormed() });
      accepted++;
    }
    expect(accepted).toBeGreaterThan(1000);
  });

  it("a subject that is only separators and invisible characters prefills as empty, not as a refused title", () => {
    for (const s of [cp(0x2028), cp(0x2029, 0x2028), cp(0x200b, 0x200d, 0xfeff), cp(0xe0041, 0xe007f), cp(0x180e, 0x20, 0x2060)]) {
      expect(subjectPrefill(s), JSON.stringify(s)).toBe("");
    }
    expect(subjectPrefill(`Re:${cp(0x2028)}Invoice${cp(0x2029)}due`)).toBe("Re: Invoice due");
  });
});
