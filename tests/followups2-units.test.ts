import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newerDigest } from "@/lib/approvals/service";
import { hostsIn, linksIn, linksNotInThread } from "@/lib/approvals/warnings";
import { errorName, sqlState } from "@/lib/pg-errors";

// phase-2-followups-2 unit tests (no database): SF1 (the links family), the SF2 digest and form
// field, the O2 notice wiring, and N6/N3. The DB side is in followups2-db.test.ts.

const BS = String.fromCharCode(92);
const cp = (n: number) => String.fromCodePoint(n);
const src = (...p: string[]) => readFileSync(path.resolve(import.meta.dirname, "..", "src", ...p), "utf8").replace(/\r\n/g, "\n");

describe("SF1: link forms the warning used to miss (AC-SF1-1)", () => {
  const T = "Your statement from bank.test is ready: https://bank.test/statements";
  it("must flag, with the stated display", () => {
    const cases: [string, string][] = [
      // R1: special schemes with or without slashes, backslashes skipped.
      ["https:evil.test/login", "https:evil.test/login"],
      ["https:/evil.test", "https:/evil.test"],
      [`https:${BS}${BS}evil.test`, `https:${BS}${BS}evil.test`],
      [`http:${BS}evil.test`, `http:${BS}evil.test`],
      ["ws:evil.test", "ws:evil.test"],
      ["wss:evil.test", "wss:evil.test"],
      ["ftp:evil.test", "ftp:evil.test"],
      ["https:///evil.test", "https:///evil.test"],
      // R2: both backslash readings.
      [`smb://bank.test${BS}@evil.test/`, `smb://bank.test${BS}@evil.test/`],
      // R3: no valid scheme before "://".
      ["://evil.test/login", "://evil.test/login"],
      ["_://evil.test/login", "_://evil.test/login"],
      [`${cp(0xe9)}://evil.test/login`, `${cp(0xe9)}://evil.test/login`],
      [`http${cp(0x455)}://evil.test/login`, `http${cp(0x455)}://evil.test/login`],
      // R5: bare hosts with a port, query, fragment or a word and colon before them.
      ["evil.test:8080/login", "evil.test"],
      ["evil.test?x=1", "evil.test"],
      ["evil.test#frag", "evil.test"],
      ["Link:evil.test", "evil.test"],
      ["Server:203.0.113.9", "203.0.113.9"],
      [`http${cp(0x455)}:evil.test`, "evil.test"],
    ];
    const wrong = cases.filter(([body, display]) => JSON.stringify(linksNotInThread(body, T)) !== JSON.stringify([display]));
    expect(wrong.map(([b]) => [b, linksNotInThread(b, T)])).toEqual([]);
  });

  it("candidate collection: every host in a token is checked (owner Q2)", () => {
    expect(linksNotInThread("evil.test/?r=https://bank.test", T)).toEqual(["evil.test"]);
    // One link per token, with every host; flagged because one of them is unknown.
    expect(linksNotInThread("https://bank.test/?next=https://evil.test", T)).toEqual(["https://bank.test/?next=https://evil.test"]);
    expect(linksNotInThread("https://bank.test/?next=https://www.bank.test", T)).toEqual([]);
    expect([...hostsIn("https://a.test/?u=ftp:b.test/&v=x")].sort()).toEqual(["a.test", "b.test"]);
    // WHATWG would read the host "b.test&v=" here (not a domain): the link is host-less, so flagged.
    expect(linksNotInThread("https://a.test/?u=ftp:b.test&v=1", "a.test")).toEqual(["https://a.test/?u=ftp:b.test&v=1"]);
  });

  it("both backslash readings for every scheme (owner Q3)", () => {
    // WHATWG reads the special-scheme form as bank.test; Alex also checks evil.test (more conservative).
    expect(new URL(`https://bank.test${BS}@evil.test/`).hostname).toBe("bank.test");
    expect(linksNotInThread(`https://bank.test${BS}@evil.test/`, T)).toHaveLength(1);
    expect([...hostsIn(`smb://bank.test${BS}@evil.test/`)].sort()).toEqual(["bank.test", "evil.test"]);
    expect(linksNotInThread(`smb://bank.test${BS}x`, T)).toEqual([]);
  });

  it("batch 1's decoy rule still holds: no-scheme `://` decoys don't hide a later link", () => {
    for (const prefix of ["://", "0://", "-://", "_://", "%://", "0://0://0://", `${cp(0xe9)}://`]) {
      expect(linksNotInThread(`${prefix}https://evil.test/login`, T), prefix).toEqual(["https://evil.test/login"]);
    }
    expect(linksIn("0://1://-://")).toEqual([]);
    // R3 keeps an IPv4 host only as a strict dotted quad ("0" alone would be 0.0.0.0 to WHATWG).
    expect(linksIn("0://0")).toEqual([]);
    expect(linksIn("_://203.0.113.9/x")).toEqual(["_://203.0.113.9/x"]);
  });
});

