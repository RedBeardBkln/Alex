import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isValidAddress } from "@/lib/approvals/addresses";
import { emailSendPayload, outgoingBody, type EmailSendPayload } from "@/lib/approvals/payload";
import { MAX_LINK_TARGET, MAX_SIGNATURE_HTML, MAX_SIGNATURE_LINKS, MAX_SIGNATURE_TEXT, linkTarget, signatureToText } from "@/lib/signatures/convert";
import { ReplySignaturePreview, SignatureText } from "@/app/(app)/signature-ui";

// Tester, phase email-signatures (plan v2 section 6, owner Round 3 D1/D2). Constructed data only
// (example.com / .test). Non-ASCII characters are built with String.fromCharCode on purpose.

const ch = (c: number) => String.fromCharCode(c);
const conv = (html: string) => {
  const r = signatureToText(html);
  return r.state === "set" ? r.text : r.state;
};

/** Seeded PRNG (mulberry32), so failures reproduce. */
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

/** Every written target must satisfy plan 6.4 steps 4-8 and AC 4. Returns a problem or null. */
function targetProblem(t: string): string | null {
  if (t.length === 0 || t.length > MAX_LINK_TARGET) return "length";
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || c === 60 || c === 62) return `char ${c}`;
  }
  if (t.startsWith("http://") || t.startsWith("https://")) {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      return "unparsable http";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "protocol";
    if (u.username !== "" || u.password !== "") return "credentials";
    if (u.href !== t) return "not normalized";
    return null;
  }
  if (t.startsWith("mailto:")) return isValidAddress(t.slice(7)) ? null : "mailto address";
  if (t.startsWith("tel:")) return /^tel:\+?[0-9]{3,20}$/.test(t) ? null : "tel shape";
  return "scheme";
}

