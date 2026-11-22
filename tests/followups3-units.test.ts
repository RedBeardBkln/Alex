import { describe, expect, it } from "vitest";
import type { Executor } from "@/db";
import type { approveItem } from "@/lib/approvals/service";
import { cutAtTokenBoundary, hostsIn, isKnownHost, linksIn, linksNotInThread, type Host } from "@/lib/approvals/warnings";

// phase-2-followups-3 unit tests (no database): S2/N2/N-1 link rules, the S3a exact host index, the
// S3b token-boundary cut and the S1 type. The DB side is in followups3-db.test.ts.

const BS = String.fromCharCode(92);
const cp = (n: number) => String.fromCodePoint(n);
/** `~` stands for a backslash, so the tables stay readable. */
const b = (t: string) => t.replaceAll("~", BS);
const T = "Hello from bank.test, see https://bank.test/statements";

describe("S2/N2: always-flagged forms (AC-L-1)", () => {
  const always = [
    "~~evil.test~share",
    "~~203.0.113.9~c$",
    "~/evil.test~s",
    "/~evil.test/s",
    "file:~~evil.test~share",
    "file:/~evil.test/x",
    "file://evil.test/share",
    "file:////evil.test/share",
    "FILE://Evil.Test/x",
    "href=~~evil.test~s",
    "search-ms:query=x&crumb=location:~~evil.test~s",
    "search:query=x",
    "ms-msdt:/id",
    "ms-word:ofe",
    "smb://evil.test/s",
    "smb:~~evil.test~s",
  ].map(b);

  it("flagged with only bank.test in the thread", () => {
    for (const c of always) expect(linksNotInThread(c, T), c).toHaveLength(1);
  });

  it("still flagged when the thread contains the host and the same text (owner Q1, Q1b)", () => {
    for (const c of always) {
      const thread = `${T} evil.test https://evil.test/ 203.0.113.9 ${c}`;
      expect(linksNotInThread(c, thread), c).toHaveLength(1);
    }
  });

  it("is shown from the UNC prefix or the scheme", () => {
    expect(linksNotInThread(b("~~evil.test~share"), T)).toEqual([b("~~evil.test~share")]);
    expect(linksNotInThread(b("href=~~evil.test~s"), T)).toEqual([b("~~evil.test~s")]);
    expect(linksNotInThread("FILE://Evil.Test/x", T)).toEqual(["file://evil.test/x"]);
    expect(linksNotInThread("x=ms-msdt:/id", T)).toEqual(["ms-msdt:/id"]);
    expect(linksNotInThread("ms-word:ofe|u|https://evil.test/x", T)).toEqual(["ms-word:ofe", "https://evil.test/x"]);
  });

  it("WHATWG reads a host for the backslash file: forms, and none for file:////", () => {
    expect(new URL(b("file:~~evil.test~share")).hostname).toBe("evil.test");
    expect(new URL(b("file:/~evil.test/x")).hostname).toBe("evil.test");
    expect(new URL("file://evil.test/share").hostname).toBe("evil.test");
    expect(new URL("file:////evil.test/share").hostname).toBe("");
    expect(() => new URL(b("~~evil.test~share"))).toThrow();
    // file:// and smb:// hosts still count as hosts in the thread text (R2).
    expect([...hostsIn("file://bank.test/share")]).toEqual(["bank.test"]);
    expect([...hostsIn("smb://bank.test/share")]).toEqual(["bank.test"]);
  });
});

describe("D2 (round 3, owner Narrow): UNC after a leading run of non-alphanumeric characters", () => {
  const known = `${T} evil.test ${b("~~evil.test~share")}`;
  it("is flagged after quotes, guillemets, punctuation and Unicode spaces, with every slash mix", () => {
    const leads = [cp(0x201c), cp(0x2018), cp(0xab), cp(0x300c), ":", ".", "-", "~", "&", "?", "#", "_", "!", "%", ":.-", `${cp(0x201c)}${cp(0x2018)}`, cp(0x1f600)];
    for (const lead of leads)
      for (const unc of ["~~evil.test~share", "~/evil.test~s", "/~evil.test/s"].map(b)) {
        const c = `${lead}${unc}${cp(0x201d)}`;
        expect(linksNotInThread(c, known), c).toHaveLength(1);
      }
    for (const sp of [0xa0, 0x2003, 0x3000, 0x202f]) {
      const c = `at${cp(sp)}${b("~~evil.test~share")}`;
      expect(linksNotInThread(c, known), c).toHaveLength(1);
      expect(linksNotInThread(`at${cp(sp)}${cp(0x201c)}${b("~~evil.test~share")}`, known)).toHaveLength(1);
    }
  });
  it("is shown from the UNC prefix", () => {
    expect(linksNotInThread(`${cp(0x201c)}${b("~~evil.test~share")}`, T)).toEqual([b("~~evil.test~share")]);
  });
  it("is not triggered by a letter or digit before it, or by more than two slashes", () => {
    for (const c of ["a~~b", "C:~~x", "x:~~evil.test", "1~~evil.test~s", `${cp(0xe9)}~~evil.test`, `${cp(0x4f8b)}~~evil.test`, ":a~~evil.test", "-~~~evil.test", ":///evil.test", "-//", ":~~"].map(b)) {
      expect(linksNotInThread(c, T), c).toEqual([]);
    }
  });
  it("a very long punctuation run stays linear and is still flagged", () => {
    const c = "-".repeat(1_000_000) + b("~~evil.test~share");
    const t0 = performance.now();
    expect(linksNotInThread(c, T)).toHaveLength(1);
    expect(performance.now() - t0).toBeLessThan(2_000);
    const many = Array.from({ length: 100_000 }, () => `${cp(0xa0)}-`).join("") + b("~~evil.test~share");
    expect(linksNotInThread(`x${many}`, T)).toHaveLength(1);
  });
});

