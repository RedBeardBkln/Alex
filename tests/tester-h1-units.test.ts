import { describe, expect, it } from "vitest";
import { hostsIn, linksIn, linksNotInThread } from "@/lib/approvals/warnings";
import * as base from "./helpers/links-baseline";

// Tester, phase-h1-link-hardening (no database). Attacks on the H1 link rules, compared with the
// frozen main copy (tests/helpers/links-baseline.ts) where the approved rule is "a new read may only
// add warnings". Hosts are .test / example only.

const BS = String.fromCharCode(92);
const cp = (n: number) => String.fromCodePoint(n);
/** `~` stands for a backslash. */
const b = (t: string) => t.replaceAll("~", BS);
const K = "see https://bank.test/ and https://www.google.test/";
const KE = `${K} evil.test 203.0.113.9`;
const flagged = (draft: string, thread = K) => linksNotInThread(draft, thread);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("tester H1: baseline displays and flags are kept (approved rule: a new read may only add warnings)", () => {
  // An earlier candidate in the same token that only a new rule reads (a C2 extra-only `=//`, `//` or
  // `_://` candidate, a C4 `ab:\\`, a C5 reset before `\\`) moves the token's link start to the left, so
  // main's display (and main's flagged display) disappears and a longer one is shown instead.
  const forms: [string, string][] = [
    ["C2 extra-only =// candidate", "a=//x@bank.test&e=y@/https://evil.test/"],
    ["C2 extra-only // candidate", "//x@bank.test&e=y@/https://evil.test/"],
    ["C2 extra-only _:// candidate", "_://x@bank.test&e=y@/https://evil.test/"],
    ["C4 scheme + UNC earlier in the token", b("ab:~~x/https://evil.test/")],
    ["C5 reset before UNC earlier in the token", b(`a${cp(0xad)}~~x/https://evil.test/`)],
  ];
  for (const [label, f] of forms) {
    it(`${label}: main's display and flag are still there`, () => {
      const lostDisplays = base.linksIn(f).filter((d) => !linksIn(f).includes(d));
      expect(lostDisplays, f).toEqual([]);
      for (const th of [K, f]) {
        const now = flagged(f, th);
        const lost = base.linksNotInThread(f, th).filter((d) => !now.includes(d));
        expect(lost, `${f} / ${th}`).toEqual([]);
      }
    });
  }

  it("random tokens of candidate-shaped pieces: no baseline display or flag is lost, hostsIn equal", { timeout: 120_000 }, () => {
    const PIECES = ["=//", "//", "_://", "https://", "http:", "x@", "bank.test", "evil.test", "&e=", "y@", "/", "=", "&", "@", "%2F", "%40", "%26", "%3D", "%3A", "%5C", "%20", "%2540", "?", "#", "a", "1", ":", BS, BS + BS, "onenote:", "ab:", cp(0xad), cp(0x200b), "file:", "u="];
    const rnd = mulberry32(0x7e57);
    const lost: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const len = 1 + Math.floor(rnd() * 12);
      let s = "";
      for (let j = 0; j < len; j++) s += PIECES[Math.floor(rnd() * PIECES.length)]!;
      if ([...base.hostsIn(s)].sort().join(" ") !== [...hostsIn(s)].sort().join(" ")) lost.push(`hostsIn ${JSON.stringify(s)}`);
      const nl = new Set(linksIn(s));
      for (const d of base.linksIn(s)) if (!nl.has(d)) lost.push(`display ${JSON.stringify(d)} in ${JSON.stringify(s)}`);
      for (const th of [s, K, KE]) {
        const nf = new Set(linksNotInThread(s, th));
        for (const d of base.linksNotInThread(s, th)) if (!nf.has(d)) lost.push(`flag ${JSON.stringify(d)} in ${JSON.stringify(s)}`);
      }
    }
    expect(lost.slice(0, 10)).toEqual([]);
  });
});

