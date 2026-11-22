import { describe, expect, it } from "vitest";
import { hostsIn, linksIn, linksNotInThread } from "@/lib/approvals/warnings";

// Tester, phase-2-followups-2 (no database): SF1 linear time with many distinct hosts in one token
// (the case the coder's guard doesn't build), plus extra must-flag / must-not-flag / known forms.

const BS = String.fromCharCode(92);
const distinct = (f: (i: number) => string, total: number) => {
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; len < total; i++) {
    const p = f(i);
    parts.push(p);
    len += p.length;
  }
  return parts.join("");
};
const timeIt = (fn: () => unknown) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe("SF1 linear time: one token with many distinct scheme hosts (AC-SF1-5)", () => {
  // Each `scheme:` in the token adds a different host to the merged link. 1 MB, < 2 s each (plan bound),
  // both as the draft body and as the thread haystack (inbound mail is attacker-controlled and uncapped).
  const cases: [string, (i: number) => string][] = [
    ["https://hN.test/ repeated", (i) => `https://h${i}.test/`],
    ["http:hN.test/ repeated", (i) => `http:h${i}.test/`],
    ["x://hN.test/ repeated", (i) => `x://h${i}.test/`],
    ["_://hN.test/ repeated", (i) => `_://h${i}.test/`],
    ["https://hN.test (no separator) repeated", (i) => `https://h${i}.test`],
    [`smb://aN.test${BS}@bN.test repeated`, (i) => `smb://a${i}.test${BS}@b${i}.test`],
  ];
  for (const [name, f] of cases) {
    it(`${name}: body and haystack under 2 s at 1 MB`, { timeout: 180_000 }, () => {
      const s = distinct(f, 1_000_000);
      expect(s.length).toBeGreaterThanOrEqual(1_000_000);
      let flagged: string[] = [];
      const body = timeIt(() => (flagged = linksNotInThread(s, "see https://bank.test/")));
      expect(flagged.length).toBeGreaterThan(0);
      let n = 0;
      const hay = timeIt(() => (n = hostsIn(s).size));
      expect(n).toBeGreaterThan(1_000);
      expect(body, `${name} as body`).toBeLessThan(2_000);
      expect(hay, `${name} as haystack`).toBeLessThan(2_000);
    });
  }
});

describe("SF1: extra forms (tester)", () => {
  const T = "Your statement from bank.test is ready: https://bank.test/statements";
  it("must flag (thread mentions only bank.test)", () => {
    const cases = [
      "https://bank.test:pw@evil.test/",
      `https://evil.test${BS}@bank.test/`,
      "HtTp:evil.test",
      `ftp:${BS}/evil.test`,
      "ws:/evil.test",
      "Visit:evil.test!",
      "go:to:evil.test:now",
      "bank.test:evil.test",
      "evil.test:bank.test",
      "bank.test@evil.test",
      "web+app://evil.test",
      "file://evil.test/share",
      "http:3405803785",
      "https:evil.test" + String.fromCodePoint(0xff0f) + "login",
      "0://ftp://evil.test/x",
      "data:text/html,https://evil.test",
    ];
    for (const c of cases) expect(linksNotInThread(c, T), c).not.toEqual([]);
  });

  it("must not flag ordinary prose", () => {
    const prose = [
      "Meeting at 10:30 tomorrow, ratio 16:9, score 3:2.",
      "We met at 12:00:00 and it was 23:59:59.",
      "Time zones UTC+1:00 and GMT-5:30",
      "John 3:16 and Gen.1:1 and Matt.5:9",
      "MAC 00:1a:2b:3c:4d:5e and IPv6 2001:db8::1",
      "Emoji :smile: and :thumbsup: and Q3:revenue",
      "U.S.:the plan, a.m.:b.m., noon:ok?",
      "http: is a protocol, https: too, and ftp: and wss: are schemes.",
      "Call at 9:00/10:00 or 11:00?",
      "Phone: +1 555 0100 ext:12",
    ];
    for (const p of prose) expect(linksIn(p), p).toEqual([]);
  });

  it("known: candidates found in the thread by R1/R5 count as known", () => {
    const hay = "contact via https:other.test or Link:third.test or Server:203.0.113.9";
    expect(linksNotInThread("https://other.test/ and third.test:443 and http:203.0.113.9", hay)).toEqual([]);
  });
});