describe("N2: =//host and punycode TLDs (AC-L-2)", () => {
  it("flagged with only bank.test known, quiet when the host is known", () => {
    const cases: [string, string, string][] = [
      ["href=//evil.test/x", "href=//evil.test/x", "evil.test"],
      ["evil.xn--p1ai/login", "evil.xn--p1ai", "evil.xn--p1ai"],
      ["http://evil.xn--p1ai/", "http://evil.xn--p1ai/", "evil.xn--p1ai"],
      ["a=//203.0.113.9/x", "a=//203.0.113.9/x", "203.0.113.9"],
    ];
    for (const [body, shown, host] of cases) {
      expect(linksNotInThread(body, T), body).toEqual([shown]);
      expect(linksNotInThread(body, `${T} ${host}`), body).toEqual([]);
    }
  });

  it("=// needs exactly two slashes and a domain or IPv4 host", () => {
    for (const c of ["a=//", "a=///evil.test", "a=//localhost/x", "a==", "x=y"]) expect(linksNotInThread(c, T), c).toEqual([]);
  });

  it("a punycode TLD counts for a bare host only when typed in ASCII", () => {
    expect(linksIn(`evil.${cp(0x440)}${cp(0x444)}/login`)).toEqual([]);
    // An ideographic full stop is a label dot to the URL parser; the last label is still ASCII.
    expect(linksIn(`evil${cp(0x3002)}xn--p1ai`)).toEqual(["evil.xn--p1ai"]);
    expect(linksIn(`${cp(0x4f8b)}${cp(0x3002)}${cp(0x30c6)}${cp(0x30b9)}${cp(0x30c8)}`)).toEqual([]);
    expect(linksIn(`${cp(0x43f)}${cp(0x440)}${cp(0x438)}.xn--p1ai`)).toHaveLength(1);
    // The same Cyrillic TLD in a scheme link is read through the URL parser (punycode), as before for other labels.
    expect([...hostsIn(`http://evil.${cp(0x440)}${cp(0x444)}/`)]).toEqual(["evil.xn--p1ai"]);
  });
});

