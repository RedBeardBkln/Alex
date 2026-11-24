import { describe, expect, it } from "vitest";
import { hostsIn, linksIn, linksNotInThread, percentDecodeOnce, readDecoded } from "@/lib/approvals/warnings";
import * as base from "./helpers/links-baseline";

// phase-h1-link-hardening unit tests (no database): the two-tier host model and merge (C1), the glue
// run after a userinfo (C2, tester N1), one percent-decoding pass (C3, SF1), `scheme:\\` (C4, Sec N2)
// and the leading-run resets before a UNC prefix (C5, Sec N3). The haystack header budget (C6) is in
// h1-haystack-db.test.ts.

const BS = String.fromCharCode(92);
const cp = (n: number) => String.fromCodePoint(n);
/** `~` stands for a backslash, so the tables stay readable. */
const b = (t: string) => t.replaceAll("~", BS);
const K = "see https://bank.test/ and https://www.google.test/";
const KE = `${K} evil.test 203.0.113.9`;
const flagged = (draft: string, thread = K) => linksNotInThread(draft, thread);

describe("C2 (tester N1): the run after the userinfo before a glued `&`", () => {
  const forms = ["https://bank.test/login?next=https://bank.test@evil.test&e=x@bank.test", "https://bank.test/?next=https://user@evil.test&e=x@bank.test&v=1"];
  it("is read: flagged with K, quiet with KE", () => {
    for (const f of forms) {
      expect(flagged(f), f).not.toEqual([]);
      expect(flagged(f, KE), f).toEqual([]);
    }
  });
  it("adds only an extra host: hostsIn is unchanged", () => {
    for (const f of forms) expect([...hostsIn(f)].sort(), f).toEqual([...base.hostsIn(f)].sort());
  });
  it("owner round 2 (fix 2): reads after the last `@` before the first `&`, so an `=` in the userinfo doesn't hide the host", () => {
    for (const f of [
      "https://bank.test/?next=https://bank.test=1@evil.test&e=x@bank.test",
      "https://bank.test/?next=https://x=1@evil.test&e=x@bank.test",
      "https://bank.test/?next=https://u:p=w@evil.test&e=x@bank.test",
      "https://bank.test/?next=https://a=b@c=d@evil.test&e=x@bank.test",
    ]) {
      expect(flagged(f), f).toEqual([f]);
      expect(flagged(f, KE), f).toEqual([]);
      expect([...hostsIn(f)].sort(), f).toEqual([...base.hostsIn(f)].sort());
    }
    // An `&` after the authority's last `@` adds nothing new.
    expect(flagged("https://x=1@bank.test&e=1")).toEqual(base.linksNotInThread("https://x=1@bank.test&e=1", K));
  });
  it("the batch-3 quiet userinfo and query forms stay quiet with K", () => {
    const quiet = [
      "https://john.doe@bank.test/",
      "john.doe@bank.test",
      "ftp://user:pw@bank.test/x",
      "https://bank.test/?email=a@bank.test",
      "https://bank.test/?a=b&email=a@bank.test",
      "mailto:a=b@bank.test",
      "mailto:list&x@bank.test",
      "a=b@bank.test",
      "x&y=z@bank.test",
      "https://bank.test/login?user=a@bank.test&next=/home",
      "https://a=b@bank.test/",
      "https://a&b@bank.test/",
      "https://user=x@bank.test/",
      "https://bank.test/?next=https://user@bank.test&e=x@bank.test",
    ];
    for (const q of quiet) expect(flagged(q), q).toEqual([]);
  });
});

