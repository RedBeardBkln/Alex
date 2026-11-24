import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskRow } from "@/lib/tasks/service";

// Phase T render tests (coder): /tasks sections and empty states, the zone banner (AC-TZ-11), the
// allowlisted notices, the Accounts-page banner above an unchanged notice block, the nav badge, a
// date-only deadline under a non-UTC process TZ (AC-TZ-10), the edit page and Settings. The
// session, next/*, the database reads and the other pages' data are mocked.

const ID = "00000000-0000-4000-8000-0000000000a1";
const THREAD = "00000000-0000-4000-8000-0000000000b2";

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "owner@example.invalid", name: null, timeZone: "America/New_York" as string | null },
  rows: [] as unknown[],
  done: [] as unknown[],
  edit: null as unknown,
  due: { overdue: 0, today: 0 },
  truncated: false,
}));

vi.mock("@/lib/session", () => ({ requireUser: async () => state.user, currentUser: async () => state.user }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (u: string) => {
    throw new Error(`REDIRECT ${u}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/db", async (orig) => ({ ...(await orig<object>()), db: () => ({}) }));
vi.mock("@/lib/accounts", async (orig) => ({ ...(await orig<object>()), listAccounts: async () => [] }));
vi.mock("@/lib/gmail/store", async (orig) => ({ ...(await orig<object>()), mailStatusByAccount: async () => new Map() }));
vi.mock("@/lib/approvals/service", async (orig) => ({ ...(await orig<object>()), countNeedingOwner: async () => 0 }));
vi.mock("@/lib/env", async (orig) => ({ ...(await orig<object>()), env: () => ({ GOOGLE_OAUTH_TESTING_MODE: true, APP_URL: "https://alex.example.com/" }) }));
vi.mock("@/lib/tasks/service", async (orig) => {
  const real = await orig<typeof import("@/lib/tasks/service")>();
  return {
    ...real,
    listTasks: async (_ex: unknown, _u: string, now: Date, zone: string) => ({ groups: real.groupTasks(state.rows as TaskRow[], now, zone), truncated: state.truncated }),
    listDoneTasks: async () => state.done,
    getTaskForEdit: async () => state.edit,
    countDueForNav: async () => state.due,
  };
});

type Page<P> = { default: (props: P) => Promise<ReactNode> };
const TasksPage = ((await import("@/app/(app)/tasks/page")) as unknown as Page<{ searchParams: Promise<Record<string, string>> }>).default;
const TaskPage = ((await import("@/app/(app)/tasks/[id]/page")) as unknown as Page<{ params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }>).default;
const SettingsPage = ((await import("@/app/(app)/settings/page")) as unknown as Page<{ searchParams: Promise<Record<string, string>> }>).default;
const AccountsPage = ((await import("@/app/(app)/page")) as unknown as Page<{ searchParams: Promise<Record<string, string>> }>).default;
const AppLayout = ((await import("@/app/(app)/layout")) as unknown as Page<{ children: ReactNode }>).default;

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .replace(/ ([.,:;)])/g, "$1")
    .replace(/\( /g, "(")
    .trim();
const render = async (el: Promise<ReactNode>) => renderToStaticMarkup((await el) as never);
const tasksPage = (q: Record<string, string> = {}) => render(TasksPage({ searchParams: Promise.resolve(q) }));

function row(over: Partial<TaskRow>): TaskRow {
  return {
    id: ID,
    title: "Task",
    notes: null,
    status: "open",
    priority: "normal",
    dueDate: null,
    dueAt: null,
    dueTz: null,
    completedAt: null,
    source: "manual",
    sourceThreadId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    threadSubject: null,
    threadExists: false,
    ...over,
  };
}
const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};

const savedTz = process.env.TZ;
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

beforeEach(() => {
  state.user = { id: "u1", email: "owner@example.invalid", name: null, timeZone: "America/New_York" };
  state.rows = [];
  state.done = [];
  state.edit = null;
  state.due = { overdue: 0, today: 0 };
  state.truncated = false;
});

describe("/tasks", () => {
  it("empty: the form, 'No open tasks', no section headings, no zone banner when the zone is set", async () => {
    const h = await tasksPage();
    const t = text(h);
    expect(t).toContain("New task");
    expect(t).toContain("No open tasks.");
    expect(t).toContain("Time zone: America/New_York");
    for (const s of ["Suggested", "Overdue", "Today", "Upcoming", "Later", "No date"]) expect(h).not.toContain(`>${s}</h2>`);
    expect(t).not.toContain("Alex is using UTC");
    expect(h).toContain('name="due_kind"');
  });

  it("sections render in order, only when non-empty; email rows link the conversation or say it's gone", async () => {
    state.rows = [
      row({ id: "a", title: "Old bill", dueDate: day(-3), priority: "high" }),
      row({ id: "b", title: "Today thing", dueDate: day(0), source: "email", sourceThreadId: THREAD, threadExists: true, threadSubject: "Re: Invoice" }),
      row({ id: "c", title: "Soon", dueDate: day(3), source: "email", sourceThreadId: null, threadExists: false }),
      row({ id: "d", title: "Far", dueDate: day(40), priority: "low" }),
      row({ id: "e", title: "Whenever" }),
      row({ id: "s", title: "Suggested one", status: "suggested" }),
    ];
    const h = await tasksPage();
    const t = text(h);
    const order = ["Suggested", "Overdue", "Today", "Upcoming", "Later", "No date"].map((s) => h.indexOf(`>${s}</h2>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(t).not.toContain("No open tasks.");
    expect(h).toContain(`href="/inbox/${THREAD}"`);
    expect(t).toContain("From an email: Open the conversation (Re: Invoice)");
    expect(t).toContain("From an email (no longer in Alex)");
    expect(t).toContain("Accept");
    expect(t).toContain("Dismiss");
    expect(h).toContain(">High</span>");
    expect(h).toContain(">Low</span>");
    expect((h.match(/>Complete</g) ?? []).length).toBe(5);
    expect(h).toContain(`href="/tasks/a"`);
  });

  it("the zone banner: not set, and a stored zone the runtime rejects (AC-TZ-11)", async () => {
    state.user = { ...state.user, timeZone: null };
    expect(text(await tasksPage())).toContain("Your time zone isn't set, so Alex is using UTC. Set it in Settings.");
    state.user = { ...state.user, timeZone: "Not/AZone" };
    state.rows = [row({ dueDate: "2026-03-08" })];
    const t = text(await tasksPage());
    expect(t).toContain("Alex doesn't recognise your saved time zone, so it is using UTC.");
    expect(t).toContain("Time zone: UTC");
  });

  it("notices and errors only for allowlisted keys", async () => {
    expect(text(await tasksPage({ notice: "saved" }))).toContain("Saved.");
    expect(text(await tasksPage({ notice: "stale" }))).toContain("That task has changed or no longer exists");
    const unknown = await tasksPage({ notice: "<b>hi</b>", error: "toString" });
    expect(unknown).not.toContain("role=\"status\"");
    expect(unknown).not.toContain("role=\"alert\"");
    expect(unknown).not.toContain("hi</b>");
    expect(text(await tasksPage({ error: "time_in_gap" }))).toContain("That time doesn't exist on that day in America/New_York because of the clock change.");
    expect(text(await tasksPage({ error: "due_kind_mismatch" }))).toContain("The deadline choice doesn't match the fields filled in.");
  });

  it("Done view lists completed tasks with Reopen", async () => {
    state.done = [row({ id: "x", title: "Finished", status: "done", completedAt: new Date() })];
    const h = await tasksPage({ view: "done" });
    expect(text(h)).toContain("Finished");
    expect(h).toContain(">Reopen<");
    expect(h).not.toContain("New task");
    state.done = [];
    expect(text(await tasksPage({ view: "done" }))).toContain("No tasks completed in the last 30 days.");
  });

  it("a date-only deadline renders as its own date under TZ=America/Los_Angeles (AC-TZ-10)", async () => {
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(480);
      state.user = { ...state.user, timeZone: "UTC" };
      state.rows = [row({ dueDate: "2099-03-08", title: "Far one" })];
      expect(text(await tasksPage())).toContain("Due Sun, Mar 8, 2099");
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });
});