describe("N-1: host-less candidates inside a known link (AC-L-3, owner Q4)", () => {
  it("quiet when the outer host is known", () => {
    for (const c of ["https://bank.test/x?next=http://localhost:3000", "https://bank.test/r?u=myapp://open", "https://bank.test/a://b", "https://bank.test#x=http:/"]) {
      expect(linksNotInThread(c, T), c).toEqual([]);
    }
  });
  it("still flagged: always-flag forms, unknown hosts, and host-less candidates before the first host", () => {
    for (const c of ["https://bank.test/?u=file://x/s", "https://bank.test/?next=https://evil.test", "myapp://open?u=https://bank.test/", "https://bank.test/?u=ms-x:y", b("https://bank.test/?u=~~evil.test~s")]) {
      expect(linksNotInThread(c, T), c).toHaveLength(1);
    }
    // D1 (round 2): a real host glued to more query text still counts (a redirector splitting the query goes there).
    for (const c of [
      "https://bank.test/?next=https://evil.test&v=1",
      "https://bank.test/?next=http:evil.test&v=1",
      "https://bank.test/?u=ftp:evil.test&v=1",
      "https://bank.test/?u=//evil.test&v=1",
      "https://bank.test/?next=https://203.0.113.9&v=1",
      "https://bank.test/?next=https://evil.test!x",
      "https://bank.test/?next=https://evil.test=1",
      "https://bank.test/?next=https://evil.test+x",
      "https://bank.test/?next=https://evil.test%26v=1",
      "https://bank.test/?u=x://evil.test&v=1",
    ]) {
      expect(linksNotInThread(c, T), c).toEqual([c]);
      expect(linksNotInThread(c, `${T} evil.test 203.0.113.9`), c).toEqual([]);
    }
    // D1b (round 4): the lenient read starts after the authority's last "@", per backslash reading,
    // and also reads query text glued before an "@"; "%40" (an encoded "@") always flags.
    const P = "https://bank.test/?next=";
    const flaggedUnlessKnown = [
      `${P}https://bank.test@evil.test&v=1`,
      `${P}https://user@evil.test&v=1`,
      `${P}https://user:pw@evil.test&v=1`,
      `${P}http:bank.test@evil.test&v=1`,
      "https://bank.test/?u=x://bank.test@evil.test&v=1",
      "https://bank.test/?u=//bank.test@evil.test&v=1",
      `${P}https://user@evil.test:8080&v=1`,
      `${P}https://user@evil.test&v=1:8080`,
      b(`${P}https://bank.test~@evil.test&v=1`),
      b(`${P}https:~~evil.test&v=1`),
      `${P}https://evil.test&email=a@bank.test`,
      `${P}https://evil.test&e=a@b@bank.test`,
      `${P}https://user@203.0.113.9&v=1`,
      `${P}https://BANK.TEST@EVIL.TEST&v=1`,
      `${P}https://bank.test@evil.test.&v=1`,
      `${P}https://a@b@evil.test&v=1`,
      "//bank.test@evil.test&v=1",
      "_://bank.test@evil.test&v=1",
    ];
    for (const c of flaggedUnlessKnown) {
      expect(linksNotInThread(c, T), c).toHaveLength(1);
      expect(linksNotInThread(c, `${T} evil.test 203.0.113.9`), c).toEqual([]);
    }
    for (const c of [`${P}https://bank.test%40evil.test&v=1`, `${P}https://bank.test%40evil.test`, "https://bank.test%40evil.test/"]) {
      expect(linksNotInThread(c, `${T} evil.test`), c).toHaveLength(1);
    }
    for (const c of [`${P}https://user@bank.test&v=1`, `${P}https://a@b@bank.test&v=1`, "https://john.doe@bank.test/", "ftp://user:pw@bank.test/x", "https://bank.test/?email=a@bank.test"]) {
      expect(linksNotInThread(c, T), c).toEqual([]);
    }
    // The lenient host only adds hosts: it never clears the host-less flag.
    expect(linksNotInThread("https://bank.test%40evil.test/", T)).toEqual(["https://bank.test%40evil.test/"]);
    expect(linksNotInThread("https://bank.test/?u=https://bank.test&v=1", T)).toEqual([]);
    expect(linksNotInThread("https://bank.test/x?next=http://localhost:3000&v=1", T)).toEqual([]);
    // http://localhost on its own is still host-less, so flagged.
    expect(linksNotInThread("http://localhost:3000", T)).toEqual(["http://localhost:3000"]);
  });
});

describe("unchanged forms (AC-L-4, AC-L-5)", () => {
  it("file:evil.test is still only a bare domain; prose stays quiet", () => {
    expect(linksIn("file:evil.test")).toEqual(["evil.test"]);
    for (const c of ["C:~Users~x", "~~", "~~~~", "a~~b", "x~/y", "=~~", "a=~~~x", "research:notes", "forms-x:y"].map(b)) expect(linksIn(c), c).toEqual([]);
    expect(linksNotInThread("file:///etc/passwd", "file:///etc/passwd")).toEqual(["file:///etc/passwd"]);
  });
  it("documented as not checked", () => {
    for (const c of [`evil.${cp(0x440)}${cp(0x444)}/login`, `https${cp(0xff1a)}//evil.test`, "_://3405803785/"]) expect(linksNotInThread(c, T), c).toEqual([]);
  });
});