describe("tester H1: C2 (T-N1) with an `=` inside the userinfo", () => {
  // A URLSearchParams-style redirector splits the query on `&` only, so next = "https://bank.test=1@evil.test"
  // and goes to evil.test. The C2 extra run starts after the last `@` before the first `&` OR `=`; an `=`
  // inside the userinfo comes before any `@`, so no extra run is read and the link is quiet with K.
  it("is flagged with K and quiet with KE", () => {
    for (const f of [
      "https://bank.test/?next=https://bank.test=1@evil.test&e=x@bank.test",
      "https://bank.test/?next=https://x=1@evil.test&e=x@bank.test",
      "https://bank.test/?next=https://u:p=w@evil.test&e=x@bank.test",
    ]) {
      expect(new URL(new URL(f).searchParams.get("next")!).hostname).toBe("evil.test");
      expect(flagged(f), f).toEqual([f]);
      expect(flagged(f, KE), f).toEqual([]);
    }
  });
});

describe("tester H1: bypass attempts that hold (flagged with K, quiet with KE and with the same link in the thread)", () => {
  const forms = [
    "https://bank.test/?u=https%3a%2f%2Fevil.test", // mixed case
    "https://bank.test/?u=https%3A//evil.test", // only the colon encoded
    "https://bank.test/?u=https:%2F%2Fevil.test", // only the slashes encoded
    "https://bank.test/?u=%68ttps%3A%2F%2Fevil.test", // an encoded scheme letter
    "https://bank.test/?u=%68%74%74%70%73%3A%2F%2F%65%76%69%6C%2E%74%65%73%74", // everything encoded
    "https://bank.test/?u=https%3A%2F%2Fevil%2Etest", // an encoded dot
    "https://bank.test/?a=1%26u=https%3A%2F%2Fevil.test", // an encoded &
    "https://bank.test/%3Fu=https%3A%2F%2Fevil.test", // an encoded ?
    "https://bank.test/#https%3A%2F%2Fevil.test", // raw fragment
    "https://bank.test/?u=%22https%3A%2F%2Fevil.test%22", // encoded quotes (token breaks after decoding)
    "https://bank.test/?u=%0Ahttps%3A%2F%2Fevil.test", // an encoded newline
    "https://bank.test/?u=x+https%3A%2F%2Fevil.test", // + left as is
    "https://bank.test/?next=https://evil.test%3Dx@bank.test", // an encoded = glue
    "https://bank.test/?next=https://u:p@evil.test&e=x@bank.test", // T-N1 with user:pw
    "https://bank.test/?next=https://a@b@evil.test&e=x@bank.test", // T-N1 with two @
    "https://bank.test/?next=https%3A%2F%2Fbank.test%40evil.test%26e%3Dx%40bank.test", // T-N1 fully encoded
    "https://bank.test/login?next=http://evil.test%5c@bank.test", // lowercase %5c
  ];
  for (const f of forms) {
    it(f, () => {
      expect(flagged(f), f).toEqual([f.toLowerCase()]);
      expect(flagged(f, KE), f).toEqual([]);
      expect(flagged(f, `${K} ${f}`), f).toEqual([]);
      expect([...hostsIn(f)].sort()).toEqual([...base.hostsIn(f)].sort());
    });
  }
});

