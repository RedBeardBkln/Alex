import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ComponentType, ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Tester additions for phase-0-public-pages (03-test-report.md):
// - the Q5 login footer and the Q6 Accounts notice are rendered and placed as approved;
// - entry points that bypass layouts (Pages Router, a root app/ dir, metadata routes) don't exist;
// - every (app) page still calls requireUser() itself (defense in depth behind the layout);
// - the privacy text's numbers and scope list stay tied to the code (plan risk R4);
// - the Anthropic retention sentence depends on Alex not using a 30-day "Covered Model".

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; name: string | null },
  due: { overdue: 0, today: 0 },
}));

vi.mock("@/lib/session", () => ({
  SESSION_COOKIE: "alex_session",
  currentUser: async () => state.user,
  requireUser: async () => {
    if (!state.user) throw new Error("redirect:/login");
    return state.user;
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/db", async (orig) => ({ ...(await orig<object>()), db: () => ({}) }));
vi.mock("@/lib/accounts", async (orig) => ({ ...(await orig<object>()), listAccounts: async () => [] }));
vi.mock("@/lib/gmail/store", async (orig) => ({ ...(await orig<object>()), mailStatusByAccount: async () => new Map() }));
vi.mock("@/lib/env", async (orig) => ({ ...(await orig<object>()), env: () => ({ GOOGLE_OAUTH_TESTING_MODE: true }) }));
// Phase T: the Accounts page also reads the due-task counts for its banner (plan 9.2).
vi.mock("@/lib/tasks/service", async (orig) => ({ ...(await orig<object>()), countDueForNav: async () => state.due }));
// Phase email-signatures (coder, per the approved plan): the Accounts page also reads the stored signatures.
vi.mock("@/lib/signatures/store", async (orig) => ({ ...(await orig<object>()), signaturesByAccount: async () => new Map() }));

const root = path.resolve(import.meta.dirname, "..");
const appDir = path.join(root, "src", "app");
const rel = (f: string) => path.relative(root, f).replace(/\\/g, "/");
const code = (t: string) => t.replace(/\r/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,:;)])/g, "$1")
    .replace(/\( /g, "(")
    .trim();
}

type Page<P> = { default: (props: P) => Promise<ReactNode> };

describe("Q5 login footer and Q6 Accounts notice", () => {
  it("/login (signed out) renders About, Privacy and Terms links after the sign-in button, and no other new link", async () => {
    state.user = null;
    const { default: LoginPage } = (await import("@/app/login/page")) as Page<{ searchParams: Promise<{ error?: string }> }>;
    const html = renderToStaticMarkup((await LoginPage({ searchParams: Promise.resolve({}) })) as never);
    const nav = html.slice(html.indexOf("<nav"));
    expect(html.indexOf("Sign in with Google")).toBeGreaterThan(0);
    expect(html.indexOf("<nav")).toBeGreaterThan(html.indexOf("Sign in with Google"));
    expect([...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/about", "/privacy", "/terms"]);
    expect(textOf(nav)).toBe("About · Privacy · Terms");
    expect([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/api/auth/google", "/about", "/privacy", "/terms"]);
  });

  it("/login still redirects a signed-in owner to / before rendering the footer", async () => {
    state.user = { id: "u1", email: "owner@example.invalid", name: null };
    const { default: LoginPage } = (await import("@/app/login/page")) as Page<{ searchParams: Promise<{ error?: string }> }>;
    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/");
    state.user = null;
  });

  it.each([
    ["no task banner", { overdue: 0, today: 0 }],
    ["the Phase T due banner shown", { overdue: 2, today: 1 }],
  ])("the Accounts page shows the approved notice with a /privacy link directly above the two Connect buttons (%s)", async (_label, due) => {
    state.user = { id: "u1", email: "owner@example.invalid", name: null };
    state.due = due;
    const { default: AccountsPage } = (await import("@/app/(app)/page")) as Page<{ searchParams: Promise<Record<string, string>> }>;
    const html = renderToStaticMarkup((await AccountsPage({ searchParams: Promise.resolve({}) })) as never);
    state.user = null;
    state.due = { overdue: 0, today: 0 };
    // The banner (plan 9.2) is above the heading, never inside the pinned notice block.
    if (due.overdue + due.today > 0) {
      const banner = html.indexOf("2 tasks overdue · 1 due today");
      expect(banner).toBeGreaterThan(-1);
      expect(banner).toBeLessThan(html.indexOf("Connected accounts"));
    } else {
      expect(html).not.toContain("due today");
      expect(html).not.toContain("overdue");
    }
    const notice =
      // Phase email-signatures (owner Round 2, Q-A): the notice now names the Gmail signature read (plan 9.3).
      "Connecting a Google account lets Alex read its mail (the last 30 days, then new mail) and its Gmail signature, store them here, send the mail to Anthropic's Claude for sorting and for drafts you ask for, and send emails only after you approve them. It also requests Calendar and Drive access; today Calendar is used only to test the connection, and Drive isn't used. See the privacy policy.";
    const start = html.indexOf("<p", html.indexOf("Nothing is sent without your approval.") + 1);
    const p = html.slice(start, html.indexOf("</p>", start) + 4);
    expect(textOf(p)).toBe(notice);
    expect(p).toMatch(/<a href="\/privacy"[^>]*>privacy policy<\/a>/);
    // Directly followed by the Connect buttons' container, and nothing between them.
    const after = html.slice(start + p.length);
    expect(after).toMatch(/^<div[^>]*><a href="\/api\/accounts\/google\/connect\?label=personal"/);
    expect(after).toContain('href="/api/accounts/google/connect?label=business"');
  });

  it("the Accounts page still requires a session", async () => {
    state.user = null;
    const { default: AccountsPage } = (await import("@/app/(app)/page")) as Page<{ searchParams: Promise<Record<string, string>> }>;
    await expect(AccountsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/login");
  });
});

describe("public files have no imports the static walker can't follow", () => {
  it("no dynamic import() or require() in the public files (a template-literal import(`@/db`) is invisible to the graph test)", () => {
    const files = ["about/page.tsx", "privacy/page.tsx", "terms/page.tsx", "layout.tsx", "site-info.ts"].map((f) => `src/app/(public)/${f}`);
    for (const f of [...files, "src/app/layout.tsx"]) {
      expect(code(readFileSync(path.join(root, f), "utf8")), f).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    }
  });
});

describe("no entry point bypasses the (app) layout", () => {
  it("there is no Pages Router directory and no root app/ directory (either would add or replace routes)", () => {
    for (const d of ["pages", "app", "src/pages"]) expect(existsSync(path.join(root, d)), d).toBe(false);
  });

  it("there are no code metadata routes anywhere under src/app (they are route handlers that no layout wraps)", () => {
    const meta = /\/(icon|apple-icon|opengraph-image|twitter-image|sitemap|robots|manifest)\d*\.(ts|tsx|js|jsx|mjs)$/;
    expect(walk(appDir).map(rel).filter((f) => meta.test(f))).toEqual([]);
  });

  it("every page under (app)/ calls requireUser() itself, as well as the layout", () => {
    const pages = walk(path.join(appDir, "(app)"))
      .map(rel)
      .filter((f) => /\/page\.(tsx|ts|jsx|js)$/.test(f));
    // Exact list (Phase T added /settings, /tasks and /tasks/[id], all approved in phase-t-tasks 01a).
    expect([...pages].sort()).toEqual(
      [
        "src/app/(app)/ai-usage/page.tsx",
        "src/app/(app)/compose/page.tsx",
        "src/app/(app)/inbox/[threadId]/page.tsx",
        "src/app/(app)/inbox/page.tsx",
        "src/app/(app)/page.tsx",
        "src/app/(app)/queue/[itemId]/page.tsx",
        "src/app/(app)/queue/page.tsx",
        "src/app/(app)/settings/page.tsx",
        "src/app/(app)/tasks/[id]/page.tsx",
        "src/app/(app)/tasks/page.tsx",
      ].sort(),
    );
    for (const f of pages) expect(code(readFileSync(path.join(root, f), "utf8")), f).toMatch(/await requireUser\(\)/);
  });
});

describe("the privacy text stays tied to the code (plan risk R4)", () => {
  async function privacyText(): Promise<{ html: string; text: string }> {
    const Layout = (await import("@/app/(public)/layout")).default as ComponentType<{ children: ReactNode }>;
    const Privacy = (await import("@/app/(public)/privacy/page")).default as ComponentType;
    const html = renderToStaticMarkup(createElement(Layout, null, createElement(Privacy)));
    return { html, text: textOf(html) };
  }

  it("the <code> scope list is exactly the scopes Alex requests (login + connect)", async () => {
    const { LOGIN_SCOPES, REQUIRED_ACCOUNT_SCOPES } = await import("@/lib/google");
    const { html } = await privacyText();
    const shown = [...html.matchAll(/<code>([^<]+)<\/code>/g)].map((m) => m[1]).sort();
    const requested = [...LOGIN_SCOPES, ...REQUIRED_ACCOUNT_SCOPES.map((s) => s.replace("https://www.googleapis.com/auth/", ""))].sort();
    expect(shown).toEqual(requested);
  });

  it("backfill window, triage window, summary cap, session lifetime and sync interval match the page", async () => {
    const { BACKFILL_DAYS } = await import("@/lib/gmail/sync");
    const { TRIAGE_WINDOW_MS } = await import("@/lib/ai/triage");
    const { SUMMARY_CAP } = await import("@/lib/ai/parse");
    const { text } = await privacyText();
    expect(text).toContain(`reads messages in the Inbox from the last ${BACKFILL_DAYS} days`);
    expect(text).toContain(`New Inbox messages from the last ${TRIAGE_WINDOW_MS / 86_400_000} days`);
    expect(text).toContain(`a summary of up to ${SUMMARY_CAP} characters`);
    const session = code(readFileSync(path.join(root, "src/lib/session.ts"), "utf8"));
    expect(session).toMatch(/SESSION_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000;/);
    expect(text).toContain("that lasts 30 days");
    const crons = (JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] }).crons;
    expect(crons.find((c) => c.path === "/api/cron/gmail-sync")?.schedule).toBe("*/5 * * * *");
    expect(text).toContain("with a check every 5 minutes");
    // Phase email-signatures: the signature read runs in the same 5-minute sync.
    expect(text).toContain("for each connected address (every 5 minutes)");
  });

  it("tripwire: the model ids changed, so re-check the /privacy AI section before shipping", async () => {
    const { TRIAGE_MODEL, DRAFT_MODEL } = await import("@/lib/ai/prompts");
    // A deliberate tripwire, not a correctness check: it fails on ANY model change, harmless or not.
    // The /privacy "AI processing" text was checked on 2026-11-23 against Anthropic's commercial data
    // retention policy and its API-and-data-retention docs page for these two models. If this fails:
    // re-read both pages for the new model, update /privacy (and LAST_UPDATED) if needed, then update
    // the ids here.
    // One known reason it matters: Anthropic's "Covered Models" (Claude Fable 5/5.1/5.2, Claude
    // Mythos 5/5.1/5.2 as of that date) come with "limited data retention and review as a part of
    // our safety work" (commercial policy), which /privacy doesn't describe today ("No person other
    // than the owner reads your messages in Alex" is about Alex, but the AI section would need a line).
    expect([TRIAGE_MODEL, DRAFT_MODEL]).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
  });
});
