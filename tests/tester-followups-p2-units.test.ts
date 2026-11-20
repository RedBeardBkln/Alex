import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDraftRequest,
  buildTriageRequest,
  capThread,
  capTriageMessage,
  DATE_CAP,
  encodeUntrusted,
  FROM_ADDRESS_CAP,
  MESSAGE_TEXT_CAP,
  SUBJECT_CAP,
  THREAD_TEXT_CAP,
} from "@/lib/ai/prompts";
import type { ThreadTextMessage } from "@/lib/ai/types";
import { linksIn, linksNotInThread } from "@/lib/approvals/warnings";

// Tester, phase-2-followups-1 (no DB): property/fuzz attacks on the E4 budgets and the S1/N2
// links warning. Fixtures use example.com, example.org and .test hosts and 203.0.113.0/24 / 198.51.100.0/24 only.

const enc = (x: unknown) => encodeUntrusted(x).length;
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** A seeded PRNG (mulberry32), so a failure is reproducible from the printed seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "a", "a", "a", " ", "<", ">", "&", "\"", String.fromCharCode(92), "\n", "\r", "\t", String.fromCharCode(0),
  String.fromCharCode(0x85), String.fromCharCode(0x2028), String.fromCharCode(0x7f), "\u00e9", "\u{1F35C}",
  String.fromCharCode(0xd83c), String.fromCharCode(0xdf5c),
];

function str(r: () => number, len: number): string {
  const out: string[] = [];
  let n = 0;
  while (n < len) {
    const p = PIECES[Math.floor(r() * PIECES.length)]!;
    out.push(p);
    n += p.length;
  }
  return out.join("");
}

const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]!;

function randomMessage(r: () => number): ThreadTextMessage {
  const field = (max: number) => (r() < 0.15 ? null : str(r, Math.floor(r() * r() * max)));
  return {
    source: r() < 0.5 ? "inbound_email" : "owner_sent",
    from_address: field(2_000),
    date: field(15_000),
    subject: field(15_000),
    text: r() < 0.2 ? "" : str(r, Math.floor(r() * r() * 20_000)),
    ...(r() < 0.3 ? { truncated: r() < 0.5 } : {}),
  };
}

/** The spec of a header cut: a prefix, at most `max`, maximal except for not splitting a surrogate pair. */
function expectHeaderCut(out: string | null, input: string | null, max: number, where: string) {
  if (input === null) {
    expect(out, where).toBeNull();
    return;
  }
  expect(out, where).not.toBeNull();
  expect(input.startsWith(out!), `${where}: a prefix`).toBe(true);
  expect(out!.length, `${where}: within the cap`).toBeLessThanOrEqual(max);
  if (input.length <= max) expect(out!.length, `${where}: kept whole`).toBe(input.length);
  else {
    // capText never ends a cut on a high surrogate (a pair, or a lone one: dropped either way).
    expect(out!.length, `${where}: maximal cut`).toBe(isHigh(input.charCodeAt(max - 1)) ? max - 1 : max);
  }
}

/** The spec of a text cut: a prefix, never splitting a surrogate pair. */
function expectTextPrefix(out: string, input: string, where: string) {
  expect(input.startsWith(out), `${where}: text is a prefix`).toBe(true);
  if (out.length < input.length && out.length > 0) {
    const splits = isHigh(input.charCodeAt(out.length - 1)) && isLow(input.charCodeAt(out.length));
    expect(splits, `${where}: the cut doesn't split a surrogate pair`).toBe(false);
  }
}

const nextCut = (input: string, len: number) => (isHigh(input.charCodeAt(len)) ? len + 2 : len + 1);