describe("tester H1: always-flag forms (flagged even with KE and with themselves as the thread)", () => {
  const forms = [
    "https://bank.test/r/https://bank.test%2540evil.test/x", // %2540 in the path
    "https://bank.test/?u=x%C2%AD%5C%5Cevil.test%5Cs", // decoded soft hyphen before UNC
    b("mk:@MSITStore:~~evil.test~x.chm"), // a second scheme after mk:@
    b("a.b:~~evil.test~s"), // scheme with a dot
    b(`x${cp(0xa0)}onenote:~~evil.test~s`), // after an NBSP
    b(`at${cp(0xad)}/~evil.test~s`), // soft hyphen then /\
    b(`at${cp(0x2061)}~~evil.test~share`),
    b(`at${cp(0x200d)}~~evil.test~share`),
  ];
  for (const f of forms) {
    it(JSON.stringify(f), () => {
      expect(flagged(f, KE), f).not.toEqual([]);
      expect(flagged(f, f), f).not.toEqual([]);
    });
  }
  it("an encoded tab inside the host (WHATWG strips it) is still flagged with K: the decoded tab splits the word", () => {
    const f = "https://bank.test/?u=https%3A%2F%2Fev%09il.test";
    expect(flagged(f)).toEqual([f.toLowerCase()]);
    expect(flagged(f, `${K} ${f}`)).toEqual([]);
  });
  it("documented gaps (plan scope): one-letter / digit-led schemes, three backslashes, non-BMP invisibles stay quiet as on main", () => {
    for (const f of [b("9c:~~evil.test~s"), b("onenote:~~~evil.test~share"), b(`at${cp(0xe0020)}~~evil.test~share`), b(`at${cp(0xfe0f)}~~evil.test~share`)]) {
      expect(flagged(f, KE), f).toEqual(base.linksNotInThread(f, KE));
    }
  });
});


describe("tester H1 round 2: decoded whitespace (owner Round 3 refinement of option b)", () => {
  const P = "https://bank.test/?u=";
  const E = "https%3A%2F%2Fevil.test";
  it("encoded-space file links to a known host stay quiet, as on main (the old noise is gone)", () => {
    for (const f of ["https://bank.test/docs/Annual%20Report.pdf", "https://bank.test/dl?file=Q3%20Budget%20v2.xlsx&dl=1", "https://bank.test/badge/made%20by%20x-000000.svg", "https://bank.test/sites/team/Shared%20Documents/Board%20Deck%20(final).pptx"]) {
      expect(flagged(f), f).toEqual([]);
      expect(base.linksNotInThread(f, K), f).toEqual([]);
    }
  });
  it("a tracker wrapping a file link with encoded spaces still checks the wrapped host", () => {
    const f = "https://bank.test/track?u=https%3A%2F%2Ffiles.example.com%2Fshare%2FAnnual%20Report.pdf";
    expect(flagged(f)).toEqual([f.toLowerCase()]);
    expect(flagged(f, `${K} files.example.com`)).toEqual([]);
  });
  it("leading decoded whitespace, controls and look-alike spaces before a nested link are read", () => {
    for (const pre of ["%20", "%20%20", "%09", "%0A", "%0D%0A", "%0B", "%0C", "%00", "%1F", "%C2%A0", "%E2%80%83", "%E3%80%80", "+", "%2B", "%20%09%20"]) {
      const f = P + pre + E;
      expect(flagged(f), f).toEqual([f.toLowerCase()]);
      expect(flagged(f, KE), f).toEqual([]);
    }
    for (const f of ["https://bank.test/?a%3D%20" + E, "https://bank.test/?a=1&u=%20" + E, "https://bank.test/#%20" + E, P + E + "%20x", P + "https%3A%2F%2Fev%0D%0Ail.test"]) {
      expect(flagged(f), f).toEqual([f.toLowerCase()]);
    }
  });
  // Tester R2-N1 (fixed in coder Round 4): a WHATWG URL parser strips every leading C0 control or space,
  // and form decoding turns `+` into a space, so these redirect to evil.test; they must be flagged.
  it("R2-N1: leading decoded C0 controls and `+` before a space are skipped (segment start and after `=`)", () => {
    for (const pre of ["%0B%20", "%00%20", "%0C%20", "%1F%20", "%20%0B%20", "+%20", "%2B%20", "%1F%01%20", "+%00+%20", "%3D%0B%20"]) {
      const f = P + pre + E;
      expect(flagged(f), f).toEqual([f.toLowerCase()]);
      expect(flagged(f, KE), f).toEqual([]);
      expect(flagged(f, `${K} ${f}`), f).toEqual([]);
      expect([...hostsIn(f)].sort(), f).toEqual([...base.hostsIn(f)].sort());
    }
    // A redirector would go to evil.test for each of these leads.
    for (const lead of ["\u000b ", "\u0000 ", "\u001f ", " \u000b "]) expect(new URL(lead + "https://evil.test").hostname).toBe("evil.test");
    expect(new URL(new URLSearchParams("u=+ https://evil.test").get("u")!).hostname).toBe("evil.test");
    // `+` with no space stays flagged; `+` and controls that are not leading are kept (the value is still cut at the space).
    expect(flagged(P + "+" + E)).toEqual([(P + "+" + E).toLowerCase()]);
    expect(flagged(P + "x+%20" + E)).toEqual([]);
    expect(flagged(P + "x%0B%20" + E)).toEqual([]);
  });
  it("leads a URL parser does not strip (DEL, C1, NBSP and other non-ASCII) followed by a space stay quiet, and nothing is lost against the baseline", () => {
    for (const pre of ["%7F%20", "%C2%80%20", "%C2%85%20", "%C2%9F%20", "%C2%A0%20", "%E2%80%83%20", "%EF%BB%BF%20"]) {
      const f = P + pre + E;
      // WHATWG rejects these as URLs (no leading strip, invalid scheme), so a redirector can't reach evil.test.
      const dec = decodeURIComponent(pre);
      expect(() => new URL(dec + "https://evil.test"), pre).toThrow();
      const now = flagged(f);
      for (const d of base.linksNotInThread(f, K)) expect(now, f).toContain(d);
      expect(flagged(f, KE), f).toEqual([]);
    }
    // Without a following space they are read (the lead character isn't a scheme character, so the scheme starts after it).
    for (const pre of ["%7F", "%C2%80", "%C2%85", "%C2%9F", "%C2%A0", "%E2%80%83"]) expect(flagged(P + pre + E), pre).toEqual([(P + pre + E).toLowerCase()]);
  });
});

