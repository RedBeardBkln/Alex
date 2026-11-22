import { describe, expect, it } from "vitest";
import { cutAtTokenBoundary, hostsIn, isKnownHost, linksNotInThread } from "@/lib/approvals/warnings";
import { sliceOnCodePoint } from "@/lib/approvals/text";

// Tester, phase-2-followups-3 (no DB). Link rules (S2, N2, N-1) and the S3 cut, attacked.
// The defect blocks pin behaviour the plan's scope requires (03-test-report.md: D1, D1b, D2).
// D1, D2 and D1b were fixed in coder rounds 2, 3 and 4.

const B = String.fromCharCode(92);
const NBSP = String.fromCharCode(0xa0);

describe("tester D1: N-1 must not hide a real host glued to query text (fixed in round 2)", () => {
  // The embedded link has a real host for any redirector that splits the query on "&" (or similar),
  // but WHATWG reads "evil.test&v=1" as the host, which isn't a domain, so N-1 treats it as host-less
  // and drops the flag. main (7768b89) flagged every one of these.
  const known = "see https://bank.test/ and https://www.google.test/";
  const cases = [
    "https://bank.test/?next=https://evil.test&v=1",
    "https://bank.test/?next=http://evil.test&v=1",
    "https://bank.test/?next=http:evil.test&v=1",
    "https://bank.test/?u=ftp:evil.test&v=1",
    "https://bank.test/?next=https://203.0.113.9&v=1",
    "https://bank.test/?next=https://evil.test!x",
    "https://bank.test/?next=https://evil.test=1",
    "https://www.google.test/url?q=https://evil.test&sa=D",
  ];
  for (const c of cases) it(`flags ${c}`, () => expect(linksNotInThread(c, known)).toHaveLength(1));

  it("while the N-1 quiet cases stay quiet (owner Q4)", () => {
    for (const c of ["https://bank.test/x?next=http://localhost:3000", "https://bank.test/r?u=myapp://open", "https://bank.test/a://b", "https://bank.test/x?next=http://localhost:3000&v=1"])
      expect(linksNotInThread(c, known), c).toEqual([]);
  });
});

describe("tester D1b (round 2): userinfo before a glued host must not hide it (fixed in round 4)", () => {
  // The round-2 lenient read stops at "@", so it reads the userinfo ("bank.test", "user") instead of
  // the host after it. A redirector forwarding "https://bank.test@evil.test" sends the browser to
  // evil.test. main (7768b89) flagged every one of these.
  const known = "see https://bank.test/";
  const cases = [
    "https://bank.test/?next=https://bank.test@evil.test&v=1",
    "https://bank.test/?next=https://user@evil.test&v=1",
    "https://bank.test/?next=https://user:pw@evil.test&v=1",
    "https://bank.test/?next=http:bank.test@evil.test&v=1",
    "https://bank.test/?u=x://bank.test@evil.test&v=1",
    "https://bank.test/?u=//bank.test@evil.test&v=1",
  ];
  for (const c of cases) it(`flags ${c}`, () => expect(linksNotInThread(c, known)).toHaveLength(1));
  it("and is quiet when the host after the userinfo is known", () => {
    expect(linksNotInThread("https://bank.test/?next=https://user@bank.test&v=1", known)).toEqual([]);
  });
});

describe("tester round 3: the round-4 lenient read never clears the host-less flag and adds no noise", () => {
  const K = "see https://bank.test/ and https://www.google.test/";
  const KE = `${K} evil.test 203.0.113.9`;
  const P = "https://bank.test/?next=";
  it("flags userinfo, glue, port, backslash and IPv4 forms, quiet when the host is known", () => {
    for (const c of [`${P}https://user:bank.test@evil.test&v=1`, `${P}https://bank.test:443@evil.test&v=1`, `${P}https://@evil.test&v=1`, `${P}https://bank.test@@evil.test&v=1`,
      `${P}https://a@b@c@evil.test&v=1`, `${P}https://evil.test&e=x@bank.test`, `${P}https://evil.test=x@bank.test`, `${P}https:${B}${B}user@evil.test&v=1`, `${P}https://bank.test${B}@evil.test&v=1`,
      `${P}https://user@203.0.113.9&v=1`, `${P}https://user@EVIL.TEST&v=1`, `${P}https://user@evil.test&v=1:8080`, "//bank.test@evil.test&v=1", "_://bank.test@evil.test&v=1", "x=//bank.test@evil.test&v=1"]) {
      expect(linksNotInThread(c, K), c).toHaveLength(1);
      expect(linksNotInThread(c, KE), c).toEqual([]);
    }
  });
  it("an encoded @ is always flagged; a host-less link before any host stays always flagged", () => {
    for (const c of [`${P}https://bank.test%40evil.test&v=1`, `${P}https://BANK.TEST%40EVIL.TEST`, "https://bank.test%40evil.test/", "https://evil.test&v=1", "https://user@bank.test&v=1", "https://bank.test@bank.test&v=1", "x://bank.test&v=1", `https:${B}${B}evil.test&v=1`])
      expect(linksNotInThread(c, KE), c).toHaveLength(1);
  });
  it("plain userinfo, mailto-style and query text stay quiet", () => {
    for (const c of ["https://john.doe@bank.test/", "ftp://user:pw@bank.test/x", "https://bank.test/?a=b&email=a@bank.test", "mailto:a=b@bank.test", "mailto:list&x@bank.test", "x&y=z@bank.test", "https://bank.test/login?user=a@bank.test&next=/home", "https://a=b@bank.test/", "https://a&b@bank.test/", "https://bank.test/%40user", "ftp://user%40mail.test@bank.test/x"])
      expect(linksNotInThread(c, K), c).toEqual([]);
  });
});