describe("owner round 2 (tester D1): a newer read never moves the display of a link main reads", () => {
  // Each token has a newer-rule candidate before a link main flags; main's display must stay.
  const forms = [
    "a=//x@bank.test&e=y@/https://evil.test/",
    "//x@bank.test&e=y@/https://evil.test/",
    "_://x@bank.test&e=y@/https://evil.test/",
    "a=//x@bank.test%40z&e=y@/https://evil.test/",
    b("ab:~~x/https://evil.test/"),
    b(`a${cp(0xad)}~~x/https://evil.test/`),
    b(`a${cp(0x3164)}~~x/https://evil.test/`),
    "u=https%3A%2F%2Fevil.test&v=https://bank.test/",
  ];
  it("main's displays are still shown, and main's flags are still raised on them", () => {
    for (const f of forms) {
      expect(linksIn(f), f).toEqual(expect.arrayContaining(base.linksIn(f)));
      for (const th of [K, KE, f]) expect(flagged(f, th), `${f} / ${th}`).toEqual(expect.arrayContaining(base.linksNotInThread(f, th)));
    }
  });
  it("a newer read's own flag is added to main's display", () => {
    expect(flagged(b("ab:~~x/https://bank.test/"), K)).toContain("https://bank.test/");
    expect(base.linksNotInThread(b("ab:~~x/https://bank.test/"), K)).toEqual([]);
  });
  it("owner round 3 (display ii): a newer read before main's display also shows the whole word, flagged", () => {
    const c4 = b("ab:~~x/https://bank.test/");
    expect(linksIn(c4)).toEqual(["https://bank.test/", c4]);
    expect(flagged(c4, K)).toEqual(["https://bank.test/", c4]);
    expect(flagged(c4, `${KE} ${c4}`)).toEqual(["https://bank.test/", c4]);
    const c5 = b(`a${cp(0xad)}~~x/https://bank.test/`);
    expect(flagged(c5, K)).toEqual(["https://bank.test/", b("a" + cp(0xad) + "~~x/https://bank.test/")]);
    // Hosts only: the second display is flagged only while its host is unknown.
    // (Their hosts still also go to main's link, as in round 2.)
    for (const f of ["a=//x@evil.test&e=y@/https://bank.test/", "u=https%3A%2F%2Fevil.test&v=https://bank.test/"]) {
      expect(base.linksNotInThread(f, K), f).toEqual([]);
      expect(flagged(f, K), f).toEqual(["https://bank.test/", f.toLowerCase()]);
      expect(flagged(f, KE), f).toEqual([]);
      expect(linksIn(f), f).toEqual([...base.linksIn(f), f.toLowerCase()].filter((d, i, a) => a.indexOf(d) === i));
    }
  });
  it("owner round 3 (display ii): no second display when the newer read is inside main's display, or adds nothing", () => {
    for (const f of [b("https://bank.test/ab:~~x"), "https://bank.test/?u=https%3A%2F%2Fevil.test", b(`https://bank.test/a${cp(0xad)}~~x`), "u=x%2Fy&v=https://bank.test/", b("link:https://bank.test/ab:~~x"), "link:https://bank.test/?u=https%3A%2F%2Fevil.test"])
      expect(linksIn(f), f).toEqual(base.linksIn(f));
  });
  it("a newer read with no main read in the token is shown from its own start", () => {
    expect(linksIn(b("x ab:~~evil.test~s"))).toEqual([b("ab:~~evil.test~s")]);
    expect(flagged(b(`a${cp(0xad)}~~evil.test~s`), KE)).toEqual([b("~~evil.test~s")]);
  });
});

