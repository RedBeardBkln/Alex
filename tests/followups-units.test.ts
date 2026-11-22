import { describe, expect, it, vi } from "vitest";
import "./setup-env";
import { readdirSync, readFileSync as readRaw } from "node:fs";
import path from "node:path";
import type { Database } from "@/db";
import { DELETE_ACCOUNT_ATTEMPTS, deleteAccount } from "@/lib/accounts";
import { DRAFT_RESERVED_COST_MICROS, DRAFT_RESERVED_INPUT_TOKENS, TRIAGE_RESERVED_COST_MICROS } from "@/lib/ai-ledger/pricing";
import {
  buildDraftRequest,
  buildTriageRequest,
  capThread,
  DATE_CAP,
  DRAFT_PROMPT_VERSION,
  encodeUntrusted,
  FROM_ADDRESS_CAP,
  MESSAGE_TEXT_CAP,
  SUBJECT_CAP,
  THREAD_TEXT_CAP,
  TRIAGE_PROMPT_VERSION,
} from "@/lib/ai/prompts";
import type { ThreadTextMessage } from "@/lib/ai/types";
import { errorName, recordRecheckFailure, sqlState } from "@/lib/approvals/recheck";
import { isIPv4, linksIn, linksNotInThread } from "@/lib/approvals/warnings";

// phase-2-followups-1 (coder): E4 header caps and encoded budgets, the Disconnect retry, the
// content-free re-check record, the lock-first rule (static), and the widened links warning (S1/N2).

const cp = (n: number) => String.fromCodePoint(n);
const enc = (x: unknown) => encodeUntrusted(x).length;
const msg = (text: string, over: Partial<ThreadTextMessage> = {}): ThreadTextMessage => ({
  source: "inbound_email",
  from_address: "alice@example.org",
  date: "Wed, 19 Nov 2026 10:00:00 +0000",
  subject: "Lunch",
  text,
  ...over,
});
/** Source text with CRLF normalised to LF, so the static checks pass on a core.autocrlf=true (CRLF) checkout too (round 2, O3). */
const readFileSync = (p: string, enc: "utf8") => readRaw(p, enc).replace(/\r\n/g, "\n");
const toolResult = (req: ReturnType<typeof buildDraftRequest>) => {
  for (const m of req.messages) for (const c of m.content) if (c.type === "tool_result") return c.content;
  throw new Error("no tool result");
};
/** Every invariant of AC-E4-1/2 for one draft input. */
function checkDraft(messages: ThreadTextMessage[]) {
  const capped = capThread(messages);
  const content = toolResult(buildDraftRequest({ messages, ownerInstruction: null }));
  expect(content).toBe(encodeUntrusted({ messages: capped }));
  expect(content.length).toBeLessThanOrEqual(THREAD_TEXT_CAP);
  const fields = (m: ThreadTextMessage) => [m.subject ?? "", m.date ?? "", m.from_address ?? "", m.text];
  const inputWellFormed = messages.every((m) => fields(m).every((s) => s.isWellFormed()));
  for (const m of capped) {
    expect(enc(m)).toBeLessThanOrEqual(MESSAGE_TEXT_CAP);
    expect((m.subject ?? "").length).toBeLessThanOrEqual(SUBJECT_CAP);
    expect((m.date ?? "").length).toBeLessThanOrEqual(DATE_CAP);
    expect((m.from_address ?? "").length).toBeLessThanOrEqual(FROM_ADDRESS_CAP);
    // A cut never creates a lone surrogate (inputs that already have one keep it, escaped).
    if (inputWellFormed) for (const s of fields(m)) expect(s.isWellFormed()).toBe(true);
  }
  return capped;
}