/** Checks every AC-E4 property of capThread's output against its input. */
function checkThread(input: ThreadTextMessage[], out: ThreadTextMessage[], tag: string) {
  expect(enc({ messages: out }), `${tag}: AC-E4-1 thread`).toBeLessThanOrEqual(THREAD_TEXT_CAP);
  if (input.length > 0) expect(out.length, `${tag}: AC-E4-3 the newest is always included`).toBeGreaterThan(0);
  const k = out.length;
  const n = input.length;
  for (let j = 0; j < k; j++) {
    const o = out[j]!;
    const i = input[n - k + j]!; // AC-E4-3: a suffix of the input, oldest first
    const w = `${tag} msg ${j}/${k}`;
    expect(Object.keys(o), `${w}: only the known fields`).toEqual(["source", "from_address", "date", "subject", "text", "truncated"]);
    expect(o.source).toBe(i.source);
    expect(enc(o), `${w}: AC-E4-1 per message`).toBeLessThanOrEqual(MESSAGE_TEXT_CAP);
    expectHeaderCut(o.subject, i.subject, SUBJECT_CAP, `${w} subject`);
    expectHeaderCut(o.date, i.date, DATE_CAP, `${w} date`);
    expectHeaderCut(o.from_address, i.from_address, FROM_ADDRESS_CAP, `${w} from`);
    expectTextPrefix(o.text, i.text, w);
    expect(o.truncated, `${w}: truncated is accurate`).toBe(o.text.length < i.text.length || i.truncated === true);
    // Maximal: one more code point of text would break the per-message or the thread budget for
    // this message and the newer ones (older ones only get what is left).
    if (o.text.length < i.text.length) {
      const longer = { ...o, text: i.text.slice(0, nextCut(i.text, o.text.length)), truncated: true };
      const suffix = [longer, ...out.slice(j + 1)];
      const over = enc(longer) > MESSAGE_TEXT_CAP || enc({ messages: suffix }) > THREAD_TEXT_CAP;
      expect(over, `${w}: the text cut is maximal`).toBe(true);
    }
  }
  if (k < n) {
    // AC-E4-3: the next older message was dropped only because even its header-only form didn't fit.
    const older = input[n - k - 1]!;
    const shaped = capThread([{ ...older, text: "" }], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)[0]!;
    const minimal = { ...shaped, truncated: older.text !== "" || older.truncated === true };
    const left = THREAD_TEXT_CAP - enc({ messages: out }) - 1;
    expect(enc(minimal) > Math.min(MESSAGE_TEXT_CAP, left), `${tag}: an older message was dropped although its headers fit`).toBe(true);
  }
}

