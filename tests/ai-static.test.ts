import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Phase 2c AC2 and AC10 (static half): the SDK is imported in one file, and AI code can only
// propose (proposeAiReply); it never reaches approve, claim, execute or the Gmail send.

const SRC = path.resolve(import.meta.dirname, "..", "src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sources = files(SRC).map((f) => ({ file: path.relative(SRC, f).replace(/\\/g, "/"), text: code(readFileSync(f, "utf8")) }));
const ai = sources.filter((s) => s.file.startsWith("lib/ai/"));

describe("AI code can only propose (AC2)", () => {
  it("the Anthropic SDK is imported only in src/lib/ai/providers/anthropic.ts", () => {
    expect(sources.filter((s) => /from\s+["']@anthropic-ai\/sdk|import\(\s*["']@anthropic-ai\/sdk/.test(s.text)).map((s) => s.file)).toEqual(["lib/ai/providers/anthropic.ts"]);
  });

  it("src/lib/ai/** imports nothing from approvals/execute, and never uses approve, claim, execute or proposeReply directly", () => {
    expect(ai.length).toBeGreaterThan(5);
    for (const s of ai) {
      expect(s.text, s.file).not.toMatch(/approvals\/execute|approvals\/runtime|approvals\/reconcile/);
      expect(s.text, s.file).not.toMatch(/\b(approveItem|claimItem|approveAndSend|executeClaimed|recordOutcome|proposeReply)\b/);
    }
    expect(ai.filter((s) => /\bproposeAiReply\(/.test(s.text)).map((s) => s.file)).toEqual(["lib/ai/draft.ts"]);
  });

  it("no AI code calls Gmail send or any Gmail API", () => {
    for (const s of ai) expect(s.text, s.file).not.toMatch(/messages\/send|gmail\/send|sendRawMessage|gmail\.googleapis\.com|gmail\/client/);
  });

  it("only proposeAiReply creates source:ai items", () => {
    const svc = sources.find((s) => s.file === "lib/approvals/service.ts")!.text;
    const at = svc.indexOf("export async function proposeAiReply");
    expect(at).toBeGreaterThan(0);
    const body = svc.slice(at, svc.indexOf("\nexport ", at + 10));
    expect(body).toMatch(/proposeReply\([\s\S]*"ai",?\s*\)/);
    expect(body).toMatch(/replyFormDefaults\(ctx, input\.mode\)/);
    const elsewhere = sources.filter((s) => s.file !== "lib/approvals/service.ts" && /source:\s*"ai"|,\s*"ai"\s*\)/.test(s.text) && !s.file.startsWith("app/"));
    expect(elsewhere.map((s) => s.file)).toEqual([]);
  });
});
