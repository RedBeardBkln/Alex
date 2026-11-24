import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ComponentType, ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Phase 0 (public pages): /about, /privacy and /terms are public, static and read no owner data;
// nothing else became public. Plan sections 9 (AC 1-8) and 10.

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "src");
const appDir = path.join(src, "app");
const rel = (f: string) => path.relative(root, f).replace(/\\/g, "/");

const PUBLIC_DIR = "src/app/(public)";
const PAGE_FILES = ["about", "privacy", "terms"].map((p) => `${PUBLIC_DIR}/${p}/page.tsx`);
const PUBLIC_FILES = [...PAGE_FILES, `${PUBLIC_DIR}/layout.tsx`, `${PUBLIC_DIR}/site-info.ts`];
const ENTRIES = [...PAGE_FILES, `${PUBLIC_DIR}/layout.tsx`, "src/app/layout.tsx"];

/** Source with comments removed (same approach as the other static tests; keeps `https://`). */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ---- Static import graph (copied from tests/page-imports.test.ts, plus: CSS is skipped, and every
// specifier is recorded so `next/headers` and `next/navigation` can be told apart from `next`).

function runtimeImports(text: string): string[] {
  const specs: string[] = [];
  const fromRe = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^;]*?)\bfrom\s*["']([^"']+)["']/g;
  for (let m = fromRe.exec(text); m; m = fromRe.exec(text)) {
    if (m[2]) continue; // `import type` / `export type`
    specs.push(m[4]!);
  }
  const bareRe = /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g;
  for (let m = bareRe.exec(text); m; m = bareRe.exec(text)) specs.push(m[1]!);
  const dynRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = dynRe.exec(text); m; m = dynRe.exec(text)) specs.push(m[1]!);
  const requireRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = requireRe.exec(text); m; m = requireRe.exec(text)) specs.push(m[1]!);
  return specs;
}

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.(ts|tsx)$/.test(candidate)) return candidate;
  }
  return null;
}

type Graph = { files: Set<string>; packageSpecs: Set<string>; css: Set<string> };

function importGraph(entries: string[]): Graph {
  const files = new Set<string>();
  const packageSpecs = new Set<string>();
  const css = new Set<string>();
  const stack = entries.map((e) => path.join(root, e));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of runtimeImports(code(readFileSync(file, "utf8")))) {
      if (spec.endsWith(".css")) {
        css.add(spec);
        continue;
      }
      let base: string | null = null;
      if (spec.startsWith("@/")) base = path.join(src, spec.slice(2));
      else if (spec.startsWith(".")) base = path.resolve(path.dirname(file), spec);
      if (base) {
        const resolved = resolveFile(base);
        if (!resolved) throw new Error(`unresolved import ${spec} in ${rel(file)}`);
        stack.push(resolved);
      } else {
        packageSpecs.add(spec);
      }
    }
  }
  return { files, packageSpecs, css };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// ---- Rendering helpers.