describe("tester E4: capThread under random hostile threads", () => {
  it("600 seeded random threads (1–300 messages, escape-heavy headers up to 15K, lone surrogates, astral, C0/C1, U+2028): every AC-E4 property holds", { timeout: 180_000 }, () => {
    let capMs = 0;
    let worstMs = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed);
      const n = pick(r, [1, 1, 2, 3, 5, 8, 20, 60, 300]);
      const input = Array.from({ length: n }, () => randomMessage(r));
      const t0 = performance.now();
      const out = capThread(input);
      const dt = performance.now() - t0;
      capMs += dt;
      worstMs = Math.max(worstMs, dt);
      checkThread(input, out, `seed ${seed}`);
      // The draft request's tool result is exactly this encoding.
      const req = buildDraftRequest({ messages: input, ownerInstruction: null });
      const tr = (req.messages[2]!.content as { type: string; content?: string }[])[0]!;
      expect(tr.content, `seed ${seed}`).toBe(encodeUntrusted({ messages: out }));
    }
    if (process.env.TESTER_SCRATCH) appendFileSync(process.env.TESTER_SCRATCH, `fuzz capThread total=${capMs.toFixed(0)}ms worst=${worstMs.toFixed(1)}ms\n`);
    expect(worstMs, "one capThread call").toBeLessThan(500);
  });

  it("many tiny messages: 10,000 empty messages with null headers, and 3,000 with 1-character headers, stay within 30,000", () => {
    const empty: ThreadTextMessage[] = Array.from({ length: 10_000 }, () => ({ source: "inbound_email", from_address: null, date: null, subject: null, text: "" }));
    const o1 = capThread(empty);
    checkThread(empty, o1, "empty");
    expect(o1.length).toBeGreaterThanOrEqual(290); // not dropped needlessly: ~102 units each
    const tiny: ThreadTextMessage[] = Array.from({ length: 3_000 }, (_, i) => ({ source: "inbound_email", from_address: "<", date: "&", subject: ">", text: i % 2 ? "<" : "" }));
    checkThread(tiny, capThread(tiny), "tiny");
  });

  it("exact header caps: 300, 100 and 254, cut silently (truncated stays about text), never inside a pair", () => {
    const base: ThreadTextMessage = { source: "inbound_email", from_address: null, date: null, subject: null, text: "hi" };
    expect([SUBJECT_CAP, DATE_CAP, FROM_ADDRESS_CAP]).toEqual([300, 100, 254]);
    const at = (field: "subject" | "date" | "from_address", v: string) => capThread([{ ...base, [field]: v }])[0]!;
    for (const [field, cap] of [["subject", 300], ["date", 100], ["from_address", 254]] as const) {
      expect(at(field, "s".repeat(cap))[field]).toBe("s".repeat(cap));
      expect(at(field, "s".repeat(cap + 1))[field]).toBe("s".repeat(cap));
      expect(at(field, "s".repeat(cap + 1)).truncated).toBe(false);
      expect(at(field, "s".repeat(cap - 1) + "\u{1F35C}")[field]).toBe("s".repeat(cap - 1)); // pair at cap-1..cap
      expect(at(field, "s".repeat(cap - 2) + "\u{1F35C}")[field]).toBe("s".repeat(cap - 2) + "\u{1F35C}"); // ends exactly at the cap
      expect(capTriageMessage({ ...base, [field]: "<".repeat(50_000) })[field]).toBe("<".repeat(cap));
    }
  });

  it("the worst header-only message (every header unit a 6-unit escape) fits 6,000 with room for text, so the newest is never dropped", () => {
    const worst: ThreadTextMessage = { source: "owner_sent", from_address: "<".repeat(9_999), date: "&".repeat(9_999), subject: String.fromCharCode(0xd800).repeat(9_999), text: ">".repeat(9_999) };
    const out = capThread([worst]);
    expect(out).toHaveLength(1);
    expect(enc(out[0]!)).toBeLessThanOrEqual(MESSAGE_TEXT_CAP);
    expect(out[0]!.text.length).toBeGreaterThan(250); // (6,000 - ~4,020) / 6
    // A thread of 1,000 worst-case messages: only what fits, newest first.
    const many = Array.from({ length: 1_000 }, () => worst);
    checkThread(many, capThread(many), "worst×1000");
  });
});

describe("tester E4: triage input bound", () => {
  it("600 seeded random triage messages: the tool-result content is at most 6,000 and its message obeys the header caps and a maximal text cut", () => {
    for (let seed = 1_000; seed < 1_600; seed++) {
      const r = rng(seed);
      const message = randomMessage(r);
      const req = buildTriageRequest({ message });
      const content = (req.messages[2]!.content as { type: string; content?: string }[])[0]!.content!;
      expect(content.length, `seed ${seed}`).toBeLessThanOrEqual(MESSAGE_TEXT_CAP);
      const o = capTriageMessage(message);
      expect(content).toBe(encodeUntrusted({ message: o }));
      expectHeaderCut(o.subject, message.subject, SUBJECT_CAP, `seed ${seed} subject`);
      expectHeaderCut(o.date, message.date, DATE_CAP, `seed ${seed} date`);
      expectHeaderCut(o.from_address, message.from_address, FROM_ADDRESS_CAP, `seed ${seed} from`);
      expectTextPrefix(o.text, message.text, `seed ${seed}`);
      expect(o.truncated).toBe(o.text.length < message.text.length || message.truncated === true);
      if (o.text.length < message.text.length) {
        const longer = { ...o, text: message.text.slice(0, nextCut(message.text, o.text.length)), truncated: true };
        expect(enc({ message: longer }), `seed ${seed}: maximal`).toBeGreaterThan(MESSAGE_TEXT_CAP);
      }
    }
  });
});

describe("tester E4: cost of the capping itself", () => {
  it("100 messages of 2 MB text each and 10 MB headers cap in well under a second", () => {
    const big = "x<".repeat(1_000_000);
    const huge = "&".repeat(10_000_000);
    const msgs: ThreadTextMessage[] = Array.from({ length: 100 }, () => ({ source: "inbound_email", from_address: huge, date: huge, subject: huge, text: big }));
    const t0 = performance.now();
    const out = capThread(msgs);
    const ms = performance.now() - t0;
    checkThread(msgs.slice(-out.length - 1), out, "big");
    expect(ms).toBeLessThan(3_000);
  });
});

