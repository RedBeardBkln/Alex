import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

type Installed = { name: string; via: string; version: string; lockPath: string }[];

/**
 * Installed version and lockfile path of each SANITIZER_DEPENDENCIES entry, resolved from `base`
 * along its chain (follow-up G2): each package in `resolveFrom` from the previous one's directory.
 */
function installedSanitizerDependencies(base = root): Installed {
  return SANITIZER_DEPENDENCIES.map((dep) => {
    let from = base;
    for (const step of dep.resolveFrom) from = packageDir(step, from);
    const dir = packageDir(dep.name, from);
    const version = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version as string;
    return { name: dep.name, via: ["(root)", ...dep.resolveFrom].join(" -> "), version, lockPath: path.relative(base, dir).split(path.sep).join("/") };
  });
}

type History = { version: number; packages: Record<string, string> }[];

/** Why the pins don't hold (empty when they do). Pure, so upgrade scenarios can be simulated. */
function pinProblems(installed: Pick<Installed[number], "name" | "via" | "version">[], history: History, currentVersion: number): string[] {
  const problems: string[] = [];
  const latest = history[history.length - 1];
  if (!latest) return ["SANITIZER_DEPENDENCY_HISTORY is empty"];
  for (let i = 1; i < history.length; i++) {
    if (history[i]!.version <= history[i - 1]!.version) problems.push(`history versions must strictly increase (entry ${i})`);
  }
  if (latest.version !== currentVersion) {
    problems.push(`the last SANITIZER_DEPENDENCY_HISTORY entry is for version ${latest.version}, but SANITIZER_VERSION is ${currentVersion}`);
  }
  for (const { name, via, version } of installed) {
    if (latest.packages[name] !== version) {
      problems.push(`${name} (via ${via}) is ${version} but SANITIZER_VERSION ${latest.version} was recorded with ${latest.packages[name] ?? "nothing"}: bump SANITIZER_VERSION and append a history entry`);
    }
  }
  for (const name of Object.keys(latest.packages)) if (!installed.some((d) => d.name === name)) problems.push(`${name} is recorded but not checked`);
  return problems;
}

/** The latest entry's packages as an installed set, each resolved once from the root. */
const asInstalled = (packages: Record<string, string>) => Object.entries(packages).map(([name, version]) => ({ name, via: "(root)", version }));