describe("tester D2: a UNC prefix after typographic quotes or a no-break space (fixed in round 3)", () => {
  const T = `evil.test ${B}${B}evil.test${B}share`;
  for (const c of [`\u201c${B}${B}evil.test${B}share\u201d`, `\u2018${B}${B}evil.test${B}share\u2019`, `\u00ab${B}${B}evil.test${B}share\u00bb`, `at${NBSP}${B}${B}evil.test${B}share`])
    it(`flags ${JSON.stringify(c)}`, () => expect(linksNotInThread(c, T)).toHaveLength(1));
});

describe("tester D2 round 2: more leading forms", () => {
  const T = `evil.test ${B}${B}evil.test${B}share`;
  const sp = (c: number) => String.fromCharCode(c);
  it("flags after emoji, invisible or combining characters, repeated quotes, and mixed slashes", () => {
    for (const lead of ["\u{1f449}", "​", "﻿", "⁠", "­", "́", "““", `at${sp(0xa0)}“`, sp(0xa0), `a${sp(0xa0)}b${sp(0xa0)}`, `x${sp(0x2003)}-`])
      for (const unc of [`${B}${B}evil.test${B}s`, `${B}/evil.test/s`, `/${B}evil.test${B}s`])
        expect(linksNotInThread(lead + unc, T), JSON.stringify(lead + unc)).toHaveLength(1);
  });
  it("stays quiet after a letter or digit in any script, and on prose with no-break spaces", () => {
    for (const c of [`a${B}${B}b`, `C:${B}${B}x`, `1${B}${B}x`, `é${B}${B}x`, `例${B}${B}x`, `x:${B}${B}evil.test${B}s`, `-${B}${B}`, `:${B}${B}${B}x`, `price:${sp(0xa0)}10${B}20`, `a${sp(0xa0)}b${B}${B}c`, `x${sp(0xa0)}${B}${B}`, `¯${B}_(ツ)_/¯`, `10${sp(0xa0)}km/h`, `and${sp(0xa0)}/${sp(0xa0)}or`])
      expect(linksNotInThread(c, "bank.test"), JSON.stringify(c)).toEqual([]);
  });
});

describe("tester: always-flagged forms hold up (S2, N2)", () => {
  const T = `evil.test 203.0.113.9 ${B}${B}evil.test${B}share file://evil.test/x smb://evil.test/s search-ms:x ms-msdt:x`;
  const flagged = [
    `${B}${B}EVIL.TEST${B}share`, `(${B}${B}evil.test${B}share)`, `<${B}${B}evil.test${B}share>`, `"${B}${B}evil.test${B}share"`, `'${B}${B}evil.test${B}share'`,
    `**${B}${B}evil.test${B}share**`, `${B}/evil.test/s`, `/${B}evil.test${B}s`, `${B}${B}?${B}unc${B}evil.test${B}s`, `${B}${B}.${B}unc${B}evil.test${B}s`,
    `${B}${B}203.0.113.9${B}c$`, `path=${B}${B}server${B}share`, `HREF=${B}${B}evil.test${B}s`, `href==${B}${B}evil.test${B}s`, `href="${B}${B}evil.test${B}s"`,
    `FILE:${B}${B}Evil.Test${B}share`, `File:/${B}evil.test/x`, `"file://evil.test/x"`, `(file:${B}${B}evil.test${B}x)`, `file:/x`,
    `SMB://evil.test/s`, `smb:${B}${B}evil.test${B}s`, `smb:/x`,
    `SEARCH-MS:query=x`, `Search:query=x`, `see:search-ms:x`, `(search-ms:query=x)`, `MS-MSDT:/id`, `ms-officecmd:x`, `ms-settings:display`, `ms-word:ofe|u|https://evil.test/x`,
    `https://bank.test/?u=${B}${B}evil.test${B}s`, `https://bank.test/?u=/${B}evil.test`, `https://bank.test/?u=file:///etc/x`, `https://bank.test/#ms-x:y`,
  ];
  for (const c of flagged) it(`flags ${JSON.stringify(c)} even when the thread has it`, () => expect(linksNotInThread(c, `${T} ${c} https://bank.test/`)).toHaveLength(1));

  it("stays quiet on code-ish and prose forms", () => {
    for (const c of [`C:${B}Users${B}x`, `C:${B}${B}Program Files`, `"C:${B}${B}Users${B}${B}x"`, `${B}${B}`, `${B}${B}${B}${B}`, `a${B}${B}b`, `a=${B}${B}`, "a=b==c", "x==y", "msdn:foo", "ms:foo", "ms-:foo", "terms-ms:foo", "Item:ms-x", "researchers:", "research:x", "search: x", "profile:/x", "afile:/x", "x-file://evil.test/x", "smb:evil.test"])
      expect(linksNotInThread(c, "evil.test bank.test"), c).toEqual([]);
  });
});