// ---- S1/N2 ----------------------------------------------------------------------------------------

const THREAD = "Hi, please log in at https://bank.test/login or call. bank.test team";

describe("tester S1: links warning, plan tables and attacks", () => {
  it("the plan's must-match table, one body at a time", () => {
    const rows: [string, string][] = [
      ["ftp://files.evil.test/invoice.pdf", "ftp://files.evil.test/invoice.pdf"],
      ["javascript://evil.test/%0aalert(1)", "javascript://evil.test/%0aalert"],
      ["smb://share.evil.test/x", "smb://share.evil.test/x"],
      ["HTTPS://EVIL.TEST", "https://evil.test"],
      ["Link:https://evil.test/x", "https://evil.test/x"],
      ["ftp://bank.test@evil.test/", "ftp://bank.test@evil.test/"],
      ["ftp://bank.test.evil.test/", "ftp://bank.test.evil.test/"],
      ["ftp://b\u0430nk.test/", "ftp://b\u0430nk.test/"],
      ["//evil.test/login", "//evil.test/login"],
      ["//evil.test:8080/x", "//evil.test:8080/x"],
      ["203.0.113.9", "203.0.113.9"],
      ["203.0.113.9/login", "203.0.113.9"],
      ["203.0.113.9:8443/x", "203.0.113.9"],
      ["user@203.0.113.9", "203.0.113.9"],
      ["http://203.0.113.9/", "http://203.0.113.9/"],
      ["http://3405803785/", "http://3405803785/"],
      ["file:///etc/passwd", "file:///etc/passwd"],
    ];
    for (const [body, shown] of rows) expect(linksNotInThread(`Please see ${body} today.`, THREAD), body).toEqual([shown]);
  });

  it("the plan's must-not-match table: ordinary text is never a link", () => {
    const ordinary = ["Version 1.2.3", "e.g.", "U.S.", "10:30", "ratio 3:1", "and/or", "a/b", "// note", "//TODO", "///", "C:" + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + "x", "C:/Users/x", "Re: lunch", "Note: see below", "1.2.3.4.5", "256.1.1.1", "1.2.3.999", "01.02.03.04", "[date]"];
    for (const t of ordinary) {
      expect(linksIn(t), t).toEqual([]);
      expect(linksNotInThread(`Hello, ${t}, thanks.`, ""), t).toEqual([]);
    }
  });

  it("known hosts: subdomains of a thread domain, thread hosts in any link form, and IPs matching exactly", () => {
    for (const b of ["ftp://files.example.org/x", "//example.org/x", "sftp://example.org", "https://example.org."]) expect(linksNotInThread(b, "see example.org"), b).toEqual([]);
    expect(linksNotInThread("203.0.113.9", "go to http://203.0.113.9/")).toEqual([]);
    expect(linksNotInThread("http://203.0.113.9/x", "203.0.113.9")).toEqual([]);
    expect(linksNotInThread("http://3405803785/", "203.0.113.9")).toEqual([]); // the same address, normalised
    // Exact only: no prefix, suffix or "subnet" matching for IPs.
    for (const b of ["203.0.113.90", "3.0.113.9", "203.0.113.1", "198.51.100.9", "http://203.0.113.99/"]) expect(linksNotInThread(b, "203.0.113.9"), b).toEqual([b]);
    // A thread host written as ftp://, //host or a bare IP counts as known.
    expect(linksNotInThread("https://files.example.org/a", "ftp://files.example.org/b")).toEqual([]);
    expect(linksNotInThread("https://cdn.example.org/a", "//cdn.example.org/b")).toEqual([]);
    expect(linksNotInThread("//198.51.100.7/a", "198.51.100.7:8443")).toEqual([]);
  });

  it("attacks: mixed case, trailing punctuation, percent-encoded and fullwidth hosts, userinfo with : and @", () => {
    const flagged = (b: string) => linksNotInThread(b, THREAD);
    expect(flagged("FtP://EviL.Test/X")).toEqual(["ftp://evil.test/x"]);
    expect(flagged("ftp://evil.test/x.")).toEqual(["ftp://evil.test/x"]);
    expect(flagged("ftp://evil.test/x?!:.")).toEqual(["ftp://evil.test/x"]);
    expect(flagged("203.0.113.9.")).toEqual(["203.0.113.9"]);
    expect(flagged("//evil.test:")).toEqual(["//evil.test"]);
    expect(flagged("ftp://%62ank.test/")).toEqual([]); // decodes to bank.test: the same host
    expect(flagged("ftp://bank%2etest.evil.test/")).toEqual(["ftp://bank%2etest.evil.test/"]);
    expect(flagged("ftp://evil\uff0etest/")).toEqual(["ftp://evil\uff0etest/"]);
    expect(flagged("ftp://bank\uff0etest/")).toEqual([]);
    expect(flagged("ftp://ev\u200bil.test/")).toHaveLength(1);
    expect(flagged("ftp://bank.test:pa@ss@evil.test/")).toHaveLength(1);
    expect(flagged("ftp://user:bank.test@evil.test")).toHaveLength(1);
    expect(flagged("//bank.test@evil.test/")).toHaveLength(1);
    expect(flagged("//bank.test:1@203.0.113.5/")).toHaveLength(1);
    expect(flagged("x://")).toEqual(["x://"]);
    expect(flagged("http://[2001:db8::1]/")).toHaveLength(1);
    // Same host, any scheme: known.
    expect(flagged("ftp://bank.test/x sftp://www.bank.test //bank.test/y")).toEqual([]);
  });

  it("IPv4 octet edges and strictness", () => {
    for (const ip of ["0.0.0.0", "255.255.255.255", "203.0.113.0", "198.51.100.255"]) expect(linksIn(ip), ip).toEqual([ip]);
    for (const no of ["256.0.0.1", "203.0.113.256", "203.0.113", "203.0.113.9.1", "203.0.113.09", "203.0.113.-1", "0x7f.0.0.1", "203.0.113.9e", "+203.0.113.9"]) expect(linksIn(no), no).toEqual([]);
  });

  it("random ordinary prose (words, numbers, times, versions, punctuation) never produces a link", () => {
    const r = rng(42);
    const words = ["the", "a", "lunch", "Note:", "Re:", "e.g.", "i.e.", "10:30", "3:1", "v1.2", "1.2.3", "and/or", "//", "-", "--", "...", "?!", "#3", "50%", "$4.50", "x2", "I'm", "OK.", "U.S.", "Mr.", "p.m.", "9.5", "100.0"];
    for (let i = 0; i < 300; i++) {
      const text = Array.from({ length: 60 }, () => pick(r, words)).join(pick(r, [" ", "\n", ", "]));
      expect(linksIn(text), text).toEqual([]);
    }
  });
});