describe("sanitizer dependency versions (Round 10)", () => {
  it("installed versions match the latest history entry, which is for the current SANITIZER_VERSION", () => {
    expect(pinProblems(installedSanitizerDependencies(), SANITIZER_DEPENDENCY_HISTORY, SANITIZER_VERSION)).toEqual([]);
  });

  it("the lockfile resolves the same versions at the same node_modules paths (nested postcss included)", () => {
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
    const installed = installedSanitizerDependencies();
    expect(installed.find((d) => d.name === "postcss")!.lockPath).toBe("node_modules/sanitize-html/node_modules/postcss");
    for (const { name, via, version, lockPath } of installed) {
      expect(lock.packages[lockPath]?.version, `${name} via ${via} at ${lockPath}`).toBe(version);
    }
  });

  it("every listed dependency is resolved and recorded in the latest entry; the version 1 entry is unchanged", () => {
    const names = [...new Set(SANITIZER_DEPENDENCIES.map((d) => d.name))].sort();
    expect(names).toEqual(["@csstools/css-parser-algorithms", "@csstools/css-tokenizer", "entities", "htmlparser2", "launder", "parse-srcset", "postcss", "sanitize-html"]);
    expect(Object.keys(SANITIZER_DEPENDENCY_HISTORY.at(-1)!.packages).sort()).toEqual(names);
    expect(SANITIZER_DEPENDENCY_HISTORY[0]).toEqual({
      version: 1,
      packages: { "sanitize-html": "2.18.2", htmlparser2: "12.0.0", postcss: "8.5.33", "@csstools/css-tokenizer": "4.0.3", "@csstools/css-parser-algorithms": "4.0.3" },
    });
    expect(SANITIZER_DEPENDENCY_HISTORY.at(-1)).toEqual({
      version: 2,
      packages: {
        "sanitize-html": "2.18.2", htmlparser2: "12.0.0", postcss: "8.5.33", "@csstools/css-tokenizer": "4.0.3", "@csstools/css-parser-algorithms": "4.0.3",
        entities: "8.1.0", "parse-srcset": "1.0.2", launder: "1.7.2",
      },
    });
  });

  it("follow-up G2: the chains resolve where Node resolves them in this install", () => {
    const at = (name: string, via: string) => installedSanitizerDependencies().find((d) => d.name === name && d.via === via)!.lockPath;
    expect(at("entities", "(root) -> sanitize-html -> htmlparser2")).toBe("node_modules/entities");
    expect(at("launder", "(root) -> sanitize-html")).toBe("node_modules/launder");
    expect(at("parse-srcset", "(root) -> sanitize-html")).toBe("node_modules/parse-srcset");
    expect(at("@csstools/css-tokenizer", "(root) -> @csstools/css-parser-algorithms")).toBe("node_modules/@csstools/css-tokenizer");
  });

  it("follow-up G2: a nested copy (a real directory tree) is found through its chain and fails the pin", () => {
    // A throwaway tree shaped like node_modules, outside the repo: the repo's install is never touched.
    const base = mkdtempSync(path.join(tmpdir(), "alex-dep-guard-"));
    try {
      const pkg = (rel: string, version: string) => {
        mkdirSync(path.join(base, rel), { recursive: true });
        writeFileSync(path.join(base, rel, "package.json"), JSON.stringify({ name: rel.split("node_modules/").at(-1), version }));
      };
      const latest = SANITIZER_DEPENDENCY_HISTORY.at(-1)!.packages;
      for (const [name, version] of Object.entries(latest)) pkg(`node_modules/${name}`, version);
      expect(pinProblems(installedSanitizerDependencies(base), SANITIZER_DEPENDENCY_HISTORY, SANITIZER_VERSION)).toEqual([]);
      const nested: [string, string][] = [
        ["node_modules/@csstools/css-parser-algorithms/node_modules/@csstools/css-tokenizer", "@csstools/css-tokenizer"],
        ["node_modules/htmlparser2/node_modules/entities", "entities"],
        ["node_modules/sanitize-html/node_modules/htmlparser2/node_modules/entities", "entities"],
        ["node_modules/sanitize-html/node_modules/launder", "launder"],
        ["node_modules/sanitize-html/node_modules/parse-srcset", "parse-srcset"],
      ];
      for (const [rel, name] of nested) {
        if (rel.startsWith("node_modules/sanitize-html/node_modules/htmlparser2/")) pkg("node_modules/sanitize-html/node_modules/htmlparser2", latest.htmlparser2!);
        pkg(rel, "99.0.0");
        const problems = pinProblems(installedSanitizerDependencies(base), SANITIZER_DEPENDENCY_HISTORY, SANITIZER_VERSION);
        expect(problems.join(" "), rel).toContain(`${name} (via`);
        expect(problems.join(" "), rel).toContain("is 99.0.0");
        rmSync(path.join(base, rel), { recursive: true });
        rmSync(path.join(base, "node_modules/sanitize-html/node_modules"), { recursive: true, force: true });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("simulated upgrades of each package fail until SANITIZER_VERSION is bumped with a new entry", () => {
    const current = SANITIZER_DEPENDENCY_HISTORY[SANITIZER_DEPENDENCY_HISTORY.length - 1]!;
    for (const name of Object.keys(current.packages)) {
      const upgraded = { ...current.packages, [name]: `${current.packages[name]}-next` };
      // Upgrade installed, nothing else changed: fails.
      expect(pinProblems(asInstalled(upgraded), SANITIZER_DEPENDENCY_HISTORY, SANITIZER_VERSION).join(" "), name).toMatch(/bump SANITIZER_VERSION/);
      // New entry appended but SANITIZER_VERSION not bumped: fails.
      const appendedSameVersion = [...SANITIZER_DEPENDENCY_HISTORY, { version: current.version, packages: upgraded }];
      expect(pinProblems(asInstalled(upgraded), appendedSameVersion, SANITIZER_VERSION).length, name).toBeGreaterThan(0);
      // Pin updated in a new entry for a higher version, but SANITIZER_VERSION left alone: fails.
      const appended = [...SANITIZER_DEPENDENCY_HISTORY, { version: current.version + 1, packages: upgraded }];
      expect(pinProblems(asInstalled(upgraded), appended, SANITIZER_VERSION).join(" ")).toMatch(/SANITIZER_VERSION is/);
      // New entry and bumped version: passes.
      expect(pinProblems(asInstalled(upgraded), appended, current.version + 1)).toEqual([]);
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