describe("tester: scheme allowlist under obfuscation", () => {
  it("one inserted code point (every BMP code point, no surrogates) never turns javascript: into a target", () => {
    const bad: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const x = ch(c);
      for (const href of [`java${x}script:alert(1)`, `${x}javascript:alert(1)`, `javascript${x}:alert(1)`, `j${x}avascript:alert(1)`]) {
        const t = linkTarget(href, "x");
        if (t !== null) bad.push(`${c.toString(16)}:${t}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("entity, whitespace and control obfuscation at every position of javascript:, vbscript:, data:", () => {
    const inserts = ["\t", "\n", "\r", "&#9;", "&#x09;", "&#10;", "&#x0A;", "&#13;", "&#0;", ch(0), "&#1;", ch(1), " ", "&#32;", ch(0xa0), "&nbsp;", ch(0xad), "&#173;", ch(0x200b), ch(0xfeff), "%09", "%00", "&Tab;", "&NewLine;", "&colon;"];
    const bad: string[] = [];
    for (const scheme of ["javascript", "vbscript", "data", "JaVaScRiPt", "file", "blob"]) {
      for (let p = 0; p <= scheme.length; p++) {
        for (const ins of inserts) {
          const href = `${scheme.slice(0, p)}${ins}${scheme.slice(p)}:alert(1)`;
          const t = linkTarget(href, "x");
          if (t !== null) bad.push(`${JSON.stringify(href)} -> ${t}`);
          const out = conv(`<a href="${href}">x</a>`);
          if (out !== "x") bad.push(`${JSON.stringify(href)} => ${JSON.stringify(out)}`);
        }
      }
    }
    // Fully entity-encoded schemes, decimal and hex, with and without semicolons.
    const enc = (s: string, f: (c: number) => string) => [...s].map((c) => f(c.charCodeAt(0))).join("");
    for (const f of [(c: number) => `&#${c};`, (c: number) => `&#x${c.toString(16)};`, (c: number) => `&#${c}`, (c: number) => `&#X${c.toString(16).toUpperCase()}`, (c: number) => `&#000${c};`]) {
      const href = `${enc("javascript:", f)}alert(1)`;
      if (linkTarget(href, "x") !== null) bad.push(href);
    }
    expect(bad).toEqual([]);
  });

  it("other schemes, relative and scheme-relative links, and credentials never give a target", () => {
    const hrefs = [
      "vbscript:msgbox(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "blob:https://x.test/1",
      "ftp://x.test/",
      "sms:+15551234567",
      "ws://x.test/",
      "wss://x.test/",
      "about:blank",
      "chrome://settings",
      "intent://x.test#Intent;end",
      "x-unknown:foo",
      "/relative",
      "relative/path",
      "./a",
      "../a",
      "?q=1",
      "#frag",
      "//evil.test/",
      "///evil.test/",
      "",
      " ",
      "https://",
      "http://",
      "https://bank.test@evil.test/",
      "https://bank.test:pw@evil.test/",
      "https://%40@evil.test/",
      "HTTPS://U@EVIL.TEST/",
      "https://u@evil.test@x.test/",
      "https://[::1",
    ];
    const bad = hrefs.map((h) => [h, linkTarget(h, "x")] as const).filter(([, t]) => t !== null);
    expect(bad).toEqual([]);
  });

  it("fuzz: every target linkTarget writes satisfies the allowlist and the final gate", () => {
    const pieces = [
      "https://", "http://", "HtTpS:", "hTTp:", "mailto:", "MAILTO:", "tel:", "TEL:", "javascript:", "data:", "//", "/", "\\", "@", ":", "x.test", "bank.test", "a", "1", "555", "+", " ", "\t", "\n",
      ch(0), ch(0x7f), ch(0x85), ch(0xa0), ch(0x202e), ch(0xe9), "%3F", "%3C", "%3E", "%20", "%40", "%2C", "%23", "%25", "%", "&amp;", "&#9;", "&#x3c;", "&lt;", "&gt;", "&#62;", "&#64;", "?", "#",
      "<", ">", '"', "'", "`", "(", ")", "-", ".", "xn--", "[::1]", "127.0.0.1", ",", ";", "=", "&", "{", "|", "^",
    ];
    const r = rng(20261127);
    const problems: string[] = [];
    let written = 0;
    for (let n = 0; n < 150_000; n++) {
      const k = 1 + Math.floor(r() * 8);
      let href = "";
      for (let i = 0; i < k; i++) href += pieces[Math.floor(r() * pieces.length)]!;
      const t = linkTarget(href, r() < 0.5 ? "x" : href);
      if (t === null) continue;
      written++;
      const p = targetProblem(t);
      if (p) problems.push(`${JSON.stringify(href)} -> ${t} (${p})`);
    }
    expect(problems.slice(0, 20)).toEqual([]);
    expect(written).toBeGreaterThan(800); // the fuzz reaches the writing branches
  });

  it("fuzz: through the full converter, every <...> in the output is a valid target (no attribute or hidden text leaks)", () => {
    // Visible text pieces contain no "<", "&" or ":", so any "<...>" in the output can only be a written target.
    const textPieces = ["Jane", " ", "  ", "Doe", ".", "x.test", "555 123", "/", "-", ch(0xa0), "\n", "\t", "Book", "a"];
    const hrefPieces = ["https://", "http://", "mailto:", "tel:", "javascript:", "data:", "//", "@", "x.test", "a", "555", "+", " ", "%3F", "%3C", "&amp;", "&#9;", "&lt;", ">", "<", "?", "#", "'", '"', "=", ch(0xe9)];
    const r = rng(7);
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
    const href = () => {
      let h = "";
      const k = 1 + Math.floor(r() * 5);
      for (let i = 0; i < k; i++) h += pick(hrefPieces);
      return h;
    };
    const tags = [
      () => `<a href="${href().replace(/"/g, "")}">`,
      () => `<a href='${href().replace(/'/g, "")}'>`,
      () => `<a href=${href().replace(/[\s>"']/g, "")}>`,
      () => `<a title="${href().replace(/"/g, "")}>LEAK" href="${href().replace(/"/g, "")}">`,
      () => "</a>",
      () => "<div>",
      () => "</div>",
      () => "<br>",
      () => "<p>",
      () => "</td>",
      () => `<img src="${href().replace(/"/g, "")}" alt="LEAK>">`,
      () => `<span title='LEAK>${href().replace(/'/g, "")}'>`,
      () => `<!-- LEAK <a href="https://evil.test/">e</a> -->`,
      () => `<script>LEAK<a href="https://evil.test/">e</a></script>`,
      () => `<style>LEAK{}</style>`,
    ];
    const problems: string[] = [];
    let withTargets = 0;
    for (let n = 0; n < 20_000; n++) {
      let html = "";
      const k = 1 + Math.floor(r() * 14);
      for (let i = 0; i < k; i++) html += r() < 0.5 ? pick(textPieces) : pick(tags)();
      const out = conv(html);
      if (out === "none" || out === "too_large") continue;
      if (out.includes("LEAK")) problems.push(`leak: ${JSON.stringify(html)} => ${JSON.stringify(out)}`);
      if (out.includes("evil.test")) problems.push(`hidden link: ${JSON.stringify(html)}`);
      const opens = out.split("<").length - 1;
      const closes = out.split(">").length - 1;
      const found = [...out.matchAll(/<([^<>]*)>/g)];
      if (opens !== found.length || closes !== found.length) problems.push(`brackets: ${JSON.stringify(html)} => ${JSON.stringify(out)}`);
      for (const m of found) {
        const p = targetProblem(m[1]!);
        if (p) problems.push(`${p}: ${JSON.stringify(html)} => ${JSON.stringify(out)}`);
      }
      if (found.length > 0) withTargets++;
      // Clean-up invariants (plan 6.3 step 5).
      for (let i = 0; i < out.length; i++) {
        const c = out.charCodeAt(i);
        if ((c < 0x20 && c !== 10) || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0xa0) problems.push(`char ${c}: ${JSON.stringify(html)}`);
      }
      if (/\n\n\n/.test(out) || /^\n|\n$/.test(out) || /(^|\n) | ( $|\n)/.test(out) || /  /.test(out)) problems.push(`spacing: ${JSON.stringify(html)} => ${JSON.stringify(out)}`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(withTargets).toBeGreaterThan(400);
  });
});

describe("tester: mailto rebuilding drops the query (plan 6.4 step 6)", () => {
  // Plan 6.4 step 6: the target is mailto: plus one valid address, and "the query and fragment
  // (?subject=, body=, cc=) are dropped" because "pre-filled bodies or extra recipients are hidden
  // behaviour". isValidAddress accepts "?", "#", "&" and "=" in a local part (RFC 5322 atext), so a
  // percent-encoded "?" in the path comes back as a live query in the rebuilt target.
  it("a written mailto target never carries a query or fragment, however the href encodes it", () => {
    const hrefs = [
      "mailto:a@x.test?cc=evil@x.test",
      "mailto:a%3Fcc=evil@x.test",
      "mailto:me%3Fbody=Wire%26to=attacker@x.test",
      "mailto:a%23frag@x.test",
      "mailto:a%3fbcc=evil@x.test",
    ];
    const written = hrefs.map((h) => [h, linkTarget(h, "Email me")] as const).filter(([, t]) => t !== null && /[?#]/.test(t));
    expect(written).toEqual([]);
  });
});

describe("tester: caps", () => {
  it("raw href cap is on the raw (entity-encoded) length: 2,048 kept, 2,049 dropped even if it decodes shorter", () => {
    const base = "https://x.test/";
    const at = (n: number) => `${base}${"a".repeat(n - base.length - 5)}&amp;`;
    expect(at(2048).length).toBe(2048);
    expect(linkTarget(at(2048), "x")).not.toBeNull();
    expect(at(2049).length).toBe(2049);
    expect(linkTarget(at(2049), "x")).toBeNull();
  });

  it("the final gate counts the normalized target: percent-encoding that pushes it past 2,048 drops it", () => {
    const base = "https://x.test/";
    const ok = `${base}${"a".repeat(2029)} b`; // raw 2,046, target 2,048 (" " becomes %20)
    expect(ok.length).toBe(2046);
    expect(linkTarget(ok, "x")?.length).toBe(2048);
    const over = `${base}${"a".repeat(2030)} b`; // raw 2,047, target 2,049
    expect(linkTarget(over, "x")).toBeNull();
    expect(linkTarget(`${base}${ch(0xe9).repeat(400)}`, "x")).toBeNull(); // raw 415, target 2,415
    expect(conv(`<a href="${over}">Book</a>`)).toBe("Book");
  });

  it("visible text over 2,048 units is never 'equal', so the target is written", () => {
    // "./" segments are removed by URL normalization, so this text normalizes to the target.
    const short = `https://x.test/${"./".repeat(10)}a`;
    expect(linkTarget("https://x.test/a", short)).toBeNull();
    const long = `https://x.test/${"./".repeat(1100)}a`;
    expect(long.length).toBeGreaterThan(MAX_LINK_TARGET);
    expect(new URL(long).href).toBe("https://x.test/a");
    expect(linkTarget("https://x.test/a", long)).toBe("https://x.test/a");
  });

  it("the 20-link cap counts only anchors whose target is written", () => {
    const parts: string[] = [];
    for (let i = 0; i < 30; i++) {
      parts.push(`<a href="javascript:x">j${i}</a>`); // dropped: doesn't count
      parts.push(`<a href="https://e${i}.test/">e${i}.test</a>`); // equal text: no suffix, doesn't count
      parts.push(`<a href="https://v${i}.test/">v${i}</a>`); // written: counts
    }
    const out = conv(parts.join(" "));
    expect(typeof out).toBe("string");
    for (let i = 0; i < 30; i++) {
      expect(out.includes(`v${i} <https://v${i}.test/>`)).toBe(i < MAX_SIGNATURE_LINKS);
      expect(out.includes(`<https://e${i}.test/>`)).toBe(false);
      expect(out.includes(`j${i} <`)).toBe(false);
    }
    expect(out.split("<").length - 1).toBe(MAX_SIGNATURE_LINKS);
  });

  it("output cap reached through a written target: 10,000 is set, 10,001 is too_large (never cut)", () => {
    const suffix = " <https://x.test/>";
    const html = (n: number) => `<a href="https://x.test/">${"a".repeat(n)}</a>`;
    const exact = signatureToText(html(MAX_SIGNATURE_TEXT - suffix.length));
    expect(exact.state).toBe("set");
    expect(exact.state === "set" && exact.text.length).toBe(MAX_SIGNATURE_TEXT);
    expect(signatureToText(html(MAX_SIGNATURE_TEXT - suffix.length + 1))).toEqual({ state: "too_large" });
  });

  it("input cap counts UTF-16 units: 32,768 astral characters are scanned, one more unit is too_large", () => {
    const astral = String.fromCodePoint(0x1f600);
    const html = astral.repeat(32_768);
    expect(html.length).toBe(MAX_SIGNATURE_HTML);
    // 65,536 units of text is over the 10,000 output cap, so it's too_large for that reason; check
    // the scan really ran on a short-output version at the same input length instead.
    const comment = `<!--${"x".repeat(MAX_SIGNATURE_HTML - 9)}-->ok`;
    expect(comment.length).toBe(MAX_SIGNATURE_HTML);
    expect(conv(comment)).toBe("ok");
    expect(conv(`${comment} `)).toBe("too_large");
    expect(conv(html)).toBe("too_large");
  });
});

describe("tester: quote-aware tag parsing", () => {
  it("'>' inside quoted attribute values of any tag never leaks text", () => {
    expect(conv(`<div title="x>LEAK">ok</div>`)).toBe("ok");
    expect(conv(`<img alt='>LEAK' src="x">ok`)).toBe("ok");
    expect(conv(`<a title=">LEAK" href="https://x.test/">Book</a>`)).toBe("Book <https://x.test/>");
    expect(conv(`<a href="https://x.test/"title="a>LEAK">Book</a>`)).toBe("Book <https://x.test/>");
    expect(conv(`<a data-x='"' href="https://x.test/" data-y='">LEAK'>Book</a>`)).toBe("Book <https://x.test/>");
    expect(conv(`<span style="font-family:'a>b'">ok</span>`)).toBe("ok");
  });

  it("an href attribute inside another attribute's quoted value is not read", () => {
    expect(conv(`<a title=' href="https://evil.test/" ' href="https://good.test/">Book</a>`)).toBe("Book <https://good.test/>");
    expect(conv(`<a title="href=https://evil.test/">Book</a>`)).toBe("Book");
  });

  it("an unterminated quote or tag ends the scan (fails toward less text)", () => {
    expect(conv(`ok<div title="abc>rest of the signature`)).toBe("ok");
    expect(conv(`ok<a href='https://x.test/>Book</a> more`)).toBe("ok");
    expect(conv(`<a href="https://x.test/">Book<span title="x>more text`)).toBe("Book <https://x.test/>");
    expect(conv(`<a href="https://x.test/">x</a><!-- never closed <a href="https://evil.test/">e</a>`)).toBe("x <https://x.test/>");
    expect(conv(`ok<script>never closed`)).toBe("ok");
  });

  it("raw-text content (script, style, title, textarea, noscript, template, iframe) is dropped, case-insensitively", () => {
    for (const name of ["script", "style", "title", "textarea", "xmp", "noscript", "template", "noembed", "noframes", "iframe"]) {
      const up = name.toUpperCase();
      expect(conv(`a<${up} x="1">LEAK<a href="https://evil.test/">e</a></${name}>b`), name).toBe("ab");
    }
  });
});

describe("tester: D1 single line spacing (owner Round 3)", () => {
  it.each([
    ["<ul><li>a</li><li>b</li></ul>", "a\nb"],
    ["a<hr>b", "a\nb"],
    ["<br>a", "a"],
    ["<div><div><div>a</div></div></div><div>b</div>", "a\nb"],
    ["<table><tr><td>a</td></tr></table>b", "a\nb"],
    ["<blockquote>q</blockquote>after", "q\nafter"],
    ["<h1>T</h1><p>p</p>", "T\np"],
    ["<div>a</div>\n\n   \n<div>b</div>", "a\nb"],
    ["<div>a</div><div></div><div></div><div>b</div>", "a\nb"],
    ["<div>a</div><div><br></div><div><br></div><div><br></div><div>b</div>", "a\n\nb"],
    ["<div>a<br></div><div>b</div>", "a\nb"],
    ["<div>a<br><br></div><div>b</div>", "a\n\nb"],
    ["<div><span>a</span></div><div><span> </span></div><div>b</div>", "a\nb"],
    ['<div><a href="https://x.test/">Book</a></div><div><a href="https://y.test/"><img></a></div><div>c</div>', "Book <https://x.test/>\n<https://y.test/>\nc"],
  ])("%j", (html, expected) => {
    expect(conv(html)).toBe(expected);
  });
});

describe("tester: D2 tel digit matching (owner Round 3)", () => {
  it("suppresses the suffix only when the ASCII digits are equal", () => {
    expect(conv('<a href="tel:+15551234567">+1 (555) 123-4567</a>')).toBe("+1 (555) 123-4567");
    expect(conv('<a href="tel:+15551234567">1.555.123.4567</a>')).toBe("1.555.123.4567");
    expect(conv('<a href="tel:+15551234567">+1 555 765 4321</a>')).toBe("+1 555 765 4321 <tel:+15551234567>");
    expect(conv('<a href="tel:+15551234567">+1 555 123 456</a>')).toBe("+1 555 123 456 <tel:+15551234567>");
    expect(conv('<a href="tel:+15551234567">Call</a>')).toBe("Call <tel:+15551234567>");
    // Fullwidth digits are not ASCII digits.
    const fw = [..."15551234567"].map((d) => ch(0xff10 + Number(d))).join("");
    expect(conv(`<a href="tel:+15551234567">${fw}</a>`)).toBe(`${fw} <tel:+15551234567>`);
    // D2 is tel-only: a spaced http or mailto text is never "equal".
    expect(conv('<a href="https://x.test/">x .test</a>')).toBe("x .test <https://x.test/>");
  });

  it("a rejected tel href keeps only the text, whatever the digits", () => {
    expect(conv('<a href="tel:+1555;ext=1">+1555</a>')).toBe("+1555");
    expect(conv('<a href="tel:12">12</a>')).toBe("12");
  });
});

describe("tester: cost", () => {
  const fill = (unit: string, extra = "") => unit.repeat(Math.floor((MAX_SIGNATURE_HTML - extra.length) / unit.length)) + extra;
  const after = (prefix: string, unit: string) => prefix + unit.repeat(Math.floor((MAX_SIGNATURE_HTML - prefix.length) / unit.length));
  const hostile: [string, string][] = [
    ["equal-text anchors (4 URL parses each, uncapped count)", fill('<a href="https://a.test/">a.test</a>')],
    ["rejected anchors with text", fill('<a href="javascript:x">aaaa</a>')],
    ["2,048-unit hrefs", fill(`<a href="https://x.test/${"a".repeat(2030)}">x</a>`)],
    ["2,048-unit equal visible text", fill(`<a href="https://x.test/${"a".repeat(1000)}">x.test/${"a".repeat(1000)}</a>`)],
    ["one anchor spanning everything", after(`<a href="https://x.test/">`, "a<b>")],
    ["nested opens", fill('<a href="https://x.test/">')],
    ["attributes without end", after("<a ", "x=1 ")],
    ["quoted attrs", fill(`<a x="'" y='"' z=">">`)],
    ["over-long numeric entities", fill("&#123456789012")],
    ["hex entities", fill("&#x1F600;")],
    ["named entity lookalikes", fill("&amp&nbsp&lt")],
    ["comment openers", fill("<!--x-->")],
    ["unclosed comment", `${fill("a")}<!--`.slice(-MAX_SIGNATURE_HTML)],
    ["raw-text opens with closes", fill("<script></script>")],
    ["raw-text opens without close", fill("<style>")],
    ["many blocks", fill("<div></div>")],
    ["many breaks", fill("<br>")],
    ["lt text", fill("< ")],
    ["tel anchors with digits", fill('<a href="tel:+15551234567">+1 555 123 4567</a>')],
    ["whitespace runs", fill(" \t\n")],
    ["nbsp runs", fill(ch(0xa0))],
  ];
  it.each(hostile)("%s finishes within 1 s", (_name, html) => {
    expect(html.length).toBeLessThanOrEqual(MAX_SIGNATURE_HTML);
    const t0 = performance.now();
    signatureToText(html);
    signatureToText(html);
    expect((performance.now() - t0) / 2).toBeLessThan(1_000);
  });
});

describe("tester: outgoingBody with a signature", () => {
  const base: EmailSendPayload = {
    to: ["bob@example.org"],
    cc: [],
    subject: "Hi",
    bodyText: "Hello",
    quote: null,
    threading: null,
    replyToNotice: false,
  };
  const SIG = "Jane\nExample <https://example.com/>";
  it("body of only newlines gives the signature alone; trailing spaces before the newline are kept", () => {
    expect(outgoingBody({ ...base, bodyText: "\n\n\n", signature: { text: SIG } })).toBe(SIG);
    expect(outgoingBody({ ...base, bodyText: "a \n", signature: { text: SIG } })).toBe(`a \n\n${SIG}`);
    expect(outgoingBody({ ...base, bodyText: "a\n \n", signature: { text: SIG } })).toBe(`a\n \n\n${SIG}`);
  });
  it("an excluded or empty quote is never added; null signature equals no signature byte for byte", () => {
    const q = { ...base, quote: { included: false, text: "On Mon:\n> hi" } };
    expect(outgoingBody({ ...q, signature: { text: SIG } })).toBe(`Hello\n\n${SIG}`);
    expect(outgoingBody({ ...base, quote: { included: true, text: "" }, signature: { text: SIG } })).toBe(`Hello\n\n${SIG}`);
    const withQuote = { ...base, bodyText: "", quote: { included: true, text: "> q" } };
    expect(outgoingBody({ ...withQuote, signature: null })).toBe(outgoingBody(withQuote));
    expect(outgoingBody(withQuote)).toBe("\n\n> q");
    expect(outgoingBody({ ...withQuote, signature: { text: SIG } })).toBe(`${SIG}\n\n> q`);
  });
  it("the payload refuses CR, NUL and DEL in a snapshot, but not bidi characters (they are warned about)", () => {
    for (const bad of ["a\rb", `a${ch(0)}b`, `a${ch(0x7f)}b`, "", "x".repeat(10_001)]) {
      expect(emailSendPayload.safeParse({ ...base, signature: { text: bad } }).success, JSON.stringify(bad.slice(0, 5))).toBe(false);
    }
    expect(emailSendPayload.safeParse({ ...base, signature: { text: `a${ch(0x202e)}b` } }).success).toBe(true);
    expect(emailSendPayload.safeParse({ ...base, signature: { text: "x".repeat(10_000) } }).success).toBe(true);
    expect(emailSendPayload.safeParse({ ...base, signature: "text" }).success).toBe(false);
    expect(emailSendPayload.safeParse({ ...base, signature: { text: "a", html: "<b>a</b>" } }).success).toBe(false);
  });
});

describe("tester: signature UI renders text, never markup", () => {
  it("markup-looking signature text is escaped in the preview and the <pre>", () => {
    const evil = `<img src=x onerror=alert(1)><script>alert(1)</script> & "q"`;
    for (const el of [createElement(SignatureText, { text: evil }), createElement(ReplySignaturePreview, { signature: { state: "set", text: evil } })]) {
      const html = renderToStaticMarkup(el);
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<script");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
  });
});

describe("tester round 2: D-1 mailto encodings", () => {
  const E = "Email me";
  it("no written mailto target ever contains ?, # or %, across encodings", () => {
    const fw = (c: number) => ch(c);
    const hrefs = [
      "mailto:a%3Fcc=e@x.test",
      "mailto:a%3fcc=e@x.test",
      "mailto:a%253Fcc=e@x.test",
      "mailto:a%25253Fcc=e@x.test",
      "mailto:a%23f@x.test",
      "mailto:a%25@x.test",
      "mailto:a&#37;3Fcc=e@x.test",
      "mailto:a&#x25;3Fcc=e@x.test",
      "mailto:a&percnt;3Fcc=e@x.test",
      "mailto:a%3\tF@x.test",
      "mailto:a%3\nFcc=e@x.test",
      "mailto:a%%3F@x.test",
      "mailto:a%3%46@x.test",
      "mailto:a%C0%BFcc=e@x.test", // overlong UTF-8 for "?"
      "mailto:a%E0%80%BF@x.test", // overlong 3-byte "?"
      "mailto:a%ED%A0%80@x.test", // encoded surrogate
      "mailto:a%00@x.test",
      "mailto:a%00%3Fcc=e@x.test",
      `mailto:a${fw(0xff1f)}cc=e@x.test`, // fullwidth ?
      `mailto:a${fw(0xfe56)}cc=e@x.test`, // small ?
      `mailto:a${fw(0xff03)}f@x.test`, // fullwidth #
      `mailto:a%EF%BC%9Fcc=e@x.test`, // fullwidth ? percent-encoded
      "mailto:a%3Fcc=e%40x.test", // encoded @
      "MAILTO:A%3FCC=E@X.TEST",
      "mailto:%3F@x.test",
      "mailto:a@x.test%3Fcc=e@y.test",
      "mailto:a@x.test%23f",
      "mailto:a@x.test?cc=e@y.test#f",
    ];
    const bad: string[] = [];
    for (const h of hrefs) {
      const t = linkTarget(h, E);
      if (t !== null && (/[?#%]/.test(t) || targetProblem(t) !== null)) bad.push(`${JSON.stringify(h)} -> ${t}`);
      const out = conv(`<a href="${h}">${E}</a>`);
      if (/[?#%]/.test(out)) bad.push(`${JSON.stringify(h)} => ${out}`);
    }
    expect(bad).toEqual([]);
    // Positive controls: still written, query dropped, encoded @ decoded to a single valid address.
    expect(linkTarget("mailto:a@x.test?cc=e@y.test#f", E)).toBe("mailto:a@x.test");
    expect(linkTarget("mailto:a%40x.test", E)).toBe("mailto:a@x.test");
    expect(linkTarget("mailto:a+b&c=d@x.test", E)).toBe("mailto:a+b&c=d@x.test");
    expect(linkTarget("mailto:a%2Bb@x.test", E)).toBe("mailto:a+b@x.test");
  });

  it("fuzz: random percent and entity encodings of mailto delimiters never yield ?, # or % in a target", () => {
    const pieces = ["mailto:", "a", "b", "@", "x.test", "%3F", "%3f", "%23", "%25", "%2", "%", "3F", "&#37;", "&#63;", "&#35;", "&amp;", "?", "#", "=", "&", "+", "%40", "%0A", "\t", ".", "cc", "%C0%BF", "%EF%BC%9F"];
    const r = rng(31337);
    let written = 0;
    const bad: string[] = [];
    for (let n = 0; n < 60_000; n++) {
      let h = "mailto:";
      const k = 1 + Math.floor(r() * 4);
      for (let i = 0; i < k; i++) h += r() < 0.5 ? "a" : pieces[Math.floor(r() * pieces.length)]!;
      h += r() < 0.8 ? "@x.test" : "";
      const tail = Math.floor(r() * 3);
      for (let i = 0; i < tail; i++) h += pieces[Math.floor(r() * pieces.length)]!;
      const t = linkTarget(h, "x");
      if (t === null) continue;
      written++;
      if (/[?#%]/.test(t) || targetProblem(t) !== null) bad.push(`${JSON.stringify(h)} -> ${t}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(written).toBeGreaterThan(200);
  });
});