describe("tester S1: false negatives beyond the plan's tables", () => {
  it("a scheme link that follows a non-scheme '://' in the same token is still flagged", () => {
    // Mail clients autolink the https URL inside these tokens; only the first "://" is examined.
    for (const body of ["://https://evil.test/login", "0://https://evil.test/login", "-://https://evil.test/login"]) {
      expect(linksNotInThread(body, THREAD), body).not.toEqual([]);
    }
  });
});

describe("tester round 2 (D2): the multi-'://' scan", () => {
  it("prefix decoys of every kind before a real link are skipped; the first valid scheme wins; no-scheme-only tokens stay non-links", () => {
    const decoys = ["://", "0://", "-://", "+://", ".://", "1.2://", "://://", "9-://0://", "\u00e9://", "_://", "%://", "0://0://0://"];
    for (const d of decoys) expect(linksNotInThread(`${d}https://evil.test/login`, THREAD), d).toEqual(["https://evil.test/login"]);
    expect(linksNotInThread("1x://https://evil.test/x", THREAD)).toEqual(["x://https://evil.test/x"]); // a letter-led scheme "x", no host: flagged
    expect(linksNotInThread("0://ftp://bank.test/x", THREAD)).toEqual([]); // the real link is to a known host
    expect(linksIn("0://1://-://")).toEqual([]);
    expect(linksIn("10:30://")).toEqual([]);
    expect(linksIn(":// note")).toEqual([]);
  });
});