describe("E4: headers capped, budgets on the encoded tool result", () => {
  it("10K subjects and dates, 100 and 1,000 messages, empty text: the draft tool result stays within 30,000, each message within 6,000", () => {
    const hostile = (n: number, text = "") => Array.from({ length: n }, (_, i) => msg(text, { subject: "S".repeat(10_000), date: "D".repeat(10_000), from_address: `m${i}@example.org` }));
    for (const n of [1, 100, 1_000]) {
      const c = checkDraft(hostile(n));
      expect(c.length).toBeGreaterThan(0);
      expect(c.every((m) => m.subject === "S".repeat(SUBJECT_CAP) && m.date === "D".repeat(DATE_CAP))).toBe(true);
    }
    // Many tiny messages: every message costs its encoded size, so the count is bounded by the budget.
    const tiny = capThread(Array.from({ length: 5_000 }, () => msg("", { subject: null, date: null, from_address: null })));
    expect(enc({ messages: tiny })).toBeLessThanOrEqual(THREAD_TEXT_CAP);
    expect(tiny.length).toBeLessThan(THREAD_TEXT_CAP / enc(tiny[0]));
  });

  it("<, >, & and quote-heavy subjects and bodies: escapes count (6 units for <>&, 2 for quotes and newlines)", () => {
    for (const ch of ["<", ">", "&", '"', "\n", cp(0)]) {
      const c = checkDraft(Array.from({ length: 20 }, () => msg(ch.repeat(9_000), { subject: ch.repeat(2_000), date: ch.repeat(500) })));
      expect(c.at(-1)!.truncated).toBe(true);
      expect(c.at(-1)!.subject).toBe(ch.repeat(SUBJECT_CAP));
    }
    const t = buildTriageRequest({ message: msg("<".repeat(9_000), { subject: "<".repeat(9_000), date: "&".repeat(9_000), from_address: ">".repeat(9_000) }) });
    const content = (t.messages[2]!.content.find((c) => c.type === "tool_result") as { content: string }).content;
    expect(content.length).toBeLessThanOrEqual(MESSAGE_TEXT_CAP);
    const parsed = JSON.parse(content).message as ThreadTextMessage;
    expect([parsed.subject!.length, parsed.date!.length, parsed.from_address!.length]).toEqual([SUBJECT_CAP, DATE_CAP, FROM_ADDRESS_CAP]);
    expect(parsed.truncated).toBe(true);
  });

  it("astral characters at every cut boundary and in the headers: no cut splits a surrogate pair", () => {
    const noodle = cp(0x1f35c);
    for (let shift = 0; shift < 8; shift++) {
      const text = "a".repeat(shift) + noodle.repeat(5_000);
      const subject = "b".repeat(shift % 2) + noodle.repeat(400);
      const c = checkDraft(Array.from({ length: 8 }, () => msg(text, { subject, date: noodle.repeat(200), from_address: noodle.repeat(300) })));
      for (const m of c) for (const s of [m.text, m.subject!, m.date!, m.from_address!]) expect(s.isWellFormed()).toBe(true);
      const tr = JSON.parse(toolResult(buildTriageRequest({ message: msg(text, { subject }) }) as never)).message as ThreadTextMessage;
      expect(tr.text.isWellFormed() && tr.subject!.isWellFormed()).toBe(true);
    }
  });

  it("lone surrogates (escaped as 6 units by JSON.stringify) and null headers are bounded too", () => {
    const lone = String.fromCharCode(0xd800);
    const c = checkDraft(Array.from({ length: 10 }, () => msg(lone.repeat(9_000), { subject: lone.repeat(900), date: null, from_address: null })));
    expect(c.every((m) => m.date === null && m.from_address === null)).toBe(true);
  });

  it("ordering: newest first into the budget, output oldest first, the newest always included; older ones dropped only once the budget is used", () => {
    const thread = Array.from({ length: 12 }, (_, i) => msg(String.fromCharCode(97 + i).repeat(3_000), { subject: `n${i}` }));
    const c = capThread(thread);
    expect(c.map((m) => m.subject)).toEqual(thread.slice(thread.length - c.length).map((m) => m.subject));
    expect(c.at(-1)!.subject).toBe("n11");
    expect(c.slice(1).every((m) => !m.truncated)).toBe(true);
    // The budget is used up: one more message of even the smallest size wouldn't fit.
    expect(enc({ messages: c }) + 1 + enc(msg("", { subject: null, date: null, from_address: null, truncated: true }))).toBeGreaterThan(THREAD_TEXT_CAP);
    // A thread that fits is passed whole, with only the flag added.
    const small = [msg("hi"), msg("there")];
    expect(capThread(small)).toEqual(small.map((m) => ({ ...m, truncated: false })));
    // Unknown extra fields never reach the model.
    expect(Object.keys(capThread([{ ...msg("x"), extra: "y".repeat(50_000) } as ThreadTextMessage])[0]!)).toEqual(["source", "from_address", "date", "subject", "text", "truncated"]);
    // An already-truncated message keeps its flag.
    expect(capThread([msg("x", { truncated: true })])[0]!.truncated).toBe(true);
  });

  it("assumption B guard: the fixed request parts stay as measured (no messages, 2,000-character instruction)", () => {
    const empty = msg("", { subject: null, date: null, from_address: null });
    const draft = JSON.stringify(buildDraftRequest({ messages: [], ownerInstruction: "x".repeat(2_000) })).length;
    const triage = JSON.stringify(buildTriageRequest({ message: empty })).length;
    expect(draft).toBeLessThanOrEqual(6_000);
    expect(triage).toBeLessThanOrEqual(4_000);
    // The worst attacker-controlled request (as measured by the tester's E3/AC4 check) is far below the reserve's input at 4 characters per token.
    const worst = JSON.stringify(buildDraftRequest({ messages: Array.from({ length: 200 }, () => msg("<".repeat(9_000), { subject: '"'.repeat(9_000) })), ownerInstruction: "x".repeat(2_000) })).length;
    expect(worst / 4).toBeLessThanOrEqual(DRAFT_RESERVED_INPUT_TOKENS);
    expect([DRAFT_RESERVED_COST_MICROS, TRIAGE_RESERVED_COST_MICROS]).toEqual([448_000, 1_312]);
    expect([TRIAGE_PROMPT_VERSION, DRAFT_PROMPT_VERSION]).toEqual(["triage-v1", "draft-v1"]);
  });
});