describe("/tasks/[id]", () => {
  it("unknown or malformed ids are notFound", async () => {
    await expect(TaskPage({ params: Promise.resolve({ id: "nope" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
    await expect(TaskPage({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
  });
  it("an open date-time task edits in its own zone and shows both times", async () => {
    state.edit = row({ title: "Call", dueAt: new Date("2026-03-10T13:00:00Z"), dueTz: "Europe/London" });
    const h = await render(TaskPage({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve({}) }));
    const t = text(h);
    expect(t).toContain("Due Tue, Mar 10, 2026, 13:00 (UTC+00:00) Europe/London = 09:00 in America/New_York");
    expect(h).toContain('value="2026-03-10"');
    expect(h).toContain('value="13:00"');
    expect(t).toContain("Time zone: Europe/London (this task's zone; to use America/New_York, choose None and save, then enter the deadline again)");
    expect(t).toContain("Yes, delete this task");
    expect(h).toContain(">Complete<");
  });
  it("a suggestion is read-only with Accept, Dismiss and Delete", async () => {
    state.edit = row({ status: "suggested", notes: "line 1\nline 2" });
    const h = await render(TaskPage({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve({}) }));
    expect(h).not.toContain('name="title"');
    expect(h).toContain(">Accept<");
    expect(h).toContain(">Dismiss<");
    expect(h).toContain(">Delete<");
    expect(h).toContain('dir="auto"');
  });
});

describe("Accounts page banner and the nav badge (owner Q12)", () => {
  it("the banner sits above the heading; the notice is still directly above the Connect buttons", async () => {
    state.due = { overdue: 2, today: 1 };
    const h = await render(AccountsPage({ searchParams: Promise.resolve({}) }));
    expect(text(h)).toContain("2 tasks overdue · 1 due today → Tasks");
    expect(h.indexOf("2 tasks overdue")).toBeLessThan(h.indexOf("Connected accounts"));
    const start = h.indexOf("<p", h.indexOf("Nothing is sent without your approval.") + 1);
    const p = h.slice(start, h.indexOf("</p>", start) + 4);
    expect(text(p)).toMatch(/^Connecting a Google account lets Alex read its mail/);
    expect(h.slice(start + p.length)).toMatch(/^<div[^>]*><a href="\/api\/accounts\/google\/connect\?label=personal"/);
    state.due = { overdue: 0, today: 1 };
    expect(text(await render(AccountsPage({ searchParams: Promise.resolve({}) })))).toContain("1 task due today → Tasks");
    state.due = { overdue: 0, today: 0 };
    expect(text(await render(AccountsPage({ searchParams: Promise.resolve({}) })))).not.toContain("due today");
  });
  it("the badge counts overdue + today, in the danger colour when anything is overdue; Settings is linked", async () => {
    state.due = { overdue: 1, today: 2 };
    let h = await render(AppLayout({ children: null }));
    expect(h).toContain('aria-label="3 due"');
    expect(h).toMatch(/bg-\[var\(--danger\)\][^>]*aria-label="3 due"/);
    expect(h).toContain('href="/settings"');
    expect(h).toContain('href="/tasks"');
    state.due = { overdue: 0, today: 2 };
    h = await render(AppLayout({ children: null }));
    expect(h).toMatch(/bg-\[var\(--accent\)\][^>]*aria-label="2 due"/);
    state.due = { overdue: 0, today: 0 };
    expect(await render(AppLayout({ children: null }))).not.toContain(" due\"");
  });
});

describe("/settings", () => {
  it("offers UTC and the runtime's zones with the current one selected; says when it isn't set", async () => {
    let h = await render(SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(h).toContain('<option value="UTC">UTC</option>');
    expect(h).toMatch(/<option value="America\/New_York" selected="">/);
    expect(text(h)).toContain("Alex uses America/New_York for task deadlines");
    state.user = { ...state.user, timeZone: null };
    h = await render(SettingsPage({ searchParams: Promise.resolve({ notice: "saved", error: "nope" }) }));
    expect(text(h)).toContain("Your time zone isn't set, so Alex is using UTC.");
    expect(text(h)).toContain("Time zone saved.");
    expect(h).not.toContain('role="alert"');
  });
});
