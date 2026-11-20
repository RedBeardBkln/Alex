import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Plan Revision 4, AC 18n: the inbox pages must not import, directly or transitively, the
// sanitizer or anything that runs it. Static import graph over repo files (type-only imports are
// erased by TypeScript, so they are skipped).

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "src");

const FORBIDDEN_PACKAGES = ["sanitize-html", "htmlparser2"];
const FORBIDDEN_PACKAGE_PREFIXES = ["@csstools/"];
const FORBIDDEN_FILES = [
  "src/lib/email-html.ts",
  "src/lib/email-css.ts",
  "src/lib/email/render.ts",
  "src/lib/email/render.worker.ts",
  "src/lib/email/plain-text.ts",
].map((f) => path.join(root, f));

/** Module specifiers a file imports at runtime (static, re-export, side-effect and, unless excluded, dynamic). */
function runtimeImports(code: string, dynamic = true): string[] {
  const specs: string[] = [];
  const fromRe = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^;]*?)\bfrom\s*["']([^"']+)["']/g;
  for (let m = fromRe.exec(code); m; m = fromRe.exec(code)) {
    if (m[2]) continue; // `import type` / `export type`
    specs.push(m[4]!);
  }
  const bareRe = /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g;
  for (let m = bareRe.exec(code); m; m = bareRe.exec(code)) specs.push(m[1]!);
  const dynRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  if (dynamic) for (let m = dynRe.exec(code); m; m = dynRe.exec(code)) specs.push(m[1]!);
  return specs;
}

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep) && /\.(ts|tsx)$/.test(candidate)) return candidate;
  }
  return null;
}

type Graph = { files: Set<string>; packages: Map<string, string> };

function importGraph(entry: string, dynamic = true): Graph {
  const files = new Set<string>();
  const packages = new Map<string, string>(); // package -> first importing file
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of runtimeImports(readFileSync(file, "utf8"), dynamic)) {
      if (spec.startsWith("node:")) continue;
      let base: string | null = null;
      if (spec.startsWith("@/")) base = path.join(src, spec.slice(2));
      else if (spec.startsWith(".")) base = path.resolve(path.dirname(file), spec);
      if (base) {
        const resolved = resolveFile(base);
        if (!resolved) throw new Error(`unresolved import ${spec} in ${path.relative(root, file)}`);
        stack.push(resolved);
      } else {
        const parts = spec.split("/");
        const pkg = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
        if (!packages.has(pkg)) packages.set(pkg, path.relative(root, file));
      }
    }
  }
  return { files, packages };
}

// The inbox pages, plus the (app) layout and the server actions it imports: Next bundles the layout
// into every page under it, so its imports end up in the pages' functions too.
const PAGES = [
  "src/app/(app)/inbox/[threadId]/page.tsx",
  "src/app/(app)/inbox/page.tsx",
  "src/app/(app)/layout.tsx",
  "src/app/(app)/actions.ts",
  // Phase 2b: the approval queue pages and their actions (the thread page's reply form imports them too).
  "src/app/(app)/queue/page.tsx",
  "src/app/(app)/queue/[itemId]/page.tsx",
  "src/app/(app)/queue/actions.ts",
  // Phase 2c: the AI usage page and the thread page's AI actions and panel.
  "src/app/(app)/ai-usage/page.tsx",
  "src/app/(app)/inbox/[threadId]/ai-actions.ts",
  "src/app/(app)/inbox/[threadId]/ai-panel.tsx",
  // Phase 2d: the compose page and its form.
  "src/app/(app)/compose/page.tsx",
  "src/app/(app)/compose/compose-form.tsx",
];

describe("18n: inbox pages never reach the sanitizer", () => {
  for (const page of PAGES) {
    it(page, () => {
      const g = importGraph(path.join(root, page));
      const reachedFiles = [...g.files].filter((f) => FORBIDDEN_FILES.includes(f)).map((f) => path.relative(root, f));
      expect(reachedFiles).toEqual([]);
      const reachedPackages = [...g.packages.entries()].filter(
        ([pkg]) => FORBIDDEN_PACKAGES.includes(pkg) || FORBIDDEN_PACKAGE_PREFIXES.some((p) => pkg.startsWith(p)),
      );
      expect(reachedPackages).toEqual([]);
      // Sanity: the walk really followed the imports (each entry reaches some repo module).
      const expected = page.includes("/ai-usage/")
        ? path.join("lib", "ai-ledger", "ledger.ts")
        : page.includes("/inbox/[threadId]/ai-")
          ? path.join("lib", "session.ts")
          : page.includes("/queue/")
        ? path.join("lib", "approvals", "service.ts")
        : page.endsWith("page.tsx")
          ? path.join("lib", "gmail", "store.ts")
          : path.join("lib", "session.ts");
      expect([...g.files].some((f) => f.endsWith(expected))).toBe(true);
    });
  }

  it("the thread page uses the page-safe shell, and the walker does see forbidden imports when present", () => {
    const g = importGraph(path.join(root, "src/app/(app)/inbox/[threadId]/page.tsx"));
    expect([...g.files].some((f) => f.endsWith(path.join("lib", "email", "shell.ts")))).toBe(true);
    // Positive control: the sync engine (ingest side) does reach the renderer.
    const sync = importGraph(path.join(root, "src/lib/gmail/sync.ts"));
    expect([...sync.files].some((f) => f.endsWith(path.join("lib", "email", "render.ts")))).toBe(true);
    const html = importGraph(path.join(root, "src/lib/email-html.ts"));
    expect(html.packages.has("sanitize-html")).toBe(true);
    expect(html.packages.has("@csstools/css-tokenizer")).toBe(true);
  });
});

// Phase 2c AC10: the static import graph of every page, the layout and the actions reaches neither
// the Anthropic SDK nor src/lib/ai/**. (The AI actions load src/lib/ai with a dynamic import, which
// runs only when the owner clicks; the sanitizer check above follows dynamic imports too.)
describe("AC10: pages never statically reach the Anthropic SDK or src/lib/ai", () => {
  const aiDir = path.join(src, "lib", "ai") + path.sep;
  for (const page of PAGES) {
    it(page, () => {
      const g = importGraph(path.join(root, page), false);
      expect([...g.files].filter((f) => f.startsWith(aiDir)).map((f) => path.relative(root, f))).toEqual([]);
      expect([...g.packages.keys()].filter((p) => p.startsWith("@anthropic-ai/"))).toEqual([]);
    });
  }

  it("positive control: the AI actions do reach src/lib/ai through their dynamic import", () => {
    const g = importGraph(path.join(root, "src/app/(app)/inbox/[threadId]/ai-actions.ts"), true);
    expect([...g.files].some((f) => f.startsWith(aiDir))).toBe(true);
    expect(g.packages.has("@anthropic-ai/sdk")).toBe(true);
  });
});
