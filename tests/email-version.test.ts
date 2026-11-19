import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIN_DISPLAYABLE_SANITIZER_VERSION,
  SANITIZER_DEPENDENCIES,
  SANITIZER_DEPENDENCY_HISTORY,
  SANITIZER_SOURCE_FILES,
  SANITIZER_SOURCE_HASH,
  SANITIZER_VERSION,
} from "@/lib/email/version";

// AC 18o: changing a sanitizer file must come with a conscious SANITIZER_VERSION decision.

const root = path.resolve(import.meta.dirname, "..");

/** sha256 over each listed file (path, NUL, LF-normalized content, NUL), in list order. */
function sanitizerSourceHash(): string {
  const h = createHash("sha256");
  for (const rel of SANITIZER_SOURCE_FILES) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n"));
    h.update("\0");
  }
  return h.digest("hex");
}

// ---- Round 10 (security V1): third-party sanitizer dependencies -----------------------------

/** Directory of package `name` as Node resolves it from `fromDir` (walks up through node_modules). */
function packageDir(name: string, fromDir: string): string {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`cannot resolve ${name} from ${fromDir}`);
  }
}

/** Installed version and lockfile path of each SANITIZER_DEPENDENCIES entry. */
function installedSanitizerDependencies(): Record<string, { version: string; lockPath: string }> {
  const out: Record<string, { version: string; lockPath: string }> = {};
  for (const dep of SANITIZER_DEPENDENCIES) {
    const from = dep.resolveFrom === "." ? root : packageDir(dep.resolveFrom, root);
    const dir = packageDir(dep.name, from);
    const version = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version as string;
    out[dep.name] = { version, lockPath: path.relative(root, dir).split(path.sep).join("/") };
  }
  return out;
}

type History = { version: number; packages: Record<string, string> }[];

/** Why the pins don't hold (empty when they do). Pure, so upgrade scenarios can be simulated. */
function pinProblems(installed: Record<string, string>, history: History, currentVersion: number): string[] {
  const problems: string[] = [];
  const latest = history[history.length - 1];
  if (!latest) return ["SANITIZER_DEPENDENCY_HISTORY is empty"];
  for (let i = 1; i < history.length; i++) {
    if (history[i]!.version <= history[i - 1]!.version) problems.push(`history versions must strictly increase (entry ${i})`);
  }
  if (latest.version !== currentVersion) {
    problems.push(`the last SANITIZER_DEPENDENCY_HISTORY entry is for version ${latest.version}, but SANITIZER_VERSION is ${currentVersion}`);
  }
  for (const [name, version] of Object.entries(installed)) {
    if (latest.packages[name] !== version) {
      problems.push(`${name} is ${version} but SANITIZER_VERSION ${latest.version} was recorded with ${latest.packages[name] ?? "nothing"}: bump SANITIZER_VERSION and append a history entry`);
    }
  }
  for (const name of Object.keys(latest.packages)) if (!(name in installed)) problems.push(`${name} is recorded but not checked`);
  return problems;
}

describe("sanitizer dependency versions (Round 10)", () => {
  it("installed versions match the latest history entry, which is for the current SANITIZER_VERSION", () => {
    const installed = Object.fromEntries(Object.entries(installedSanitizerDependencies()).map(([n, d]) => [n, d.version]));
    expect(pinProblems(installed, SANITIZER_DEPENDENCY_HISTORY, SANITIZER_VERSION)).toEqual([]);
  });

  it("the lockfile resolves the same versions at the same node_modules paths (nested postcss included)", () => {
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
    const installed = installedSanitizerDependencies();
    expect(installed.postcss!.lockPath).toBe("node_modules/sanitize-html/node_modules/postcss");
    for (const [name, { version, lockPath }] of Object.entries(installed)) {
      expect(lock.packages[lockPath]?.version, `${name} at ${lockPath}`).toBe(version);
    }
  });

  it("every listed dependency is resolved and recorded", () => {
    const names = SANITIZER_DEPENDENCIES.map((d) => d.name).sort();
    expect(names).toEqual(["@csstools/css-parser-algorithms", "@csstools/css-tokenizer", "htmlparser2", "postcss", "sanitize-html"]);
    for (const entry of SANITIZER_DEPENDENCY_HISTORY) expect(Object.keys(entry.packages).sort()).toEqual(names);
  });

  it("simulated upgrades of each package fail until SANITIZER_VERSION is bumped with a new entry", () => {
    const current = SANITIZER_DEPENDENCY_HISTORY[SANITIZER_DEPENDENCY_HISTORY.length - 1]!;
    for (const name of Object.keys(current.packages)) {
      const upgraded = { ...current.packages, [name]: `${current.packages[name]}-next` };
      // Upgrade installed, nothing else changed: fails.
      expect(pinProblems(upgraded, SANITIZER_DEPENDENCY_HISTORY, SANITIZER_VERSION).join(" "), name).toMatch(/bump SANITIZER_VERSION/);
      // New entry appended but SANITIZER_VERSION not bumped: fails.
      const appendedSameVersion = [...SANITIZER_DEPENDENCY_HISTORY, { version: current.version, packages: upgraded }];
      expect(pinProblems(upgraded, appendedSameVersion, SANITIZER_VERSION).length, name).toBeGreaterThan(0);
      // Pin updated in a new entry for a higher version, but SANITIZER_VERSION left alone: fails.
      const appended = [...SANITIZER_DEPENDENCY_HISTORY, { version: current.version + 1, packages: upgraded }];
      expect(pinProblems(upgraded, appended, SANITIZER_VERSION).join(" ")).toMatch(/SANITIZER_VERSION is/);
      // New entry and bumped version: passes.
      expect(pinProblems(upgraded, appended, current.version + 1)).toEqual([]);
    }
  });
});

describe("sanitizer versioning", () => {
  it("SANITIZER_SOURCE_HASH matches the sanitizer files", () => {
    const actual = sanitizerSourceHash();
    expect(
      actual,
      `A sanitizer file changed. Decide whether to bump SANITIZER_VERSION (and MIN_DISPLAYABLE_SANITIZER_VERSION for a security fix) in src/lib/email/version.ts, then set SANITIZER_SOURCE_HASH = "${actual}".`,
    ).toBe(SANITIZER_SOURCE_HASH);
  });

  it("versions are positive integers and the display floor never exceeds the current version", () => {
    expect(Number.isInteger(SANITIZER_VERSION) && SANITIZER_VERSION >= 1).toBe(true);
    expect(Number.isInteger(MIN_DISPLAYABLE_SANITIZER_VERSION) && MIN_DISPLAYABLE_SANITIZER_VERSION >= 1).toBe(true);
    expect(MIN_DISPLAYABLE_SANITIZER_VERSION).toBeLessThanOrEqual(SANITIZER_VERSION);
  });
});