describe("C3 (SF1): one percent-decoding pass per `?`/`&`/`#` segment, path included (owner Q2 B)", () => {
  const ac4 = [
    "https://bank.test/?u=https%3A%2F%2Fevil.test",
    "https://bank.test/login?next=http://evil.test%2F@bank.test",
    "https://bank.test/login?next=http://evil.test%5C@bank.test",
    "https://bank.test/login?next=http://evil.test%3F@bank.test",
    "https://bank.test/login?next=http://evil.test%23@bank.test",
    "https://bank.test/?x=1&next=http:%2F%2Fevil.test",
    "https://bank.test/?u=https%3A%2F%2Fbank.test%40evil.test",
    "https://bank.test/#u=https%3A%2F%2Fevil.test",
    "https://bank.test/?u=https%3A%2F%2F%C3%A9vil.test",
    "https://bank.test/?u=https%3A%2F%2Fevil.test+x",
    "https://bank.test/r/https%3A%2F%2Fevil.test",
    "https://bank.test/?u=https%3a%2f%2fevil.test",
    "https://bank.test/?u=https%3A%2F%2Fevil.test%20x",
  ];
  it("AC-4: flagged with K", () => {
    for (const f of ac4) expect(flagged(f), f).toEqual([f.toLowerCase()]);
  });
  it("AC-4: quiet with KE, and quiet when the thread has the same encoded link (two-tier)", () => {
    const idn = "https://bank.test/?u=https%3A%2F%2F%C3%A9vil.test";
    for (const f of ac4) {
      if (f !== idn) expect(flagged(f, KE), f).toEqual([]);
      expect(flagged(f, `${K} ${f}`), f).toEqual([]);
    }
    expect(flagged(idn, `${KE} ${cp(0xe9)}vil.test`)).toEqual([]);
  });
  it("AC-6 (T-N2 %26): an encoded `&` before a userinfo is read after decoding", () => {
    const f = "https://bank.test/login?next=https://evil.test%26x@bank.test";
    expect(flagged(f)).toEqual([f]);
    expect(flagged(f, KE)).toEqual([]);
  });
  it("AC-5: %2540 is always flagged (one decode leaves %40); double-encoded links are not checked", () => {
    const f = "https://bank.test/?next=https://bank.test%2540evil.test&v=1";
    expect(flagged(f, KE)).toEqual([f]);
    expect(flagged(f, `${KE} ${f}`)).toEqual([f]);
    expect(flagged("https://bank.test/?u=https%253A%252F%252Fevil.test")).toEqual([]);
  });
  it("decoded always-flag forms flag the link, even with KE", () => {
    for (const f of [
      "https://bank.test/?u=%5C%5Cevil.test%5Cshare",
      "https://bank.test/?u=file%3A%2F%2Fevil.test%2Fs",
      "https://bank.test/?u=search-ms%3Aquery%3Dx",
      "https://bank.test/?u=ms-x%3Ay",
      "https://bank.test/?u=https%3A%2F%2Fbank.test%2540evil.test",
    ])
      expect(flagged(f, KE), f).toEqual([f.toLowerCase()]);
  });
  it("owner Q3: a decoded value with no host never sets the host-less flag", () => {
    for (const f of ["https://bank.test/?u=myapp%3A%2F%2Fopen", "https://bank.test/x%3A%2F%2F", "https://bank.test/?u=x%3A%2F%2F&v=1"]) expect(flagged(f), f).toEqual([]);
  });
  it("a decoded host attaches to the token's link (same display as main)", () => {
    const f = "https://bank.test/?u=https%3A%2F%2Fevil.test";
    expect(linksIn(f)).toEqual(base.linksIn(f));
  });
  it("prose with no URL link shows the raw token from the segment start", () => {
    expect(linksIn("go to u=https%3A%2F%2Fevil.test now")).toEqual(["u=https%3a%2f%2fevil.test"]);
    expect(flagged("x?u=https%3A%2F%2Fevil.test")).toEqual(["u=https%3a%2f%2fevil.test"]);
    expect(flagged("x?u=https%3A%2F%2Fevil.test", KE)).toEqual([]);
  });
  it("a segment with no valid escape is not decoded (same as main)", () => {
    for (const f of ["https://bank.test/?u=evil.test%", "https://bank.test/?u=%4evil.test", "https://bank.test/?u=%zzevil.test", "50% off at bank.test", "https://bank.test/?u=https://evil.test"]) {
      expect(linksIn(f), f).toEqual(base.linksIn(f));
      expect(flagged(f), f).toEqual(base.linksNotInThread(f, K));
    }
  });
  it("invalid bytes never throw", () => {
    for (const f of ["https://bank.test/?u=%FF", "https://bank.test/?u=%C0%AFevil.test", "https://bank.test/?u=%00evil.test", "https://bank.test/?u=%ED%A0%80"]) expect(() => flagged(f, f)).not.toThrow();
  });
  it("dedupe-merge: two tokens with the same display and different extra hosts are both checked", () => {
    const draft = "https://bank.test/ u=https%3A%2F%2Fevil.test&x=https://bank.test/";
    // The second word's decoded part starts before its display, so the whole word is also shown (display ii).
    expect(flagged(draft)).toEqual(["https://bank.test/", "u=https%3a%2f%2fevil.test&x=https://bank.test/"]);
    expect(flagged(draft, KE)).toEqual([]);
  });
  it("two-tier: a base host known only through an encoded mention is still flagged; an extra host is quiet", () => {
    const hay = "https://bank.test/?u=https%3A%2F%2Fevil.test";
    expect(flagged("https://evil.test/", hay)).toEqual(["https://evil.test/"]);
    expect(flagged("evil.test", hay)).toEqual(["evil.test"]);
    expect(flagged("https://bank.test/?next=https%3A%2F%2Fevil.test%2Fx", hay)).toEqual([]);
  });
  it("owner round 3 (option b refined): decoded tab/LF/CR dropped, leading spaces skipped, cut at the next space", () => {
    // Quiet with K: the file name after an encoded space is no longer read as a host (main is quiet too).
    for (const f of [
      "https://bank.test/docs/Annual%20Report.pdf",
      "https://bank.test/dl?file=Q3%20Budget%20v2.xlsx&dl=1",
      "https://bank.test/?u=x%20evil.test",
      "https://bank.test/?u=x%20%20evil.test",
      "https://bank.test/?u=x%09%20evil.test",
    ]) {
      expect(flagged(f), f).toEqual([]);
      expect(flagged(f), f).toEqual(base.linksNotInThread(f, K));
    }
    // The part before the cut is still read, and each segment is cut on its own.
    for (const f of ["https://bank.test/?u=https%3A%2F%2Fevil.test%20x", "https://bank.test/?a=x%20y&u=https%3A%2F%2Fevil.test", "https://bank.test/a%20b?u=https%3A%2F%2Fevil.test"])
      expect(flagged(f), f).toEqual([f.toLowerCase()]);
    // Flagged with K, quiet with KE: a URL parser drops tab/LF/CR and leading spaces, so these go to evil.test.
    for (const f of [
      "https://bank.test/?u=%0Ahttps%3A%2F%2Fevil.test",
      "https://bank.test/?u=%20https%3A%2F%2Fevil.test",
      "https://bank.test/?u=%09https%3A%2F%2Fevil.test",
      "https://bank.test/?u=%20%0D%0A%20https%3A%2F%2Fevil.test",
      "https://bank.test/?u=https%3A%2F%2Fev%09il.test",
      "https://bank.test/?u=https%3A%2F%2Fevil.te%0Ast",
      "https://bank.test/?u=https%3A%2F%2F%0Aevil.test%20y",
      "https://bank.test/?a=1%26u=%20https%3A%2F%2Fevil.test",
      // R2-N1 (owner round 4): other C0 controls and `+` are also skipped at the start and after `=`.
      "https://bank.test/?u=%0B%20https%3A%2F%2Fevil.test",
      "https://bank.test/?u=%00%20https%3A%2F%2Fevil.test",
      "https://bank.test/?u=%1F%01%20https%3A%2F%2Fevil.test",
      "https://bank.test/?u=+%20https%3A%2F%2Fevil.test",
      "https://bank.test/?u=%2B%20https%3A%2F%2Fevil.test",
      "https://bank.test/?u=a%3D%0B%20https%3A%2F%2Fevil.test",
      "https://bank.test/?u=%00//evil.test",
      "https://bank.test/?u=+https%3A%2F%2Fevil.test", // flagged before R2-N1 too (`+` is a scheme character)
    ]) {
      expect(flagged(f), f).toEqual([f.toLowerCase()]);
      expect(flagged(f, KE), f).toEqual([]);
      expect([...hostsIn(f)].sort(), f).toEqual([...base.hostsIn(f)].sort());
    }
    // A decoded NBSP is not a cut (it isn't a token break).
    expect(flagged(`https://bank.test/?u=x%C2%A0%5C%5Cevil.test%5Cs`, KE)).not.toEqual([]);
    // Plain-text reads are unchanged: a raw space still splits words as before.
    expect(flagged("see https://bank.test/a evil.test")).toEqual(["evil.test"]);
  });
  it("hostsIn (the known set) is unchanged by decoding", () => {
    for (const f of ac4) expect([...hostsIn(f)].sort(), f).toEqual([...base.hostsIn(f)].sort());
  });
});