describe("tester: =// and punycode (N2)", () => {
  it("=//host is read like //host, known-in-thread applies", () => {
    expect(linksNotInThread("a=//evil.test", "bank.test")).toEqual(["a=//evil.test"]);
    expect(linksNotInThread("x=//203.0.113.9/", "bank.test")).toEqual(["x=//203.0.113.9/"]);
    expect(linksNotInThread("https://bank.test/?u=//evil.test/x", "bank.test")).toHaveLength(1);
    expect(linksNotInThread("x=//bank.test/x=//evil.test/", "bank.test")).toHaveLength(1);
    expect(linksNotInThread("a=//evil.test", "evil.test")).toEqual([]);
    expect(linksNotInThread("href=///evil.test/x", "bank.test")).toEqual([]); // exactly two slashes (plan); see report L1
  });
  it("punycode TLDs: ASCII-typed only for bare hosts; scheme links follow known-in-thread", () => {
    expect(linksNotInThread("EVIL.XN--P1AI/login", "bank.test")).toEqual(["evil.xn--p1ai"]);
    expect(linksNotInThread("evil.xn--p1ai/login", "evil.xn--p1ai")).toEqual([]);
    expect(linksNotInThread("http://evil.xn--p1ai/", "evil.рф")).toEqual(["http://evil.xn--p1ai/"]); // a Unicode TLD in the thread doesn't count (bare)
    expect(linksNotInThread("http://evil.xn--p1ai/", "http://evil.рф/")).toEqual([]); // but a scheme link to it does
    expect(linksNotInThread("例え\u3002テスト 例え.テスト", "bank.test")).toEqual([]);
    expect(linksNotInThread("abc\u3002xn--p1ai", "bank.test")).toEqual(["abc.xn--p1ai"]);
    expect(linksNotInThread("evil.xn--/x", "bank.test")).toEqual([]);
  });
});

describe("tester: isKnownHost equals the subdomain rule, including IPs and odd known sets", () => {
  const under = (h: { host: string; ip: boolean }, known: Set<string>) => (h.ip ? known.has(h.host) : [...known].some((k) => h.host === k || h.host.endsWith(`.${k}`)));
  it("matches on edge sets", () => {
    const sets = [new Set(["1.2.3.4", "test", "a.test", "xn--p1ai", "evil.xn--p1ai", "co", "bank.com"]), new Set<string>(), new Set(["4"])];
    const hosts = ["1.2.3.4", "a.test", "b.a.test", "test", "x.test", "evil.xn--p1ai", "a.evil.xn--p1ai", "bank.co", "bank.com", "mybank.com", "x.bank.com", "a.co", "3.4"]
      .map((h) => ({ host: h, ip: /^[0-9.]+$/.test(h) && h.split(".").length === 4 }));
    for (const k of sets) for (const h of hosts) expect(isKnownHost(h, k), `${h.host} in ${[...k]}`).toBe(under(h, k));
  });
});

describe("tester: a cut haystack only ever adds warnings (property, S3)", () => {
  // Deterministic PRNG so failures reproduce.
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const vocab = ["bank.com", "bank.co", "mail.bank.com", "https://bank.com/x", "https://bank.co", "alice@bank.com", "evil.test", "http://evil.test&v=1", "x://y",
    `${B}${B}bank.com${B}s`, "=//bank.com", "bank.xn--p1ai", "\u{1F600}", "é", "中文", "w", "a.b", "1.2.3.4", "1.2.3.45", "(", ")", "\"", "'", " ", "\n", "\t", "<", ">", ",", ";", "|", "`", "*", "[", "]", "{", "}"];
  const drafts = ["https://bank.co/", "bank.co", "https://mail.bank.co/", "x.bank.com", "1.2.3.4", "https://evil.test/", "bank.xn--p1", "https://bank.com/x"];
  it("for 3,000 random texts and random cuts, flagged(draft, cut) contains flagged(draft, full)", () => {
    for (let k = 0; k < 3000; k++) {
      let text = "";
      const len = 1 + rnd(40);
      for (let i = 0; i < len; i++) text += vocab[rnd(vocab.length)]!;
      const budget = rnd(text.length + 2);
      const cut = text.length > budget ? cutAtTokenBoundary(sliceOnCodePoint(text, budget)) : text;
      const full = hostsIn(text);
      for (const h of hostsIn(cut)) expect(full.has(h), `${JSON.stringify(text)} @${budget}: ${h}`).toBe(true);
      for (const d of drafts) {
        const a = linksNotInThread(d, text);
        const b = linksNotInThread(d, cut);
        for (const x of a) expect(b, `${JSON.stringify(text)} @${budget}: ${d}`).toContain(x);
      }
      expect(cut.isWellFormed()).toBe(true);
    }
  });
});
