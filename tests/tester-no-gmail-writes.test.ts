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

const sources = files(SRC).map((f) => ({ file: path.relative(SRC, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8").replace(/\r\n/g, "\n") })); // CRLF checkouts too (phase-2-followups-1 round 2, O3)

/** Source without line and block comments, so documentation mentioning forbidden calls doesn't count. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Import specifiers of a module (value and type imports separately). */
function imports(text: string): { value: string[]; type: string[] } {
  const value: string[] = [];
  const type: string[] = [];
  for (const m of code(text).matchAll(/import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g)) (m[1] ? type : value).push(m[2]!);
  return { value, type };
}
const callers = (re: RegExp) => sources.filter((s) => re.test(code(s.text))).map((s) => s.file).sort();

describe("Phase 2b: exactly one Gmail send path, behind the approval executor", () => {
  it("messages/send appears only in lib/gmail/send.ts, once, and nothing else builds a send URL", () => {
    expect(callers(/messages\/send/i)).toEqual(["lib/gmail/send.ts"]);
    const send = code(sources.find((s) => s.file === "lib/gmail/send.ts")!.text);
    expect(send.match(/messages\/send/g)).toHaveLength(1);
    // No other spelling of a send endpoint ("/send", "send" as a URL segment, users.messages.send, drafts.send).
    const other = sources.filter((s) => s.file !== "lib/gmail/send.ts" && /["'`/]send["'`/?]|messages\.send|drafts\.send/.test(code(s.text).replace(/from\s+["'][^"']+["']/g, "")));
    expect(other.map((s) => s.file)).toEqual([]);
  });

  it("send.ts is value-imported only by approvals/runtime.ts; sendRawMessage is called only there; the wiring is used only by approveItemAction", () => {
    const valueImporters = sources.filter((s) => imports(s.text).value.some((p) => /gmail\/send$|\.\/send$/.test(p))).map((s) => s.file);
    expect(valueImporters).toEqual(["lib/approvals/runtime.ts"]);
    const typeImporters = sources.filter((s) => imports(s.text).type.some((p) => /gmail\/send$|\.\/send$/.test(p))).map((s) => s.file);
    expect(typeImporters).toEqual(["lib/approvals/execute.ts"]);
    expect(callers(/sendRawMessage\(/)).toEqual(["lib/approvals/runtime.ts", "lib/gmail/send.ts"]);
    expect(callers(/approvalExecutorDeps\(/)).toEqual(["app/(app)/queue/actions.ts", "lib/approvals/runtime.ts"]);
    expect(callers(/approveAndSend\(/)).toEqual(["app/(app)/queue/actions.ts", "lib/approvals/execute.ts"]);
    expect(callers(/executeClaimed\(/)).toEqual(["lib/approvals/execute.ts"]);
    // In actions.ts the executor wiring and approveAndSend appear once each, inside approveItemAction.
    const actions = code(sources.find((s) => s.file === "app/(app)/queue/actions.ts")!.text);
    expect(actions.match(/approveAndSend\(/g)).toHaveLength(1);
    expect(actions.match(/approvalExecutorDeps\(/g)).toHaveLength(1);
    const fn = actions.slice(actions.indexOf("export async function approveItemAction"));
    expect(fn.slice(0, fn.indexOf("\n}\n")).includes("approveAndSend(approvalExecutorDeps()")).toBe(true);
    // In execute.ts: executeClaimed is called once, right after a successful claimItem.
    const exec = code(sources.find((s) => s.file === "lib/approvals/execute.ts")!.text);
    expect(exec.match(/executeClaimed\(deps,/g)).toHaveLength(1);
    expect(exec).toMatch(/const claim = await claimItem\([^)]*\);\s*if \(!claim\) return \{ kind: "not_claimed" \};\s*const outcome = await executeClaimed\(deps, input\.itemId, claim\.executionId\);/);
    // No API route or cron reaches the executor (the cron only reconciles, read-only).
    const routes = sources.filter((s) => /^app\/api\//.test(s.file));
    for (const r of routes) expect(code(r.text), r.file).not.toMatch(/approvals\/(execute|runtime)["'][\s\S]*approvalExecutorDeps|approveAndSend|executeClaimed|sendRawMessage/);
  });

  it("every queue Server Action checks the session and the Origin before doing anything else", () => {
    const actions = code(sources.find((s) => s.file === "app/(app)/queue/actions.ts")!.text);
    const exported = [...actions.matchAll(/export async function (\w+)\(formData: FormData\) \{\n\s*([^\n]+)/g)].map((m) => [m[1], m[2]!.trim()]);
    expect(exported.map(([n]) => n).sort()).toEqual(
      ["approveItemAction", "cancelItemAction", "editItemAction", "markNotSentAction", "proposeReplyAction", "recheckItemAction", "rejectItemAction"],
    );
    for (const [name, first] of exported) expect(first, name).toMatch(/^(const user = await guard\(\);|await simpleAction\()/);
    expect(actions).toMatch(/async function simpleAction\([^)]*\)[^{]*\{\n\s*const user = await guard\(\);/);
    expect(actions).toMatch(/async function guard\(\) \{\n\s*const user = await requireUser\(\);\n\s*if \(!isAllowedOrigin\(\(await headers\(\)\)\.get\("origin"\), env\(\)\.APP_URL\)\) throw new ForbiddenOriginError\(\);/);
    // The only other Server Action module doesn't touch approvals.
    const other = sources.filter((s) => /^["']use server["']/m.test(s.text) && s.file !== "app/(app)/queue/actions.ts");
    for (const o of other) expect(code(o.text), o.file).not.toMatch(/approvals\//);
  });
});

describe("no Gmail write paths (AC 15, narrowed for 2b's one approved send)", () => {
  it("no modify, batchModify, trash, untrash, delete, import, insert, drafts, labels or threads endpoints anywhere", () => {
    const forbidden = [
      /batchModify/i,
      /batchDelete/i,
      /\/modify\b/,
      /\/trash\b/,
      /\/untrash\b/,
      /\/drafts\b/,
      /\/labels\b/,
      /\/threads\b/,
      /messages\/import/i,
      // Phase email-signatures: the `/settings/` ban moved to the narrower settings rule at the end of this file.
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

// Phase email-signatures (coder, per the approved plan step 12): the global `/settings/` ban is
// replaced by this narrower rule. Exactly one settings path in src: the GET of settings/sendAs/ in
// lib/gmail/client.ts (no method, so GET). Any POST, PUT or PATCH to settings fails it.
function settingsProblems(list: { file: string; text: string }[]): string[] {
  const problems: string[] = [];
  const withSettings = list.filter((s) => /\/settings\//.test(code(s.text)));
  if (withSettings.map((s) => s.file).join(",") !== "lib/gmail/client.ts") problems.push(`files: ${withSettings.map((s) => s.file).join(",")}`);
  for (const s of withSettings) {
    const c = code(s.text);
    const hits = c.match(/\/settings\//g) ?? [];
    if (hits.length !== 1) problems.push(`${s.file}: ${hits.length} settings paths`);
    const line = c.split("\n").find((l) => /\/settings\//.test(l)) ?? "";
    if (!/call\("settings\.sendAs\.get", `\$\{GMAIL_BASE\}\/settings\/sendAs\/\$\{encodeURIComponent\(sendAsEmail\)\}`, sendAsSchema\)/.test(line)) problems.push(`${s.file}: not the sendAs GET: ${line.trim()}`);
    if (/method:/.test(line)) problems.push(`${s.file}: settings call has a method`);
  }
  return problems;
}

describe("Gmail settings: one read, no writes (phase email-signatures)", () => {
  it("settings/sendAs/ is read once, with GET, in lib/gmail/client.ts, and no other /settings/ path exists in src", () => {
    expect(settingsProblems(sources)).toEqual([]);
  });

  it("positive controls: a POST, PUT or PATCH to settings, or a second settings path, fails the rule", () => {
    const client = sources.find((s) => s.file === "lib/gmail/client.ts")!;
    for (const method of ["POST", "PUT", "PATCH"]) {
      const text = client.text.replace("sendAsSchema)", `sendAsSchema, { method: "${method}" })`);
      expect(settingsProblems([{ file: client.file, text }]).length, method).toBeGreaterThan(0);
    }
    expect(settingsProblems([...sources, { file: "lib/other.ts", text: 'const u = "/settings/filters";' }]).length).toBeGreaterThan(0);
    expect(settingsProblems([{ file: client.file, text: `${client.text}\nconst x = "/settings/filters";` }]).length).toBeGreaterThan(0);
  });
});
