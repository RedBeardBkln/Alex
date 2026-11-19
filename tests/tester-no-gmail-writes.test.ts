import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Tester-added static guard for AC 14 and AC 15: no Gmail write endpoints anywhere in src/, POSTs to
 * Gmail only for watch and stop, and a single attachments call site behind the body-part predicate.
 */

const SRC = path.resolve(import.meta.dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const sources = files(SRC).map((f) => ({ file: path.relative(SRC, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }));

/** Source without line and block comments, so documentation mentioning forbidden calls doesn't count. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("no Gmail write paths (AC 15)", () => {
  it("no send, modify, batchModify, trash, untrash, delete, import, insert, drafts, labels or threads endpoints", () => {
    const forbidden = [
      /messages\/send/i,
      /\/send\b/,
      /batchModify/i,
      /batchDelete/i,
      /\/modify\b/,
      /\/trash\b/,
      /\/untrash\b/,
      /\/drafts\b/,
      /\/labels\b/,
      /\/threads\b/,
      /messages\/import/i,
      /\/settings\//,
      /method:\s*["']DELETE["']/,
      /method:\s*["']PUT["']/,
      /method:\s*["']PATCH["']/,
    ];
    const hits: string[] = [];
    for (const { file, text } of sources) {
      for (const re of forbidden) if (re.test(code(text))) hits.push(`${file}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it("the only POSTs to Gmail are users.watch and users.stop", () => {
    const client = sources.find((s) => s.file === "lib/gmail/client.ts")!;
    const posts = [...code(client.text).matchAll(/call\("([^"]+)",[^\n]*method: "POST"/g)].map((m) => m[1]);
    expect(posts.sort()).toEqual(["stop", "watch"]);
    // No other module talks to gmail.googleapis.com except the Phase 1 read-only profile check.
    const direct = sources.filter((s) => /gmail\.googleapis\.com/.test(code(s.text))).map((s) => s.file).sort();
    expect(direct).toEqual(["lib/gmail/client.ts", "lib/google-api.ts"]);
    const gapi = sources.find((s) => s.file === "lib/google-api.ts")!;
    expect(code(gapi.text)).not.toMatch(/gmail\.googleapis\.com[^"]*\/(send|modify|trash|drafts|labels|threads)/);
  });
});

describe("attachments endpoint (AC 14)", () => {
  it("is defined once in the client and called from exactly one place, right behind isBodyPart", () => {
    const defs = sources.filter((s) => /\/attachments\//.test(code(s.text))).map((s) => s.file);
    expect(defs).toEqual(["lib/gmail/client.ts"]);
    const callers = sources.flatMap((s) =>
      [...code(s.text).matchAll(/\.getBodyPartData\(/g)].map(() => s.file),
    );
    expect(callers).toEqual(["lib/gmail/sync.ts"]);
    const sync = code(sources.find((s) => s.file === "lib/gmail/sync.ts")!.text);
    const at = sync.indexOf(".getBodyPartData(");
    const before = sync.slice(Math.max(0, at - 400), at);
    expect(before).toMatch(/if \(!isBodyPart\(pending\.part\)\) continue;/);
  });
});
