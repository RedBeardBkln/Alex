import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Phase 2b AC2 (static half): the only Gmail messages.send call site is the executor's sender,
// it is reachable only through approveAndSend -> claimItem -> executeClaimed, and no drafts
// endpoint exists. The runtime half (no send for rows that aren't claimed) is in approval-queue.test.ts.

const SRC = path.resolve(import.meta.dirname, "..", "src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
/** Source without comments, so documentation doesn't count. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sources = files(SRC).map((f) => ({ file: path.relative(SRC, f).replace(/\\/g, "/"), text: code(readFileSync(f, "utf8")) }));
const filesMatching = (re: RegExp) => sources.filter((s) => re.test(s.text)).map((s) => s.file).sort();

describe("no send without approval (AC2, static)", () => {
  it("messages/send appears only in lib/gmail/send.ts", () => {
    expect(filesMatching(/messages\/send/)).toEqual(["lib/gmail/send.ts"]);
  });

  it("no drafts endpoint anywhere", () => {
    expect(filesMatching(/\/drafts\b|drafts\.send|drafts\.create/i)).toEqual([]);
  });

  it("sendRawMessage is wired only into the executor's production deps", () => {
    expect(filesMatching(/\bsendRawMessage\(/)).toEqual(["lib/approvals/runtime.ts", "lib/gmail/send.ts"]);
  });

  it("the sender is called only by the email.send executor, which only executeClaimed runs, which only approveAndSend calls after claimItem", () => {
    const exec = sources.find((s) => s.file === "lib/approvals/execute.ts")!.text;
    expect([...exec.matchAll(/deps\.send\(/g)]).toHaveLength(1);
    expect(filesMatching(/\bdeps\.send\(|\.send\(account/)).toEqual(["lib/approvals/execute.ts"]);
    expect(filesMatching(/\bexecuteClaimed\(/)).toEqual(["lib/approvals/execute.ts"]);
    const approveAndSend = exec.slice(exec.indexOf("export async function approveAndSend"));
    expect(approveAndSend.indexOf("claimItem(")).toBeGreaterThan(0);
    expect(approveAndSend.indexOf("claimItem(")).toBeLessThan(approveAndSend.indexOf("executeClaimed("));
    expect(filesMatching(/\bapproveAndSend\(/)).toEqual(["app/(app)/queue/actions.ts", "lib/approvals/execute.ts"]);
  });

  it("the Gmail read client still has no send (sending lives only in send.ts)", () => {
    const client = sources.find((s) => s.file === "lib/gmail/client.ts")!.text;
    expect(client).not.toMatch(/\/send\b/);
  });
});