describe("readDecoded (owner round 3)", () => {
  it("drops tab/LF/CR, skips spaces at the start and after each =, cuts at the next space", () => {
    expect(readDecoded("annual report.pdf")).toBe("annual");
    const [T, N, R] = [9, 10, 13].map((c) => String.fromCharCode(c));
    expect(readDecoded(` ${T} https://evil.test`)).toBe("https://evil.test");
    expect(readDecoded(`u= ${N}https://ev${T}il.test x`)).toBe("u=https://evil.test");
    expect(readDecoded("a=1 b= c")).toBe("a=1");
    expect(readDecoded("a= =  b c")).toBe("a==b");
    expect(readDecoded(`x${R}${N}y`)).toBe("xy");
    // R2-N1: at the start and after `=`, C0 controls and `+` are skipped too; elsewhere they are kept.
    const [NUL, VT, US] = [0, 11, 31].map((c) => String.fromCharCode(c));
    expect(readDecoded(`${NUL}${VT} https://evil.test`)).toBe("https://evil.test");
    expect(readDecoded(`u=${US}+ +https://evil.test x`)).toBe("u=https://evil.test");
    expect(readDecoded("a+b c")).toBe("a+b");
    expect(readDecoded("x+ y")).toBe("x+");
    expect(readDecoded(`a${VT}b c`)).toBe(`a${VT}b`);
    expect(readDecoded("+1")).toBe("1");
    expect(readDecoded("q=a+b")).toBe("q=a+b");
    expect(readDecoded("no-space")).toBe("no-space");
    expect(readDecoded("")).toBe("");
    expect(readDecoded("   ")).toBe("");
    expect(readDecoded(`x${cp(0xa0)}y z`)).toBe(`x${cp(0xa0)}y`);
  });
});