describe("SF1: ordinary prose stays quiet (AC-SF1-2)", () => {
  it("the plan's not-a-link rows", () => {
    const ordinary = [
      "10:30", "10:30am", "3:2", "16:9", "1:1", "e.g.", "i.e.", "a.m.", "Re:", "Fwd:", "Subject:Re:Hi", "javascript:alert(1)", "data:text/plain,hi",
      ":)", ":-)", ":/", `:${BS}`, "D:", "https:", "see http: it", "https:,", `C:${BS}Users${BS}x`, "std::vector", "a::b", "localhost:3000", "10:30://", ":// note",
    ];
    expect(ordinary.filter((t) => linksIn(t).length > 0).map((t) => [t, linksIn(t)])).toEqual([]);
  });

  it("documented edge decisions", () => {
    expect(linksIn("mailto:bob@x.test")).toEqual(["x.test"]);
    expect(linksIn("http:/")).toEqual(["http:/"]); // a special scheme with no host: flagged host-less
    expect(linksIn("HTTP:200")).toEqual(["http:200"]); // WHATWG reads 0.0.0.200
    expect(linksIn("1.2.3.4")).toEqual(["1.2.3.4"]); // batch 1, owner Q8
    expect(linksIn("file.txt:12")).toEqual(["file.txt"]); // the existing isDomain class
    expect(linksIn("http://[2001:db8::1]/")).toEqual(["http://"]); // "[" breaks the token; IPv6 isn't checked (documented limit)
  });

  it("300 seeded random prose strings give no links", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const words = ["the", "lunch", "Note:", "Re:", "Fwd:", "e.g.", "i.e.", "10:30", "3:1", "16:9", "v1.2", "1.2.3", "and/or", "//", "...", ":)", ":-)", "D:", "a::b", "std::move", "x:y", "12:30pm", "$4.50", "U.S.", "p.m."];
    for (let i = 0; i < 300; i++) {
      const text = Array.from({ length: 50 }, () => words[Math.floor(rnd() * words.length)]).join(rnd() < 0.5 ? " " : "\n");
      expect(linksIn(text), text).toEqual([]);
    }
  });
});

describe("SF1: known hosts (AC-SF1-3)", () => {
  it("new forms against a thread with bank.test, and an IP with a port", () => {
    for (const b of ["https:bank.test/x", "ws:sub.bank.test", "bank.test:8080", "https:///bank.test"]) expect(linksNotInThread(b, "Hello from bank.test"), b).toEqual([]);
    expect(linksNotInThread("203.0.113.9:80", "Server 203.0.113.9")).toEqual([]);
  });
  it("a host that appears in the thread only as an R1–R5 candidate counts as known", () => {
    for (const thread of ["see https:evil.test/x", "_://evil.test/", "evil.test:8080", "Link:evil.test", `smb://bank.test${BS}@evil.test/`]) {
      expect(linksNotInThread("https://evil.test/login", thread), thread).toEqual([]);
    }
  });
});

describe("SF1: R1/R2 hosts agree with the WHATWG URL parser", () => {
  it("every host WHATWG finds is one Alex checks", () => {
    const inputs = [
      "https:evil.test/login", "https:/evil.test/login", `https:${BS}${BS}evil.test/login`, `http:${BS}evil.test`, "ws:evil.test", "wss:evil.test", "ftp:evil.test",
      "https:///evil.test", "http:200", `smb://bank.test${BS}@evil.test/`, `https://bank.test${BS}@evil.test/`, "ftp://user:pw@evil.test:21/x", "https://EVIL.test",
    ];
    for (const u of inputs) {
      const host = new URL(u).hostname;
      expect(hostsIn(u).has(host), u).toBe(true);
    }
  });
  it("schemes WHATWG gives no host stay host-less or bare-host only", () => {
    expect(new URL("file:evil.test").hostname).toBe("");
    expect(linksIn("file:evil.test")).toEqual(["evil.test"]); // R5 still names the domain
    expect(linksIn("x:evil.test")).toEqual(["evil.test"]);
  });
});