describe("tester H1 round 2: display (ii), the whole word as a second display", () => {
  it("coder open item 2: link:https://bank.test/a%2Fb lists the whole word but flags nothing with K", () => {
    const f = "link:https://bank.test/a%2Fb";
    expect(linksIn(f)).toEqual(["https://bank.test/a%2fb", "link:https://bank.test/a%2fb"]);
    expect(flagged(f)).toEqual([]);
    expect(flagged("link:https://evil.test/a%2Fb")).toContain("https://evil.test/a%2fb");
  });
  it("a flagged whole-word display always comes with main's display flagged too (random shapes)", { timeout: 120_000 }, () => {
    const PIECES = ["=//", "_://", "https://", "x@", "bank.test", "evil.test", "&e=", "y@", "/", "=", "&", "%2F", "%40", "%20", "%09", "%0A", "%3D", "https%3A%2F%2F", "?", "#", "a", ":", BS + BS, "ab:", "onenote:", "link:", cp(0xad), "%2540"];
    const rnd = mulberry32(0x7e58);
    const bad: string[] = [];
    let seconds = 0;
    for (let i = 0; i < 20_000; i++) {
      const len = 1 + Math.floor(rnd() * 12);
      let s = "";
      for (let j = 0; j < len; j++) s += PIECES[Math.floor(rnd() * PIECES.length)]!;
      const ls = linksIn(s);
      for (const th of [K, KE, s]) {
        const f = linksNotInThread(s, th);
        for (const d of f) {
          // main's display of the same link: a baseline display that is a proper suffix of d and is not a bare host (R5 displays are host names)
          const bl = base.linksIn(s);
          const mains = bl.filter((m) => m !== d && d.endsWith(m) && (m.includes("/") || m.includes(":") || m.includes(BS)));
          if (mains.length === 0 || bl.includes(d)) continue;
          seconds++;
          if (!mains.some((m) => f.includes(m))) bad.push(`${JSON.stringify(d)} in ${JSON.stringify(s)}`);
        }
      }
    }
    expect(seconds).toBeGreaterThan(100);
    expect(bad.slice(0, 10)).toEqual([]);
  });
});