describe("Disconnect retry on 40P01 (AC-DL-4)", () => {
  const fakeDb = (failures: unknown[]) => {
    let calls = 0;
    const db = {
      delete: () => ({
        where: async () => {
          calls++;
          const f = failures.shift();
          if (f) throw f;
        },
      }),
    } as unknown as Database;
    return { db, calls: () => calls };
  };
  const deadlock = () => Object.assign(new Error("Failed query"), { cause: { code: "40P01" } });

  it("retries only a deadlock, at most DELETE_ACCOUNT_ATTEMPTS times in all, then rethrows", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const pauses: number[] = [];
    const sleep = async (ms: number) => void pauses.push(ms);
    expect(DELETE_ACCOUNT_ATTEMPTS).toBe(3);
    const a = fakeDb([deadlock(), deadlock()]);
    await deleteAccount(a.db, "u", "a", { sleep, random: () => 0.5 });
    expect(a.calls()).toBe(3);
    expect(pauses).toEqual([150, 150]);
    const b = fakeDb([deadlock(), deadlock(), deadlock(), deadlock()]);
    await expect(deleteAccount(b.db, "u", "a", { sleep })).rejects.toMatchObject({ cause: { code: "40P01" } });
    expect(b.calls()).toBe(3);
    // A postgres-js error without a drizzle wrapper (code on the error itself).
    const c = fakeDb([Object.assign(new Error("x"), { code: "40P01" })]);
    await deleteAccount(c.db, "u", "a", { sleep });
    expect(c.calls()).toBe(2);
    // Anything else is not retried.
    for (const other of [Object.assign(new Error("x"), { cause: { code: "40001" } }), new Error("boom")]) {
      const d = fakeDb([other]);
      await expect(deleteAccount(d.db, "u", "a", { sleep })).rejects.toBe(other);
      expect(d.calls()).toBe(1);
    }
    // attempts: 1 turns the retry off.
    const e = fakeDb([deadlock()]);
    await expect(deleteAccount(e.db, "u", "a", { attempts: 1, sleep })).rejects.toMatchObject({ cause: { code: "40P01" } });
    expect(e.calls()).toBe(1);
    // Jitter stays in 50..250 ms.
    const f = fakeDb([deadlock(), deadlock()]);
    const p2: number[] = [];
    await deleteAccount(f.db, "u", "a", { sleep: async (ms) => void p2.push(ms), random: () => 0.999999 });
    expect(p2.every((ms) => ms >= 50 && ms <= 250)).toBe(true);
    expect(quiet.mock.calls.every(([, d]) => Object.keys(d as object).sort().join() === "accountId,attempt")).toBe(true);
    quiet.mockRestore();
  });

  it("the disconnect action calls the retrying (default) form", () => {
    const actions = readFileSync(path.resolve(import.meta.dirname, "..", "src", "app", "(app)", "actions.ts"), "utf8");
    expect(actions).toMatch(/await deleteAccount\(db\(\), user\.id, id\);/);
  });
});