describe("percentDecodeOnce", () => {
  const d = (s: string) => percentDecodeOnce(s, 0, s.length);
  it("decodes each valid %XX once, either case, as UTF-8; other characters are copied", () => {
    expect(d("a%2fb%2Fc")).toBe("a/b/c");
    expect(d("%41%42")).toBe("ab"); // lowercased
    expect(d("%2541")).toBe("%41"); // once only
    expect(d("%")).toBe("%");
    expect(d("x%4")).toBe("x%4");
    expect(d("%zz%4g")).toBe("%zz%4g");
    expect(d("a+b")).toBe("a+b");
    expect(d("%C3%A9")).toBe(cp(0xe9));
    expect(d("%E4%B8%AD")).toBe(cp(0x4e2d));
    expect(d("%F0%9F%98%80")).toBe(cp(0x1f600));
    expect(d("%20x%22")).toBe(' x"');
    expect(d("%00")).toBe(cp(0));
  });
  it("invalid bytes become U+FFFD (no throw); a BOM is kept", () => {
    expect(d("%FF")).toBe(cp(0xfffd));
    expect(d("%C0%AF")).toBe(cp(0xfffd) + cp(0xfffd));
    expect(d("%C3x")).toBe(cp(0xfffd) + "x");
    expect(d("%EF%BB%BFa")).toBe(cp(0xfeff) + "a");
  });
  it("decodes only the given range, and is never longer than it", () => {
    expect(percentDecodeOnce("%41%42%43", 3, 6)).toBe("b");
    for (const s of ["%41".repeat(50), "%C3%A9".repeat(40), "%F0%9F%98%80".repeat(30), "%FF".repeat(30), "%E2%82".repeat(30)]) expect(d(s).length).toBeLessThanOrEqual(s.length);
  });
});

describe("C4 (Sec N2, owner Q5): a non-special scheme of 2+ characters followed by a UNC prefix", () => {
  it("AC-7: always flagged, even with KE", () => {
    for (const f of [b("onenote:~~evil.test~share"), b("its:~~evil.test~x.chm"), b("see:~~evil.test~share"), b("ab:~/evil.test"), b("ab:/~evil.test"), b("x1:~~evil.test")])
      expect(flagged(f, KE), f).toEqual([f.toLowerCase()]);
  });
  it("also inside a decoded segment", () => {
    const f = "https://bank.test/?u=onenote%3A%5C%5Cevil.test%5Cs";
    expect(flagged(f, KE)).toEqual([f.toLowerCase()]);
  });
  it("one-letter (drive-like) schemes and special schemes are unchanged", () => {
    for (const f of [b("x:~~evil.test~share"), b("C:~~Users~x"), b("https:~~bank.test")]) {
      expect(flagged(f), f).toEqual(base.linksNotInThread(f, K));
      expect(flagged(f, KE), f).toEqual(base.linksNotInThread(f, KE));
    }
    expect(flagged(b("C:~~Users~x"), KE)).toEqual([]);
    expect(flagged(b("https:~~bank.test"))).toEqual([]);
    expect(flagged(b("https:~~evil.test"))).toEqual([b("https:~~evil.test")]);
    expect(flagged(b("https:~~evil.test"), KE)).toEqual([]);
  });
});

describe("C5 (Sec N3, owner Q6): invisible and blank characters restart the leading run before a UNC prefix", () => {
  it("AC-8: flagged with KE", () => {
    for (const c of [0xad, 0x200b, 0x2060, 0xfeff, 0x2800, 0x3164, 0x115f, 0x1160, 0xffa0, 0x200e, 0x202e, 0x180e, 0x85]) {
      const f = `at${cp(c)}${b("~~evil.test~share")}`;
      expect(flagged(f, KE), c.toString(16)).not.toEqual([]);
    }
  });
  it("letters before a UNC prefix with no reset stay quiet, as before", () => {
    for (const f of [b("a~~b"), b("C:~~x"), b("at~~evil.test~share")]) expect(flagged(f, KE), f).toEqual([]);
  });
});