describe("S3a: the exact known-host index (AC-S3-1)", () => {
  /** The batch-2 rule, as the oracle: equal to, or a subdomain of, any known host on label boundaries. */
  const oracle = (h: Host, known: Set<string>) => (h.ip ? known.has(h.host) : [...known].some((k) => h.host === k || h.host.endsWith(`.${k}`)));
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const LABELS = ["a", "b", "www", "bank", "mybank", "evil", "co", "com", "test", "xn--p1ai", "sub", "bank-test"];
  const IPS = ["203.0.113.9", "203.0.113.90", "3.0.113.9", "10.0.0.1"];
  const randomHost = (): Host => {
    if (rnd(6) === 0) return { host: IPS[rnd(IPS.length)]!, ip: true };
    const n = 2 + rnd(3);
    const labels = Array.from({ length: n }, () => LABELS[rnd(LABELS.length)]!);
    labels[n - 1] = ["test", "com", "co", "xn--p1ai"][rnd(4)]!;
    return { host: labels.join("."), ip: false };
  };

  it("matches the oracle on 20,000 random pairs, including look-alike suffixes", () => {
    const wrong: string[] = [];
    for (let i = 0; i < 400; i++) {
      const known = new Set<string>();
      for (let k = rnd(8); k >= 0; k--) known.add(randomHost().host);
      for (let j = 0; j < 50; j++) {
        const h = randomHost();
        if (isKnownHost(h, known) !== oracle(h, known)) wrong.push(`${h.host} in ${[...known].join(",")}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("the classic cases", () => {
    const known = new Set(["bank.test", "evil.com", "203.0.113.9"]);
    const k = (host: string, ip = false) => isKnownHost({ host, ip }, known);
    expect([k("bank.test"), k("www.bank.test"), k("a.b.bank.test"), k("mybank.test"), k("bank.test.evil.co"), k("evil.co"), k("203.0.113.9", true), k("3.0.113.9", true)]).toEqual([
      true, true, true, false, false, false, true, false,
    ]);
  });
});

describe("S3b: cutAtTokenBoundary", () => {
  it("drops the trailing partial token, keeping the break", () => {
    expect(cutAtTokenBoundary("see bank.com")).toBe("see ");
    expect(cutAtTokenBoundary("see bank.co")).toBe("see ");
    expect(cutAtTokenBoundary("nobreak")).toBe("");
    expect(cutAtTokenBoundary("")).toBe("");
    expect(cutAtTokenBoundary("ends with a break ")).toBe("ends with a break ");
    expect(cutAtTokenBoundary("a\r\nb")).toBe("a\r\n");
    expect(cutAtTokenBoundary("a\rb")).toBe("a\r");
    expect(cutAtTokenBoundary('x href="https://bank.com')).toBe('x href="');
    expect(cutAtTokenBoundary(`x ${cp(0x1f600)}${cp(0x1f600)}`)).toBe("x ");
    expect(cutAtTokenBoundary(`${cp(0x1f600)} y`)).toBe(`${cp(0x1f600)} `);
  });
  it("a cut haystack never makes a prefix host known", () => {
    const cut = cutAtTokenBoundary("Hello from bank.com".slice(0, 18));
    expect(linksNotInThread("bank.co", cut)).toEqual(["bank.co"]);
  });
});

describe("S1: shownNewer is required (AC-S1-1)", () => {
  it("omitting it is a type error", () => {
    // Never called: the compiler is the test (npm run typecheck includes tests/).
    const typeOnly = (ex: Executor, approve: typeof approveItem) =>
      // @ts-expect-error S1 (phase-2-followups-3): shownNewer is required.
      approve(ex, { userId: "u", itemId: "i", revision: 1, contentHash: "h", ackThreadChange: false, messageIdHost: "alex.example.com" });
    expect(typeof typeOnly).toBe("function");
  });
});

describe("linear time (AC-L-7, in-process guard; the tester times each case in its own process)", () => {
  const time = (s: string) => {
    const t0 = performance.now();
    linksNotInThread(s, s);
    return performance.now() - t0;
  };
  it("1 MB adversarial inputs for the new rules stay fast", { timeout: 120_000 }, () => {
    const base = time("x".repeat(1_000_000));
    const N = 50_000;
    const many = (f: (i: number) => string, sep = "") => Array.from({ length: N }, (_, i) => f(i)).join(sep);
    const cases = [
      many((i) => b(`~~h${i}.test~s`), " "),
      many((i) => b(`=~~h${i}~`)),
      many((i) => `=//h${i}.test`),
      many((i) => b(`file:~~h${i}.test`), " "),
      many((i) => b(`file:~~h${i}.test`)),
      "ms-x:".repeat(200_000),
      "search-ms:" + b("~~").repeat(450_000),
      Array.from({ length: 1_000 }, () => "a.xn--" + "a".repeat(1_000)).join(" "),
      Array.from({ length: 1_000 }, () => "https://a.xn--" + "a".repeat(1_000)).join(" "),
      many((i) => `https://h${i}.test/?u=x://`),
      "=".repeat(1_000_000) + "x",
      b("=~").repeat(500_000),
      // D1b (round 4): userinfo runs and glued authorities.
      "https://" + "a@".repeat(400_000) + "evil.test&v=1",
      "https://bank.test/?" + many((i) => `u=https://u${i}@h${i}.test&`),
      "https://bank.test/?" + many((i) => `u=https://h${i}.test&e=a@b${i}.test&`),
      "https://" + "a&".repeat(300_000) + "@evil.test",
      "x://" + "a%40".repeat(200_000),
    ];
    for (const s of cases) expect(time(s), s.slice(0, 16)).toBeLessThan(Math.max(2_000, base * 50));
  });
});