describe("E5: the re-check failure record is content-free (AC-E5-3)", () => {
  it("logs and audits only ids, the stage and a code; an audit failure only logs", async () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a));
    const inserted: unknown[] = [];
    const ok = { insert: () => ({ values: async (v: unknown) => void inserted.push(v) }) } as unknown as Database;
    const secret = "Subject: Pay now at evil.example <alice@example.org>";
    const err = Object.assign(new Error(secret), { cause: { code: "57P01", message: secret } });
    await recordRecheckFailure(ok, { stage: "propose", userId: "u1", accountId: "a1", threadId: "t1", itemId: "i1" }, err);
    expect(inserted).toEqual([{ userId: "u1", accountId: "a1", action: "approval.recheck_failed", detail: { stage: "propose", threadId: "t1", itemId: "i1", code: "57P01" } }]);
    expect(logged).toEqual([["approval re-check failed", { stage: "propose", accountId: "a1", threadId: "t1", itemId: "i1", error: "Error", code: "57P01" }]]);
    // No SQLSTATE: the code is the error's name. The audit insert failing is logged, never thrown.
    const failing = { insert: () => ({ values: async () => Promise.reject(Object.assign(new Error(secret), { code: "08006" })) }) } as unknown as Database;
    logged.length = 0;
    class WeirdError extends Error {
      override name = secret;
    }
    await recordRecheckFailure(failing, { stage: "ingest", userId: "u1", accountId: null, threadId: "t1" }, new WeirdError(secret));
    expect(logged).toEqual([
      ["approval re-check failed", { stage: "ingest", accountId: null, threadId: "t1", itemId: null, error: "unknown", code: null }],
      ["approval re-check audit failed", { stage: "ingest", error: "Error", code: "08006" }],
    ]);
    expect(JSON.stringify(logged)).not.toMatch(/evil|alice|Pay now/);
    expect(sqlState({ code: "ab c" })).toBeNull();
    expect(errorName(new TypeError("x"))).toBe("TypeError");
    spy.mockRestore();
  });
});