describe("SF1: linear time (AC-SF1-5, in-process guard; the tester times each case in its own process)", () => {
  const time = (s: string) => {
    const t0 = performance.now();
    linksNotInThread(s, s);
    return performance.now() - t0;
  };
  it("1 MB adversarial tokens stay fast", { timeout: 120_000 }, () => {
    const base = time("x".repeat(1_000_000));
    const cases = [
      "http:".repeat(200_000),
      "https:/".repeat(143_000),
      "a://".repeat(250_000) + "evil.test",
      "http:".repeat(100_000) + "@" + "a".repeat(500_000),
      `${BS}@`.repeat(500_000),
      ":".repeat(1_000_000) + "x",
      "a.b:".repeat(250_000),
      "_://".repeat(250_000),
      "a:".repeat(300_000) + "x".repeat(400_000),
      `https://${"a".repeat(500_000)}${BS}@${"b".repeat(400_000)}`,
      "//" + "a@".repeat(400_000) + "x",
      "http:" + "/".repeat(500_000) + "@".repeat(400_000),
    ];
    for (const s of cases) expect(time(s), s.slice(0, 12)).toBeLessThan(Math.max(2_000, base * 50));
  });
});

describe("SF2: the newer-message digest (owner Q1 option c)", () => {
  it("is empty for none, 64 hex characters otherwise, and order-independent", () => {
    expect(newerDigest([])).toBe("");
    const ids = ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000003"];
    const d = newerDigest(ids);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(newerDigest([...ids].reverse())).toBe(d);
    expect(newerDigest(ids.slice(0, 2))).not.toBe(d);
    expect(ids[0]).toBe("00000000-0000-4000-8000-000000000002"); // the input isn't sorted in place
  });

  it("the approve action parses shownNewer strictly and always passes it; the page sends the view's digest", () => {
    const actions = src("app", "(app)", "queue", "actions.ts");
    expect(actions).toContain('shownNewer: z.string().regex(/^([0-9a-f]{64})?$/).default(""),');
    expect(actions).toContain('shownNewer: field(formData, "shownNewer"),');
    expect(actions).toContain("shownNewer: input.shownNewer,");
    const re = /^([0-9a-f]{64})?$/;
    expect(["", "a".repeat(64)].every((v) => re.test(v))).toBe(true);
    expect(["A".repeat(64), "a".repeat(63), "a".repeat(65), " ", `${"a".repeat(64)}\n`].some((v) => re.test(v))).toBe(false);
    const page = src("app", "(app)", "queue", "[itemId]", "page.tsx");
    expect(page).toContain('<input type="hidden" name="shownNewer" value={view.newerDigest} />');
    expect(page).toContain("const threadChanged = item.threadChangedAt !== null || view.newerCount > 0;");
  });
});

describe("O2: the owner-facing result (AC-O2-6, static)", () => {
  it("draft and triage actions send a disconnect to the Inbox notice; the Inbox shows only allowlisted text", () => {
    const actions = src("app", "(app)", "inbox", "[threadId]", "ai-actions.ts");
    expect(actions).toContain('const ACCOUNT_DISCONNECTED_NOTICE = "/inbox?notice=account_disconnected";');
    expect(actions).toContain('if (!result.ok && (result.code === "account_disconnected" || result.code === "not_found")) redirect(ACCOUNT_DISCONNECTED_NOTICE);');
    expect(actions).toContain('if (outcome === "account_disconnected") redirect(ACCOUNT_DISCONNECTED_NOTICE);');
    const inbox = src("app", "(app)", "inbox", "page.tsx");
    expect(inbox).toContain('Object.hasOwn(NOTICES, params.notice) ? NOTICES[params.notice] : null');
    expect(inbox).not.toMatch(/\{params\.notice\}/);
  });
});

describe("N6 and N3", () => {
  it("one SQLSTATE helper, used by recheck.ts and accounts.ts", () => {
    expect(sqlState({ cause: { code: "40P01" } })).toBe("40P01");
    expect(sqlState({ code: "23503" })).toBe("23503");
    expect(sqlState({ code: "nope" })).toBeNull();
    expect(errorName(new RangeError("secret@example.test"))).toBe("RangeError");
    expect(src("lib", "accounts.ts")).toContain('sqlState(err) !== DEADLOCK_DETECTED');
    expect(src("lib", "accounts.ts")).not.toContain("pgCode");
    expect(src("lib", "approvals", "recheck.ts")).toContain('import { errorName, sqlState } from "@/lib/pg-errors";');
  });

  it("a failed Disconnect is audited with a code only and rethrown", () => {
    const actions = src("app", "(app)", "actions.ts");
    expect(actions).toContain('action: "account.disconnect_failed", detail: { code: sqlState(err) ?? errorName(err) }');
    expect(actions).toMatch(/account\.disconnect_failed[\s\S]*?\n {4}throw err;\n/);
  });
});