/** Visible text of rendered markup: tags removed, the entities React emits decoded, whitespace collapsed. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,:;)])/g, "$1")
    .replace(/\( /g, "(")
    .trim();
}

type PageModule = { default: ComponentType; dynamic?: string; metadata?: { title?: unknown } };

const savedDatabaseUrl = process.env.DATABASE_URL;
const db = globalThis as unknown as { alexDb?: unknown };
const savedDb = db.alexDb;

let Layout: ComponentType<{ children: ReactNode }>;
let pages: Record<"about" | "privacy" | "terms", PageModule>;
let site: { OWNER_CONTACT: string; LAST_UPDATED: string };
const html: Record<string, string> = {};
const text: Record<string, string> = {};

beforeAll(async () => {
  // Any accidental env or database use while importing or rendering would throw.
  delete process.env.DATABASE_URL;
  db.alexDb = undefined;
  Layout = (await import("@/app/(public)/layout")).default;
  pages = {
    about: await import("@/app/(public)/about/page"),
    privacy: await import("@/app/(public)/privacy/page"),
    terms: await import("@/app/(public)/terms/page"),
  };
  site = await import("@/app/(public)/site-info");
  for (const [name, mod] of Object.entries(pages)) {
    html[name] = renderToStaticMarkup(createElement(Layout, null, createElement(mod.default)));
    text[name] = textOf(html[name]!);
  }
});

afterAll(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  db.alexDb = savedDb;
});

describe("public pages render static content with no session or database", () => {
  it("each page exports dynamic = 'error' and its own title", () => {
    expect(pages.about.dynamic).toBe("error");
    expect(pages.privacy.dynamic).toBe("error");
    expect(pages.terms.dynamic).toBe("error");
    expect(pages.about.metadata?.title).toBe("About · Alex");
    expect(pages.privacy.metadata?.title).toBe("Privacy · Alex");
    expect(pages.terms.metadata?.title).toBe("Terms · Alex");
    // Nothing touched the database while importing and rendering.
    expect(db.alexDb).toBeUndefined();
  });

  it("the layout links every public page and the owner sign-in on each page", () => {
    for (const name of ["about", "privacy", "terms"]) {
      for (const href of ["/about", "/privacy", "/terms", "/login"]) expect(html[name], `${name} ${href}`).toContain(`href="${href}"`);
    }
  });

  it("/about describes the app's functions and links the privacy policy and terms (AC 2)", () => {
    const h = html.about!;
    const t = text.about!;
    expect(h).toMatch(/<h1[^>]*>Alex<\/h1>/);
    expect(h).toMatch(/<h2[^>]*>What Alex does<\/h2>/);
    expect(h).toMatch(/<a href="\/privacy"[^>]*>Privacy policy<\/a>/);
    expect(h).toMatch(/<a href="\/terms"[^>]*>Terms of use<\/a>/);
    expect(t).toContain("Alex is a private email assistant.");
    expect(t).toContain("One inbox for several Google accounts.");
    expect(t).toContain("Sorting and summaries.");
    expect(t).toContain("(Anthropic's Claude)");
    expect(t).toContain("Reply drafts and new emails.");
    expect(t).toContain("Nothing is sent without approval.");
    expect(t).toContain("approval queue");
    expect(t).toContain("it doesn't use Drive yet.");
    expect(t).toContain(`Questions: ${site.OWNER_CONTACT}`);
  });

  it("/privacy names every requested scope, has the Limited Use statement and the date (AC 3)", () => {
    const h = html.privacy!;
    const t = text.privacy!;
    expect(h).toMatch(/<h1[^>]*>Privacy policy<\/h1>/);
    for (const scope of ["openid", "email", "profile", "gmail.modify", "calendar.readonly", "calendar.events", "drive.file"]) {
      expect(h, scope).toContain(`<code>${scope}</code>`);
    }
    expect(t).toContain(`Last updated: ${site.LAST_UPDATED}`);
    expect(t).toContain(
      "Alex's use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
    );
    expect(h).toContain('href="https://developers.google.com/terms/api-services-user-data-policy" rel="noreferrer"');
    expect(h).toContain(
      'href="https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes" rel="noreferrer"',
    );
    for (const heading of [
      "What Alex accesses in Google accounts",
      "What Alex stores",
      "AI processing (Anthropic)",
      "Who Alex shares data with",
      "How long Alex keeps data, and how to delete it",
      "Security",
      "Google API Services User Data Policy",
      "Changes and contact",
    ]) {
      expect(h, heading).toContain(`>${heading}</h2>`);
    }
    // Owner decision Q10: the older activity-log sentence stays.
    expect(t).toContain("Entries written before late November 2026 may include email addresses.");
    expect(t).toContain("sends an email only after the owner approves it");
    expect(t).toContain("There's no automatic time limit.");
    expect(t).toContain(`ask to delete their messages at ${site.OWNER_CONTACT}.`);
    // Round 2 owner-approved wording (tester D1, O2-O4).
    expect(t).toContain(
      "Under Anthropic's standard API policy, Anthropic deletes these inputs and outputs within 30 days, and doesn't use them to train models without permission. Anthropic may keep content flagged by its safety systems for up to 2 years, and may keep data longer where the law requires. Alex itself doesn't use any Google data to train AI models.",
    );
    expect(t).not.toContain("aren't kept by default");
    expect(t).toContain("It stores: your sign-in account: email address and name; for each connected account:");
    expect(t).toContain(
      "then messages as they arrive in the Inbox, including older ones moved back into it (through Gmail's new-mail notifications",
    );
    expect(t).toContain(
      "Disconnecting an account in Alex asks Gmail to stop its new-mail notifications, asks Google to revoke Alex's access, and deletes the stored tokens",
    );
    expect(t).not.toContain("Google account ID, email address and name;");
    expect(t).not.toContain("revokes Alex's access at Google");
    // Round 4 owner-approved wording (security B1).
    expect(t).toContain(
      "Server logs hold technical errors; Alex avoids writing message content to them, but an unexpected database error can include the data being saved at that moment.",
    );
    expect(t).not.toContain("Alex is written to keep message content out of them.");
    // Phase T owner-approved wording (plan 11.1, Q11): tasks are stored, and they stay after a Disconnect.
    expect(t).toContain(
      "tasks the owner writes: title, notes, deadline and priority, and the owner's time-zone setting. A task the owner creates from an email starts with that email's subject as its title (the owner can change it) and links to the conversation;",
    );
    expect(t).toContain(
      "Tasks stay: a task created from that account's email loses its link to the conversation but keeps its title, which may be a copy of the email's subject. The owner can delete any task.",
    );
  });

  it("/about lists Tasks (Phase T, owner Q10)", () => {
    expect(text.about).toContain("Tasks. The owner keeps a to-do list in Alex, with deadlines, and can add a task from an email.");
  });

  it("/terms has the date, the privacy link and the contact", () => {
    const h = html.terms!;
    const t = text.terms!;
    expect(h).toMatch(/<h1[^>]*>Terms of use<\/h1>/);
    expect(t).toContain(`Last updated: ${site.LAST_UPDATED}`);
    expect(h).toMatch(/<a href="\/privacy"[^>]*>privacy policy<\/a>/);
    expect(t).toContain("AI can be wrong.");
    expect(t).toContain(`Contact. ${site.OWNER_CONTACT}`);
  });

  it("LAST_UPDATED is a YYYY-MM-DD date", () => {
    expect(site.LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(`${site.LAST_UPDATED}T00:00:00Z`))).toBe(false);
  });

  it("no email address appears on any page except the owner contact (AC 7)", () => {
    const emailLike = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    for (const name of ["about", "privacy", "terms"]) {
      const found = (html[name]!.match(emailLike) ?? []).filter((m) => m !== site.OWNER_CONTACT);
      expect(found, name).toEqual([]);
    }
  });

  it("no forms, scripts or inline event handlers are rendered", () => {
    for (const name of ["about", "privacy", "terms"]) {
      expect(html[name], name).not.toMatch(/<form|<script|<iframe|\son[a-z]+=/i);
    }
  });
});

describe("public files import nothing that can reach owner data (AC 5)", () => {
  const g = importGraph(ENTRIES);

  it("the graph stays inside (public)/ and the root layout, plus CSS", () => {
    const files = [...g.files].map(rel).sort();
    expect(files.filter((f) => !f.startsWith(`${PUBLIC_DIR}/`) && f !== "src/app/layout.tsx")).toEqual([]);
    expect(files).toEqual([...ENTRIES, `${PUBLIC_DIR}/site-info.ts`].sort());
    expect([...g.css]).toEqual(["./globals.css"]);
  });

  it("the only packages are react and next (no next/headers, next/navigation, drizzle-orm or postgres)", () => {
    // `import type { Metadata } from "next"` is erased, so today there are none at all.
    expect([...g.packageSpecs].filter((s) => !["react", "next"].includes(s))).toEqual([]);
  });

  it("positive control: the walker does follow the (app) layout into the session and the database", () => {
    const app = importGraph(["src/app/(app)/layout.tsx"]);
    const files = [...app.files].map(rel);
    expect(files).toContain("src/lib/session.ts");
    expect(files).toContain("src/db/index.ts");
    expect(app.packageSpecs.has("drizzle-orm") || [...app.packageSpecs].some((s) => s.startsWith("drizzle-orm/"))).toBe(true);
  });
});

describe("public sources stay static", () => {
  for (const file of PUBLIC_FILES) {
    it(file, () => {
      const t = code(readFileSync(path.join(root, file), "utf8"));
      expect(t).not.toMatch(/\bcookies\(|\bheaders\(|\bsearchParams\b|\bparams\b|process\.env|["']use (client|server)["']|\bfetch\(|\bawait\b|\basync\b/);
      if (file.endsWith("/page.tsx")) expect(t).toContain('export const dynamic = "error";');
    });
  }

  it("site-info.ts imports nothing", () => {
    expect(runtimeImports(code(readFileSync(path.join(root, PUBLIC_DIR, "site-info.ts"), "utf8")))).toEqual([]);
  });
});

describe("nothing else became public (gating inventory, AC 6)", () => {
  const all = walk(appDir).map(rel);

  it("every page outside (app)/ is exactly the login page and the three public pages", () => {
    const pagesOutside = all.filter((f) => /\/page\.(tsx|ts|jsx|js|mdx|md)$/.test(f) && !f.startsWith("src/app/(app)/"));
    expect(pagesOutside.sort()).toEqual(["src/app/login/page.tsx", ...PAGE_FILES].sort());
  });

  it("every file outside (app)/ and api/ is known (no new layout, not-found, error or template page)", () => {
    const outside = all.filter((f) => !f.startsWith("src/app/(app)/") && !f.startsWith("src/app/api/"));
    expect(outside.sort()).toEqual(
      ["src/app/globals.css", "src/app/layout.tsx", "src/app/local-time.tsx", "src/app/login/page.tsx", ...PUBLIC_FILES].sort(),
    );
  });

  it("there is no (public)/page.tsx, which would take over /", () => {
    for (const ext of ["tsx", "ts", "jsx", "js"]) expect(existsSync(path.join(root, PUBLIC_DIR, `page.${ext}`))).toBe(false);
  });

  it("the (app) layout still calls requireUser() first", () => {
    const t = code(readFileSync(path.join(appDir, "(app)", "layout.tsx"), "utf8"));
    const body = t.slice(t.indexOf("export default async function AppLayout"));
    expect(body).toMatch(/^export default async function AppLayout\([^)]*\)\s*\{\s*const user = await requireUser\(\);/);
  });

  it("there is no middleware or proxy", () => {
    for (const dir of [root, src]) {
      for (const name of ["middleware", "proxy"]) {
        for (const ext of ["ts", "tsx", "js", "mjs"]) expect(existsSync(path.join(dir, `${name}.${ext}`)), `${dir}/${name}.${ext}`).toBe(false);
      }
    }
  });

  it("the route handlers are exactly today's 8", () => {
    const routes = all.filter((f) => /\/route\.(tsx|ts|jsx|js)$/.test(f));
    expect(routes.sort()).toEqual(
      [
        "src/app/api/accounts/google/callback/route.ts",
        "src/app/api/accounts/google/connect/route.ts",
        "src/app/api/auth/google/route.ts",
        "src/app/api/auth/google/callback/route.ts",
        "src/app/api/cron/gmail-sync/route.ts",
        "src/app/api/cron/gmail-watch/route.ts",
        "src/app/api/gmail/push/route.ts",
        "src/app/api/health/route.ts",
      ].sort(),
    );
  });
});

describe("the owner contact lives in one file (AC 7)", () => {
  it("the placeholder and the contact value appear only in site-info.ts", () => {
    const placeholder = ["[OWNER", "CONTACT]"].join(" "); // built, so this file doesn't contain it
    const values = [...new Set([placeholder, site.OWNER_CONTACT])];
    const scanned = [
      ...["src", "tests", "docs", "scripts"].flatMap((d) => walk(path.join(root, d))),
      ...["README.md", "CLAUDE.md", ".env.example", "next.config.ts", "vercel.json"].map((f) => path.join(root, f)).filter((f) => existsSync(f)),
    ].filter((f) => /\.(ts|tsx|js|mjs|md|json|css|example)$/.test(f));
    expect(scanned.length).toBeGreaterThan(50);
    const hits = scanned.filter((f) => {
      const t = readFileSync(f, "utf8");
      return values.some((v) => t.includes(v));
    });
    expect(hits.map(rel)).toEqual([`${PUBLIC_DIR}/site-info.ts`]);
  });
});
