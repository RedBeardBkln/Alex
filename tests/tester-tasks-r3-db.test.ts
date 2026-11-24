import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { storedDueFields } from "@/lib/tasks/format";
import { makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester additions for phase-t-tasks round 3 (01a-approval.md Round 3: the edit form accepts None or
// Date when the leftover date/time equal what the page pre-filled for the stored deadline), Postgres
// only (TEST_DATABASE_URL). Through the REAL edit page and the REAL updateTaskAction:
// - the page renders exactly storedDueFields(row, ownerZone) for many zones, DST overlap/gap
//   instants, an unrecognised due_tz, aliases and Etc/UTC, and those rendered values are accepted;
// - values the page did NOT render (owner-zone or UTC wall time, another date/time) are refused;
// - prefill comes only from the database row: forged form fields, another task's values and another
//   user's task don't help; a deadline changed after the page was rendered makes the stale form refuse;
// - whitespace around the rendered values is trimmed, other characters are not;
// - the zone-note copy.
// Characters outside ASCII are built with String.fromCodePoint so no tool can rewrite them.

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));

vi.mock("@/db", async (orig) => ({ ...(await orig<object>()), db: () => state.db }));
vi.mock("@/lib/session", () => ({
  requireUser: async () => {
    if (!state.user) throw new Error("REDIRECT /login");
    return state.user;
  },
  currentUser: async () => state.user,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (u: string) => {
    throw new Error(`REDIRECT ${u}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://alex.example.com" }) }));
vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<object>()),
  env: () => ({ GOOGLE_OAUTH_TESTING_MODE: true, APP_URL: "https://alex.example.com/" }),
}));

const OWNER = "America/New_York";
const cp = (...c: number[]) => String.fromCodePoint(...c);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const m = /^REDIRECT (.*)$/.exec((e as Error).message);
    if (m) return m[1]!;
    throw e;
  }
  throw new Error("no redirect");
}
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function inputValue(html: string, name: string): string | null {
  const tag = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0];
  if (!tag) return null;
  const v = /value="([^"]*)"/.exec(tag);
  return v ? unescape(v[1]!) : "";
}
function checkedKind(html: string): string | null {
  for (const tag of html.match(/<input[^>]*name="due_kind"[^>]*>/g) ?? []) if (/checked=""/.test(tag)) return /value="([^"]*)"/.exec(tag)![1]!;
  return null;
}
const longNote = (taskZone: string) => `Time zone: ${taskZone} (this task's zone; to use ${OWNER}, choose None and save, then enter the deadline again)`;

describe.skipIf(!testDbUrl)("Phase T tester round 3 (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let pool: ReturnType<typeof postgres>;
  let poolDb: Database;
  let userId: string;
  let actions: typeof import("@/app/(app)/tasks/actions");
  let TaskPage: (p: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) => Promise<ReactNode>;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    pool = postgres(testDbUrl!, { max: 4, onnotice: () => {} });
    poolDb = drizzle(pool, { schema }) as unknown as Database;
    actions = await import("@/app/(app)/tasks/actions");
    TaskPage = ((await import("@/app/(app)/tasks/[id]/page")) as unknown as { default: typeof TaskPage }).default;
  });
  afterAll(async () => {
    await pool.end();
    await client.end();
  });
  async function setOwnerZone(zone: string) {
    await database.update(schema.users).set({ timeZone: zone }).where(eq(schema.users.id, userId));
    state.user = (await database.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
  }
  beforeEach(async () => {
    await database.delete(schema.users);
    userId = (await makeUser(database)).id;
    state.db = database;
    await setOwnerZone(OWNER);
  });

  async function raw(over: Partial<typeof schema.tasks.$inferInsert>, uid = userId) {
    const [r] = await database.insert(schema.tasks).values({ userId: uid, title: "Pay invoice", source: "manual", status: "open", ...over }).returning({ id: schema.tasks.id });
    return r!.id;
  }
  const rowOf = async (id: string) => (await database.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!;
  const dueOf = async (id: string) => {
    const r = await rowOf(id);
    return [r.dueDate, r.dueAt?.toISOString() ?? null, r.dueTz];
  };
  const snapshot = async () => ({
    tasks: await database.execute(sql`select * from tasks order by id`),
    audits: Number((await database.execute(sql`select count(*)::int as n from audit_log`))[0]!.n),
  });
  const render = async (id: string) => renderToStaticMarkup((await TaskPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as never);
  /** The form exactly as rendered, with `over` applied. */
  const shown = (html: string) => ({
    kind: checkedKind(html),
    date: inputValue(html, "due_date"),
    time: inputValue(html, "due_time"),
    note: /Time zone: [^<]*/.exec(unescape(html))?.[0] ?? null,
  });
  const submitFor = (id: string, html: string) => (over: Record<string, string>) =>
    redirectOf(
      actions.updateTaskAction(
        form({ taskId: id, title: inputValue(html, "title")!, notes: "", priority: "normal", due_kind: checkedKind(html)!, due_date: inputValue(html, "due_date")!, due_time: inputValue(html, "due_time")!, ...over }),
      ),
    );

  // [label, stored deadline, independent expectation of the rendered date/time (null = only via storedDueFields), task zone for the note]
  const CASES: [string, Partial<typeof schema.tasks.$inferInsert>, [string, string] | null, string | null][] = [
    ["NY 09:00", { dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: OWNER }, ["2026-12-01", "09:00"], OWNER],
    ["Tokyo, wall date ahead of NY and UTC", { dueAt: new Date("2026-12-01T15:30:00Z"), dueTz: "Asia/Tokyo" }, ["2026-12-02", "00:30"], "Asia/Tokyo"],
    ["Honolulu, wall date behind UTC", { dueAt: new Date("2026-12-01T03:30:00Z"), dueTz: "Pacific/Honolulu" }, ["2026-11-30", "17:30"], "Pacific/Honolulu"],
    ["NY overlap, first 01:30 (EDT)", { dueAt: new Date("2026-11-01T05:30:00Z"), dueTz: OWNER }, ["2026-11-01", "01:30"], OWNER],
    ["NY overlap, second 01:30 (EST)", { dueAt: new Date("2026-11-01T06:30:00Z"), dueTz: OWNER }, ["2026-11-01", "01:30"], OWNER],
    ["NY just after the spring gap", { dueAt: new Date("2026-03-08T07:00:00Z"), dueTz: OWNER }, ["2026-03-08", "03:00"], OWNER],
    ["NY just before the spring gap", { dueAt: new Date("2026-03-08T06:59:00Z"), dueTz: OWNER }, ["2026-03-08", "01:59"], OWNER],
    ["Lord Howe half-hour overlap, first", { dueAt: new Date("2026-04-04T14:45:00Z"), dueTz: "Australia/Lord_Howe" }, ["2026-04-05", "01:45"], "Australia/Lord_Howe"],
    ["Lord Howe half-hour overlap, second", { dueAt: new Date("2026-04-04T15:15:00Z"), dueTz: "Australia/Lord_Howe" }, ["2026-04-05", "01:45"], "Australia/Lord_Howe"],
    ["Kathmandu +05:45 at midnight", { dueAt: new Date("2026-12-31T18:15:00Z"), dueTz: "Asia/Kathmandu" }, ["2027-01-01", "00:00"], null], // the runtime may name it Asia/Katmandu
    ["Etc/UTC stored", { dueAt: new Date("2026-12-01T00:15:00Z"), dueTz: "Etc/UTC" }, ["2026-12-01", "00:15"], "UTC"],
    ["alias US/Eastern", { dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: "US/Eastern" }, ["2026-12-01", "09:00"], null],
    ["unrecognised due_tz (owner-zone values)", { dueAt: new Date("2026-12-01T03:30:00Z"), dueTz: "Mars/Olympus" }, ["2026-11-30", "22:30"], OWNER],
    ["lower-case zone name", { dueAt: new Date("2026-12-01T15:30:00Z"), dueTz: "asia/tokyo" }, null, null],
    ["date-only", { dueDate: "2026-12-01" }, ["2026-12-01", ""], null],
    ["date-only at the range end", { dueDate: "2099-12-31" }, ["2099-12-31", ""], null],
    ["no deadline", {}, ["", ""], null],
    ["done task, Tokyo", { status: "done", completedAt: new Date(), dueAt: new Date("2026-12-01T15:30:00Z"), dueTz: "Asia/Tokyo" }, ["2026-12-02", "00:30"], "Asia/Tokyo"],
  ];

  it("the edit page renders exactly storedDueFields, and None / Date with those rendered values save as approved", async () => {
    let checked = 0;
    for (const [label, due, expected, noteZone] of CASES) {
      // None with the rendered values: deadline removed.
      const a = await raw(due);
      const html = await render(a);
      const s = shown(html);
      const fn = storedDueFields(await rowOf(a), OWNER);
      expect([s.kind, s.date, s.time], label).toEqual([fn.kind, fn.date, fn.time]);
      if (expected) expect([s.date, s.time], label).toEqual(expected);
      const taskZone = fn.zone;
      if (noteZone !== null) expect(taskZone, label).toBe(noteZone);
      expect(s.note, label).toBe(taskZone && taskZone !== OWNER ? longNote(taskZone) : `Time zone: ${taskZone ?? OWNER}`);
      expect(await submitFor(a, html)({ due_kind: "none" }), label).toBe(`/tasks/${a}?notice=saved`);
      expect(await dueOf(a), label).toEqual([null, null, null]);

      // Date with the rendered values: the shown date is kept as a date-only deadline.
      if (s.kind !== "none") {
        const b = await raw(due);
        const htmlB = await render(b);
        expect(await submitFor(b, htmlB)({ due_kind: "date" }), label).toBe(`/tasks/${b}?notice=saved`);
        expect(await dueOf(b), label).toEqual([s.date, null, null]);
      }
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });

  it("the zone note's instruction works as written: choose None and save, then enter the deadline again, and it is in the owner's zone", async () => {
    const id = await raw({ dueAt: new Date("2026-12-01T15:30:00Z"), dueTz: "Asia/Tokyo" });
    const html = await render(id);
    expect(shown(html).note).toBe(longNote("Asia/Tokyo"));
    expect(await submitFor(id, html)({ due_kind: "none" })).toBe(`/tasks/${id}?notice=saved`);
    const html2 = await render(id);
    expect(shown(html2)).toEqual({ kind: "none", date: "", time: "", note: `Time zone: ${OWNER}` });
    expect(await submitFor(id, html2)({ due_kind: "datetime", due_date: "2026-12-02", due_time: "00:30" })).toBe(`/tasks/${id}?notice=saved`);
    expect(await dueOf(id)).toEqual([null, "2026-12-02T05:30:00.000Z", OWNER]);
    expect(shown(await render(id)).note).toBe(`Time zone: ${OWNER}`);
  });

  it("values the page did not render are refused: owner-zone and UTC wall times, other dates and times, a typed time on a date-only task, typed values on a task with no deadline", async () => {
    const tokyo = await raw({ dueAt: new Date("2026-12-01T15:30:00Z"), dueTz: "Asia/Tokyo" }); // shown 2026-12-02 00:30
    const dateOnly = await raw({ dueDate: "2026-12-01" });
    const none = await raw({});
    const mars = await raw({ dueAt: new Date("2026-12-01T03:30:00Z"), dueTz: "Mars/Olympus" }); // shown 2026-11-30 22:30 (owner zone)
    const cases: [string, Record<string, string>][] = [
      [tokyo, { due_kind: "none", due_date: "2026-12-01", due_time: "10:30" }], // NY wall time
      [tokyo, { due_kind: "none", due_date: "2026-12-01", due_time: "15:30" }], // UTC wall time
      [tokyo, { due_kind: "date", due_date: "2026-12-01", due_time: "10:30" }],
      [tokyo, { due_kind: "none", due_date: "2026-12-01" }], // NY date with the Tokyo time
      [tokyo, { due_kind: "date", due_date: "2026-12-03" }], // changed date, pre-filled time left
      [tokyo, { due_kind: "none", due_time: "00:31" }],
      [tokyo, { due_kind: "none", due_date: "2026-12-02", due_time: "00:30:00" }],
      [tokyo, { due_kind: "none", due_date: "2026-12-02", due_time: "0:30" }],
      [tokyo, { due_kind: "none", due_date: `${cp(0x200b)}2026-12-02` }],
      [tokyo, { due_kind: "none", due_time: `00:30${cp(0x200b)}` }],
      [tokyo, { due_kind: "none", due_date: "2026-12-02", due_time: "01:30", title: "Changed too" }],
      [dateOnly, { due_kind: "none", due_time: "09:00" }],
      [dateOnly, { due_kind: "date", due_time: "00:00" }],
      [dateOnly, { due_kind: "none", due_date: "2026-12-02" }],
      [none, { due_kind: "none", due_date: "2026-12-01" }],
      [none, { due_kind: "none", due_time: "09:00" }],
      [none, { due_kind: "date", due_date: "2026-12-01", due_time: "09:00" }],
      [mars, { due_kind: "none", due_date: "2026-12-01", due_time: "03:30" }], // the UTC values
      [mars, { due_kind: "none", due_time: "05:30" }],
    ];
    const before = await snapshot();
    for (const [id, over] of cases) {
      const html = await render(id);
      expect(await submitFor(id, html)(over), `${id} ${JSON.stringify(over)}`).toBe(`/tasks/${id}?error=due_kind_mismatch`);
    }
    expect(await snapshot()).toEqual(before);
    // Date with a changed date and the time emptied is the normal path and saves.
    expect(await submitFor(tokyo, await render(tokyo))({ due_kind: "date", due_date: "2026-12-03", due_time: "" })).toBe(`/tasks/${tokyo}?notice=saved`);
    expect(await dueOf(tokyo)).toEqual(["2026-12-03", null, null]);
  });

  it("whitespace around the rendered values is trimmed (space, tab, NBSP, U+3000) and other edits in the same submit are saved and audited once", async () => {
    const ws = [" ", "\t", cp(0xa0), cp(0x3000)];
    let n = 0;
    for (const w of ws) {
      const id = await raw({ dueAt: new Date("2026-12-01T15:30:00Z"), dueTz: "Asia/Tokyo" });
      const html = await render(id);
      expect(await submitFor(id, html)({ due_kind: "none", due_date: `${w}2026-12-02${w}`, due_time: `${w}00:30`, title: `Renamed ${n}`, priority: "high" })).toBe(`/tasks/${id}?notice=saved`);
      const r = await rowOf(id);
      expect([r.title, r.priority, r.dueDate, r.dueAt, r.dueTz]).toEqual([`Renamed ${n}`, "high", null, null, null]);
      const audits = await database.execute(sql`select detail from audit_log where action = 'task.updated' and detail->>'taskId' = ${id}`);
      expect(audits.map((a) => (a as { detail: unknown }).detail)).toEqual([{ taskId: id, fields: ["title", "due", "priority"] }]);
      n++;
    }
    expect(n).toBe(ws.length);
  });

  it("prefill comes only from the database row: forged fields, another task's deadline and another user's task do not help", async () => {
    const none = await raw({});
    const other = await raw({ dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: OWNER }); // shown 2026-12-01 09:00
    const stranger = (await makeUser(database, "someone@example.com")).id;
    const theirs = await raw({ dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: OWNER }, stranger);
    const before = await snapshot();
    const forged = {
      taskId: none,
      title: "Pay invoice",
      notes: "",
      priority: "normal",
      due_kind: "none",
      due_date: "2026-12-01",
      due_time: "09:00",
      prefill: "2026-12-01 09:00",
      prefill_date: "2026-12-01",
      prefill_time: "09:00",
      due_date_prefill: "2026-12-01",
      due_time_prefill: "09:00",
      stored_due_date: "2026-12-01",
      stored_due_time: "09:00",
      defaults: JSON.stringify({ date: "2026-12-01", time: "09:00" }),
      due_tz: OWNER,
      zone: OWNER,
    };
    expect(await redirectOf(actions.updateTaskAction(form(forged)))).toBe(`/tasks/${none}?error=due_kind_mismatch`);
    expect(await redirectOf(actions.updateTaskAction(form({ ...forged, due_kind: "date" })))).toBe(`/tasks/${none}?error=due_kind_mismatch`);
    // Another task's rendered values, posted against a task that has no deadline.
    const htmlOther = await render(other);
    expect(await redirectOf(actions.updateTaskAction(form({ taskId: none, title: "Pay invoice", notes: "", priority: "normal", due_kind: "none", due_date: inputValue(htmlOther, "due_date")!, due_time: inputValue(htmlOther, "due_time")! })))).toBe(
      `/tasks/${none}?error=due_kind_mismatch`,
    );
    // Another user's task with exactly its stored values: not found for this owner, nothing changes.
    expect(await redirectOf(actions.updateTaskAction(form({ taskId: theirs, title: "Pay invoice", notes: "", priority: "normal", due_kind: "none", due_date: "2026-12-01", due_time: "09:00" })))).toBe("/tasks?notice=stale");
    expect(await snapshot()).toEqual(before);
  });

  it("a deadline changed after the page was rendered makes the stale form refuse instead of clearing the new deadline", async () => {
    const variants: [string, Partial<typeof schema.tasks.$inferInsert>][] = [
      ["same date, other time", { dueDate: null, dueAt: new Date("2026-12-01T15:00:00Z"), dueTz: OWNER }],
      ["same instant, other zone (different wall values)", { dueDate: null, dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: "Europe/London" }],
      ["date-only on the same date", { dueDate: "2026-12-01", dueAt: null, dueTz: null }],
      ["date-only on another date", { dueDate: "2026-12-05", dueAt: null, dueTz: null }],
      ["no deadline", { dueDate: null, dueAt: null, dueTz: null }],
    ];
    let n = 0;
    for (const [label, d2] of variants) {
      for (const kind of ["none", "date"]) {
        const id = await raw({ dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: OWNER });
        const html = await render(id); // shown 2026-12-01 09:00
        await database.update(schema.tasks).set(d2).where(eq(schema.tasks.id, id)); // e.g. edited in another tab
        const after = await dueOf(id);
        const before = await snapshot();
        const r = await submitFor(id, html)({ due_kind: kind });
        // Date on a no-deadline row with only the old date left would be a NEW date-only deadline: the
        // stale time is still a leftover the row doesn't pre-fill, so it is refused too.
        expect(r, `${label} / ${kind}`).toBe(`/tasks/${id}?error=due_kind_mismatch`);
        expect(await snapshot(), `${label} / ${kind}`).toEqual(before);
        expect(await dueOf(id)).toEqual(after);
        n++;
      }
    }
    expect(n).toBe(variants.length * 2);

    // When the new deadline renders the same values (a DST-overlap twin), the stale form's values are
    // exactly what the page would show now, so None is accepted: nothing ambiguous is cleared.
    const twin = await raw({ dueAt: new Date("2026-11-01T05:30:00Z"), dueTz: OWNER });
    const htmlTwin = await render(twin);
    await database.update(schema.tasks).set({ dueAt: new Date("2026-11-01T06:30:00Z") }).where(eq(schema.tasks.id, twin));
    expect(shown(await render(twin))).toEqual(shown(htmlTwin));
    expect(await submitFor(twin, htmlTwin)({ due_kind: "none" })).toBe(`/tasks/${twin}?notice=saved`);
    expect(await dueOf(twin)).toEqual([null, null, null]);

    // An unrecognised due_tz is shown in the owner's zone; if the owner's setting changes before the
    // submit, the shown values no longer match and the form is refused (fails closed).
    const mars = await raw({ dueAt: new Date("2026-12-01T03:30:00Z"), dueTz: "Mars/Olympus" });
    const htmlMars = await render(mars);
    expect([inputValue(htmlMars, "due_date"), inputValue(htmlMars, "due_time")]).toEqual(["2026-11-30", "22:30"]);
    await setOwnerZone("Asia/Tokyo");
    const beforeMars = await snapshot();
    expect(await submitFor(mars, htmlMars)({ due_kind: "none" })).toBe(`/tasks/${mars}?error=due_kind_mismatch`);
    expect(await snapshot()).toEqual(beforeMars);
    const htmlMars2 = await render(mars);
    expect([inputValue(htmlMars2, "due_date"), inputValue(htmlMars2, "due_time")]).toEqual(["2026-12-01", "12:30"]);
    expect(await submitFor(mars, htmlMars2)({ due_kind: "none" })).toBe(`/tasks/${mars}?notice=saved`);
  });

  it("observation: a deadline change committed between the action's read and its locked write is overwritten (Q9 last-write-wins, same as before round 3)", async () => {
    const id = await raw({ dueAt: new Date("2026-12-01T14:00:00Z"), dueTz: OWNER });
    const html = await render(id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = poolDb.transaction(async (tx) => {
      await tx.update(schema.tasks).set({ dueAt: new Date("2026-12-01T20:00:00Z") }).where(eq(schema.tasks.id, id));
      locked();
      await gate;
    });
    await isLocked;
    let done = false;
    const submit = submitFor(id, html)({ due_kind: "none" }).then((r) => ((done = true), r));
    await sleep(300);
    // The action read the committed (old) row, parsed against its prefill and is now waiting on the lock.
    expect(done).toBe(false);
    release();
    await holder;
    expect(await submit).toBe(`/tasks/${id}?notice=saved`);
    expect(await dueOf(id)).toEqual([null, null, null]);
  });
});