describe("lock order: every audited transition locks the account first (AC-DL-1, static)", () => {
  const src = (...p: string[]) => readFileSync(path.resolve(import.meta.dirname, "..", "src", ...p), "utf8");
  /** The first statement in each `.transaction(async (tx) => {` body, comments and blank lines skipped. */
  function firstStatements(text: string) {
    const out: { line: number; first: string }[] = [];
    const lines = text.split("\n");
    lines.forEach((l, i) => {
      if (!/\.transaction\(async \(tx\) => \{\s*$/.test(l)) return;
      let j = i + 1;
      while (j < lines.length && (/^\s*(\/\/.*)?$/.test(lines[j]!))) j++;
      out.push({ line: i + 1, first: lines[j]!.trim() });
    });
    return out;
  }
  // `await lock(...)`, `if (id) await lock(...)`, `if (!(await lock(...))) return …` or `if (id && !(await lock(...))) return …`.
  const locksFirst = (s: string) => /^(?:if \([\w.]+\) |if \(!\(|if \([\w.]+ && !\()?await lockAccountForWrite\(tx, [\w.]+\)(?:;|\)\) return .+;)$/.test(s);

  it("approvals/service.ts: all nine transactions", () => {
    const f = firstStatements(src("lib", "approvals", "service.ts"));
    expect(f).toHaveLength(9);
    expect(f.filter((x) => !locksFirst(x.first))).toEqual([]);
  });

  it("storeMessage, startResync and startDraftCall lock first; the only other transactions are the two out-of-scope sync writes", () => {
    const store = firstStatements(src("lib", "gmail", "store.ts"));
    expect(store.map((x) => locksFirst(x.first))).toEqual([true, false, false]); // storeMessage; changeLabels and deleteStoredMessage (out of scope)
    expect(firstStatements(src("lib", "gmail", "sync.ts")).every((x) => locksFirst(x.first))).toBe(true);
    expect(firstStatements(src("lib", "ai-ledger", "ledger.ts")).every((x) => locksFirst(x.first))).toBe(true);
    // phase-2-followups-2 (O2 and its triage sibling): finishDraftCall, auditForAccount, triageOne and the skipped_cap write.
    expect(firstStatements(src("lib", "ai-ledger", "ledger.ts"))).toHaveLength(2);
    expect(firstStatements(src("lib", "db-locks.ts")).map((x) => locksFirst(x.first))).toEqual([true]);
    expect(firstStatements(src("lib", "ai", "triage.ts")).map((x) => locksFirst(x.first))).toEqual([true, true]);
    // Any new transaction in src must be added to these lists deliberately.
    const counts: Record<string, number> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, name.name);
        if (name.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name.name)) {
          const n = (readFileSync(p, "utf8").match(/\.transaction\(/g) ?? []).length;
          if (n > 0) counts[path.relative(path.resolve(import.meta.dirname, "..", "src"), p).split(path.sep).join("/")] = n;
        }
      }
    };
    walk(path.resolve(import.meta.dirname, "..", "src"));
    expect(counts).toEqual({ "lib/approvals/service.ts": 9, "lib/gmail/store.ts": 3, "lib/gmail/sync.ts": 1, "lib/ai-ledger/ledger.ts": 2, "lib/db-locks.ts": 1, "lib/ai/triage.ts": 2 });
  });

  it("the lock helper takes FOR KEY SHARE on the account row", () => {
    expect(src("lib", "db-locks.ts")).toMatch(/\.for\("key share"\)/);
  });
});

describe("S1/N2: the links warning covers scheme://, //host and bare IPv4", () => {
  const T = "Your statement from bank.example is ready.";
  it("must match (flagged with the stated display)", () => {
    const cases: [string, string][] = [
      ["ftp://files.example.net/invoice.pdf", "ftp://files.example.net/invoice.pdf"],
      ["javascript://evil.example/%0aalert(1)", "javascript://evil.example/%0aalert"], // "(" breaks the token, as for http links
      ["smb://share.evil.example/x", "smb://share.evil.example/x"],
      ["HTTPS://EVIL.EXAMPLE", "https://evil.example"],
      ["Link:https://evil.example/x", "https://evil.example/x"],
      ["ftp://bank.example@evil.example/", "ftp://bank.example@evil.example/"],
      ["ftp://bank.example.evil.example/", "ftp://bank.example.evil.example/"],
      [`ftp://b${cp(0x430)}nk.example/`, `ftp://b${cp(0x430)}nk.example/`],
      ["//evil.example/login", "//evil.example/login"],
      ["//evil.example:8080/x", "//evil.example:8080/x"],
      ["203.0.113.9", "203.0.113.9"],
      ["203.0.113.9/login", "203.0.113.9"],
      ["203.0.113.9:8443/x", "203.0.113.9"],
      ["user@203.0.113.9", "203.0.113.9"],
      ["http://203.0.113.9/", "http://203.0.113.9/"],
      ["http://3405803785/", "http://3405803785/"],
      ["file:///etc/passwd", "file:///etc/passwd"],
      ["x://", "x://"],
      ["1.2.3.4", "1.2.3.4"], // accepted false positive (owner Q8)
      ["See ftp://files.example.net/x.", "ftp://files.example.net/x"], // trailing punctuation dropped
    ];
    const wrong = cases.filter(([body, display]) => JSON.stringify(linksNotInThread(body, T)) !== JSON.stringify([display]));
    expect(wrong.map(([b]) => [b, linksNotInThread(b, T)])).toEqual([]);
  });

  it("must not match: ordinary text is never a link", () => {
    const ordinary = ["Version 1.2.3", "e.g.", "U.S.", "10:30", "ratio 3:1", "and/or", "a/b", "// note", "//TODO", "///", "C:\\Users\\x", "C:/Users/x", "Re: lunch", "Note: see below", "1.2.3.4.5", "256.1.1.1", "1.2.3.999", "01.02.03.04", "[date]", "1://x", "://", "x:/y"];
    expect(ordinary.filter((t) => linksIn(t).length > 0)).toEqual([]);
    const prose = "Thanks for lunch on Tuesday at 12:30! The ratio was 3:1, see p. 4/5 and/or ch. 2.1.3. Re: next steps, e.g. Q3; i.e. soon.";
    expect(linksIn(prose)).toEqual([]);
  });

  it("known hosts: subdomains of a thread domain, the same IP, and thread hosts written in any link form", () => {
    for (const b of ["ftp://files.example.org/x", "//example.org/x", "sftp://example.org"]) expect(linksNotInThread(b, "Hello from example.org"), b).toEqual([]);
    expect(linksNotInThread("203.0.113.9", "Open http://203.0.113.9/ to check")).toEqual([]);
    expect(linksNotInThread("http://203.0.113.9/x", "Server 203.0.113.9")).toEqual([]);
    expect(linksNotInThread("203.0.113.10", "Server 203.0.113.9")).toEqual(["203.0.113.10"]); // IPs match exactly
    expect(linksNotInThread("https://files.example.net/x", "ftp://files.example.net/y")).toEqual([]);
    expect(linksNotInThread("https://files.example.net/x", "//files.example.net/y")).toEqual([]);
    // A scheme link with no host is flagged even if the thread contains the same text.
    expect(linksNotInThread("file:///etc/passwd", "file:///etc/passwd")).toEqual(["file:///etc/passwd"]);
  });

  it("IPv4 octet edges", () => {
    expect(["0.0.0.0", "255.255.255.255", "198.51.100.0", "203.0.113.255"].every(isIPv4)).toBe(true);
    expect(["256.0.0.1", "1.2.3", "1.2.3.4.5", "00.1.1.1", "1.2.3.-1", "1.2.3.4a", "1..2.3", "+1.2.3.4", " 1.2.3.4"].some(isIPv4)).toBe(false);
  });

  // phase-2-followups-3 round 4: an explicit timeout. The per-case bound below is the linearity check;
  // the 11 cases take about 3.6 s in total on main, too close to vitest's 5 s default under full-suite load.
  it("linear time: 1 MB of scheme:// and // repeats, and a long punctuation run", { timeout: 30_000 }, () => {
    const time = (s: string) => {
      const t0 = performance.now();
      linksNotInThread(s, s);
      return performance.now() - t0;
    };
    const base = time("x".repeat(1_000_000));
    // Round 2 (D2): many non-scheme "://" before a real one, and runs of scheme characters between them.
    const adversarial = ["0://".repeat(250_000), "-://".repeat(250_000), "://".repeat(333_000) + "https://evil.test/", "1".repeat(500_000) + "://" + "1".repeat(500_000) + "://x", "a1://".repeat(200_000), ":///".repeat(250_000)];
    for (const s of ["a://".repeat(250_000), "//".repeat(500_000), "a:// ".repeat(200_000), ".".repeat(1_000_000) + "x", "//a".repeat(330_000), ...adversarial]) {
      expect(time(s), s.slice(0, 8)).toBeLessThan(Math.max(2_000, base * 50));
    }
  });
  it("round 2 (D2): a scheme link after a :// with no valid scheme in the same token is still found", () => {
    for (const prefix of ["://", "0://", "-://", "+://", "1.2://", "://://", "9-://0://"]) {
      expect(linksNotInThread(`${prefix}https://evil.example/login`, T), prefix).toEqual(["https://evil.example/login"]);
    }
    // The first valid scheme wins, as before.
    expect(linksIn("ftp://a.example/x://b.example")).toEqual(["ftp://a.example/x://b.example"]);
    // Still no link without any valid scheme.
    expect(linksIn("0://1://-://")).toEqual([]);
  });
});
