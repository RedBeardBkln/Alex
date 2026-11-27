import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentHash, emailSendPayload, outgoingBody, type EmailSendPayload } from "@/lib/approvals/payload";
import { buildEmailPayload } from "@/lib/approvals/service";
import { buildMessage } from "@/lib/gmail/compose";
import { MAX_LINK_TARGET, MAX_SIGNATURE_HTML, MAX_SIGNATURE_LINKS, MAX_SIGNATURE_TEXT, linkTarget, signatureToText } from "@/lib/signatures/convert";
import { signatureErrorCode } from "@/lib/signatures/refresh";
import { signatureSnapshot } from "@/lib/signatures/store";
import { GmailApiError, GmailShapeError } from "@/lib/gmail/client";
import { signatureUpdatedDetail } from "@/lib/audit-details";

// Phase email-signatures, plan section 11.1. Constructed fixtures only (example.com/.test data).

const text = (html: string) => {
  const r = signatureToText(html);
  return r.state === "set" ? r.text : r.state;
};
const ch = (c: number) => String.fromCharCode(c);

describe("signatureToText: text", () => {
  it("empty and whitespace-only input give none", () => {
    expect(signatureToText("")).toEqual({ state: "none" });
    expect(signatureToText("   \n\t ")).toEqual({ state: "none" });
    expect(signatureToText("<div><br></div><p>&nbsp;</p>")).toEqual({ state: "none" });
    expect(signatureToText("<img src=\"https://x.test/logo.png\">")).toEqual({ state: "none" });
  });

  it("entities: named, numeric, hex, invalid, over-long, unknown", () => {
    expect(text("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe("a & b <c> \"d\" 'e'");
    expect(text("&#65;&#x42;&#X43;")).toBe("ABC");
    expect(text("x&#0;y")).toBe(`x${ch(0xfffd)}y`);
    expect(text("x&#xD800;y")).toBe(`x${ch(0xfffd)}y`);
    expect(text("x&#x110000;y")).toBe(`x${ch(0xfffd)}y`);
    expect(text("x&#123456789;y")).toBe(`x${ch(0xfffd)}y`);
    expect(text("&copy; &bogus; & alone")).toBe("&copy; &bogus; & alone");
  });

  it("whitespace collapses; source newlines aren't line breaks; NBSP becomes a space", () => {
    expect(text("Jane\n   Doe\t\tExample")).toBe("Jane Doe Example");
    expect(text("a&nbsp;&nbsp;&nbsp;b")).toBe("a b");
    expect(text("a\r\nb\rc")).toBe("a b c");
  });

  it("line-break elements (opening or closing) and cell spaces; a block adds a break only when not at a line start (Round 3, D1)", () => {
    expect(text("a<br>b<br/>c<BR >d")).toBe("a\nb\nc\nd");
    expect(text("<div>a</div>b")).toBe("a\nb");
    expect(text("<div>a</div><div>b</div>")).toBe("a\nb");
    expect(text("<p>a</p><p>b</p>")).toBe("a\nb");
    expect(text("a<hr>b")).toBe("a\nb");
    expect(text("<ul><li>a</li><li>b</li></ul>")).toBe("a\nb");
    expect(text("<h1>T</h1>x")).toBe("T\nx");
    expect(text("<table><tr><td>a</td><td>b</td></tr><tr><th>c</th><td>d</td></tr></table>")).toBe("a b\nc d");
    expect(text("<table><tr><td><table><tr><td>in</td><td>ner</td></tr></table></td><td>out</td></tr></table>")).toBe("in ner\nout");
    expect(text("a<br><br><br><br><br>b")).toBe("a\n\nb");
  });

  it("Round 3, D1: a realistic one-div-per-line Gmail signature keeps single spacing", () => {
    const gmail =
      '<div dir="ltr"><div>Jane Doe</div>\n<div>Head of Operations, Example Co</div>\n<div>+1 (555) 123-4567</div>\n' +
      '<div><br></div>\n<div><a href="https://cal.example.com/jane">Book a meeting</a> | <a href="https://www.example.com/">www.example.com</a></div></div>';
    expect(text(gmail)).toBe("Jane Doe\nHead of Operations, Example Co\n+1 (555) 123-4567\n\nBook a meeting <https://cal.example.com/jane> | www.example.com");
  });

  it("Round 3, D1 edge cases: <br> inside a div, empty divs, nested divs, &nbsp; lines", () => {
    // <div><br></div> is Gmail's blank line: one blank line, not two.
    expect(text("<div>a</div><div><br></div><div>b</div>")).toBe("a\n\nb");
    // A <br> ending a div's text doesn't add a second break when the div closes.
    expect(text("<div>a<br></div><div>b</div>")).toBe("a\nb");
    expect(text("<div>a<br><br></div><div>b</div>")).toBe("a\n\nb");
    // An empty div adds nothing (Gmail shows nothing for it).
    expect(text("<div>a</div><div></div><div>b</div>")).toBe("a\nb");
    expect(text("<div>a</div><div> </div><div>b</div>")).toBe("a\nb");
    // A div holding only &nbsp; is a visible blank line in Gmail, and here too.
    expect(text("<div>a</div><div>&nbsp;</div><div>b</div>")).toBe("a\n\nb");
    // Nested divs open and close several blocks at once: still single breaks.
    expect(text('<div dir="ltr"><div><div>a</div></div><div><div><b>b</b></div></div></div>')).toBe("a\nb");
    // Source whitespace between blocks doesn't count as content.
    expect(text("<div>a</div>\n   \n<div>b</div>")).toBe("a\nb");
    // An image-only link line is content.
    expect(text('<div><a href="https://x.example/"><img></a></div><div>b</div>')).toBe("<https://x.example/>\nb");
    // A link whose text ends a block: the break follows the target.
    expect(text('<div><a href="https://x.example/">X</a></div><div>b</div>')).toBe("X <https://x.example/>\nb");
  });

  it("raw-text elements, comments and <!…>/<?…> are skipped; unterminated ones end the scan", () => {
    expect(text("a<script>var x = '<b>';</script>b")).toBe("ab");
    expect(text("a<style>p{}</style>b<title>t</title>c")).toBe("abc");
    expect(text("a<!-- hidden <b>x</b> -->b")).toBe("ab");
    expect(text("a<!DOCTYPE html>b<?xml x?>c")).toBe("abc");
    expect(text("a<!-- never closed b")).toBe("a");
    expect(text("a<script>never closed")).toBe("a");
    expect(text("a<div class=\"x b")).toBe("a");
    expect(text("a<div")).toBe("a");
  });

  it("quoted attribute values may contain >", () => {
    expect(text("<span title=\"a>b\">x</span>")).toBe("x");
    expect(text("<span title='a>b'>x</span>")).toBe("x");
  });

  it("a < that doesn't start a tag is text", () => {
    expect(text("1 < 2 and <3")).toBe("1 < 2 and <3");
  });

  it("controls are removed; lone surrogates become U+FFFD; bidi and tag characters are kept", () => {
    expect(text(`a${ch(1)}b${ch(0x7f)}c${ch(0x85)}d`)).toBe("abcd");
    expect(text(`a${ch(0xd800)}b`)).toBe(`a${ch(0xfffd)}b`);
    const rlo = ch(0x202e);
    const tag = String.fromCodePoint(0xe0041);
    expect(text(`a${rlo}b${tag}c${ch(0x200b)}d`)).toBe(`a${rlo}b${tag}c${ch(0x200b)}d`);
  });

  it("input cap: 65,536 units is scanned, 65,537 is too_large", () => {
    const pad = (n: number) => "x" + " ".repeat(n - 1);
    expect(MAX_SIGNATURE_HTML).toBe(65_536);
    expect(signatureToText(pad(65_536))).toEqual({ state: "set", text: "x" });
    expect(signatureToText(pad(65_537))).toEqual({ state: "too_large" });
  });

  it("output cap: exactly 10,000 is set, 10,001 is too_large (not cut)", () => {
    expect(MAX_SIGNATURE_TEXT).toBe(10_000);
    expect(signatureToText("a".repeat(10_000))).toEqual({ state: "set", text: "a".repeat(10_000) });
    expect(signatureToText("a".repeat(10_001))).toEqual({ state: "too_large" });
  });
});

describe("signatureToText: links", () => {
  it("writes the target after the text", () => {
    expect(text("<a href=\"https://cal.example.com/jane\">Book a meeting</a>")).toBe("Book a meeting <https://cal.example.com/jane>");
    expect(text("<A HREF='https://x.example/a?b=1&amp;c=2'>x</A>")).toBe("x <https://x.example/a?b=1&c=2>");
    expect(text("<a href=https://x.example/>Site</a>")).toBe("Site <https://x.example/>");
  });

  it("no suffix when the text already is the target", () => {
    expect(text("<a href=\"https://www.example.com/\">www.example.com</a>")).toBe("www.example.com");
    expect(text("<a href=\"https://example.com/\">Example.COM</a>")).toBe("Example.COM");
    expect(text("<a href=\"https://example.com/path\">https://example.com/path</a>")).toBe("https://example.com/path");
    expect(text("<a href=\"mailto:jane@example.com\">jane@example.com</a>")).toBe("jane@example.com");
    expect(text("<a href=\"mailto:jane@example.com\">Jane@Example.com</a>")).toBe("Jane@Example.com");
    expect(text("<a href=\"tel:+15551234567\">+1(555)123-4567</a>")).toBe("+1(555)123-4567");
    // Round 3, D2 (tel only): equal digits in the text skip the suffix, spaces and punctuation included.
    expect(text("<a href=\"tel:+15551234567\">+1 (555) 123-4567</a>")).toBe("+1 (555) 123-4567");
    expect(text("<a href=\"tel:+1 (555) 123-4567\">1 555 123 4567</a>")).toBe("1 555 123 4567");
  });

  it("Round 3, D2 edge cases: digits that differ, text with no digits; http/https/mailto stay exact", () => {
    // One digit different, one missing, one extra: the suffix is written.
    expect(text("<a href=\"tel:+15551234567\">+1 (555) 123-4568</a>")).toBe("+1 (555) 123-4568 <tel:+15551234567>");
    expect(text("<a href=\"tel:+15551234567\">+1 (555) 123-456</a>")).toBe("+1 (555) 123-456 <tel:+15551234567>");
    expect(text("<a href=\"tel:+15551234567\">+1 (555) 123-45677</a>")).toBe("+1 (555) 123-45677 <tel:+15551234567>");
    // No digits in the text.
    expect(text("<a href=\"tel:+15551234567\">Call me</a>")).toBe("Call me <tel:+15551234567>");
    expect(text("<a href=\"tel:+15551234567\">&nbsp;</a>")).toBe("<tel:+15551234567>");
    // Non-ASCII digits don't count (only 0-9).
    const arabicIndic = Array.from("15551234567", (d) => String.fromCharCode(0x0660 + Number(d))).join("");
    expect(text(`<a href="tel:+15551234567">${arabicIndic}</a>`)).toBe(`${arabicIndic} <tel:+15551234567>`);
    // The digit rule is tel-only: spaced or partial text stays "not equal" for http, https and mailto.
    expect(text("<a href=\"https://example.com/\">example .com</a>")).toBe("example .com <https://example.com/>");
    expect(text("<a href=\"https://h1.example/2\">h1.example 2</a>")).toBe("h1.example 2 <https://h1.example/2>");
    expect(text("<a href=\"mailto:a1@example.com\">a1 @example.com</a>")).toBe("a1 @example.com <mailto:a1@example.com>");
  });

  it("lookalike text gets the suffix; a differing URL shows both", () => {
    expect(text("<a href=\"https://bank.example.evil.test/\">bank.example</a>")).toBe("bank.example <https://bank.example.evil.test/>");
    expect(text("<a href=\"https://evil.test/\">https://bank.example/</a>")).toBe("https://bank.example/ <https://evil.test/>");
  });

  it("disallowed schemes and unparsable hrefs keep only the text", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java&#9;script:alert(1)",
      " javascript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "file:///etc/passwd",
      "ftp://x.example/",
      "blob:https://x.example/1",
      "sms:+15551234567",
      "/relative",
      "//host.example/",
      "#frag",
      "",
      "http://",
    ]) {
      expect(text(`<a href="${href}">Click</a>`), href).toBe("Click");
    }
    expect(text("<a>Click</a>")).toBe("Click");
    expect(text("<a name=x>Click</a>")).toBe("Click");
  });

  it("credentials are refused; IDN is written as punycode", () => {
    expect(text("<a href=\"https://bank.example@evil.example/\">Bank</a>")).toBe("Bank");
    expect(text("<a href=\"https://u:p@x.example/\">X</a>")).toBe("X");
    expect(text("<a href=\"https://b&#xFC;cher.example/\">Books</a>")).toBe("Books <https://xn--bcher-kva.example/>");
  });

  it("mailto: query dropped; lists or invalid addresses refused", () => {
    expect(text("<a href=\"mailto:jane@example.com?subject=Hi&amp;body=x&amp;cc=evil@example.net\">Email me</a>")).toBe("Email me <mailto:jane@example.com>");
    expect(text("<a href=\"mailto:a@example.com,b@example.com\">Email</a>")).toBe("Email");
    expect(text("<a href=\"mailto:a<b>@example.com\">Email</a>")).toBe("Email");
    expect(text("<a href=\"mailto:not-an-address\">Email</a>")).toBe("Email");
  });

  it("tester D-1: a percent-encoded ?, # or % in a mailto address refuses the target (text kept, nothing re-encoded)", () => {
    for (const href of [
      "mailto:a%3Fcc=evil@x.test",
      "mailto:a%3fcc=evil@x.test",
      "mailto:me%3Fbody=Wire%26to=attacker@x.test",
      "mailto:a%23frag@x.test",
      "mailto:a%25@x.test",
      "mailto:a%253Fcc=evil@x.test",
      "mailto:a%25253F@x.test",
      "mailto:a%3F@x.test?subject=x",
      "mailto:a&#37;3Fcc=evil@x.test",
    ]) {
      expect(linkTarget(href, "Email me"), href).toBeNull();
      expect(text(`<a href="${href}">Email me</a>`), href).toBe("Email me");
    }
    // Other atext stays allowed, and a plain address with a dropped query still works.
    expect(linkTarget("mailto:a+b&c=d@x.test", "Email")).toBe("mailto:a+b&c=d@x.test");
    expect(linkTarget("mailto:a%2Bb@x.test?cc=evil@x.test#f", "Email")).toBe("mailto:a+b@x.test");
  });

  it("tel: digits only; letters refused", () => {
    expect(text("<a href=\"tel:+1 (555) 123-4567\">Call</a>")).toBe("Call <tel:+15551234567>");
    expect(text("<a href=\"tel:555.123.4567\">Call</a>")).toBe("Call <tel:5551234567>");
    expect(text("<a href=\"tel:1-800-FLOWERS\">Call</a>")).toBe("Call");
    expect(text("<a href=\"tel:12\">Call</a>")).toBe("Call");
  });

  it("an href over 2,048 units is dropped", () => {
    const long = `https://x.example/${"a".repeat(MAX_LINK_TARGET - 18)}`;
    expect(long.length).toBe(MAX_LINK_TARGET);
    expect(text(`<a href="${long}">L</a>`)).toBe(`L <${long}>`);
    expect(text(`<a href="${long}a">L</a>`)).toBe("L");
  });

  it("first href wins; nested <a> closes the first; stray </a> ignored; unclosed anchor closed at the end", () => {
    expect(text("<a href=\"https://one.example/\" HREF=\"https://two.example/\">X</a>")).toBe("X <https://one.example/>");
    expect(text("<a href=\"https://one.example/\">One<a href=\"https://two.example/\">Two</a>")).toBe("One <https://one.example/>Two <https://two.example/>");
    expect(text("a</a>b")).toBe("ab");
    expect(text("<a href=\"https://x.example/\">Open")).toBe("Open <https://x.example/>");
  });

  it("an image-only link is the bare target (owner Q-B a)", () => {
    expect(text("<a href=\"https://social.example/jane\"><img src=\"https://social.example/i.png\" alt=\"Profile\"></a>")).toBe("<https://social.example/jane>");
    expect(text("<a href=\"https://a.example/\"><img></a><a href=\"https://b.example/\"><img></a>")).toBe("<https://a.example/> <https://b.example/>");
  });

  it("the target goes after the last visible character, before trailing breaks", () => {
    expect(text("<a href=\"https://x.example/\">Book<br></a>next")).toBe("Book <https://x.example/>\nnext");
  });

  it("only the first 20 targeted links are expanded", () => {
    expect(MAX_SIGNATURE_LINKS).toBe(20);
    const html = Array.from({ length: 21 }, (_, i) => `<a href="https://h${i}.example/">L${i}</a>`).join(" ");
    const out = text(html);
    expect(out).toContain("L19 <https://h19.example/>");
    expect(out.endsWith("L20")).toBe(true);
    // Links whose text equals the target, or with no allowed target, don't count.
    const mixed = `<a href="javascript:x">J</a> <a href="https://same.example/">same.example</a> ${html}`;
    expect(text(mixed)).toContain("L19 <https://h19.example/>");
  });

  it("anchors inside script or comments are never seen", () => {
    expect(text("<script><a href=\"https://x.example/\">x</a></script>ok")).toBe("ok");
    expect(text("<!-- <a href=\"https://x.example/\">x</a> -->ok")).toBe("ok");
  });

  it("every written target is printable ASCII with no spaces, < or >", () => {
    const hrefs = ["https://x.example/a b", "https://x.example/<x>", "https://x.example/\"q\"", "https://x.example/`", "https://x.example/#a b<c>", "https://x.example/?q=<s>"];
    for (const h of hrefs) {
      const out = text(`<a href='${h}'>T</a>`);
      const m = out.match(/^T <(.*)>$/);
      expect(m, h).not.toBeNull();
      expect(/^[\x21-\x7E]+$/.test(m![1]!) && !/[<>]/.test(m![1]!), h).toBe(true);
    }
  });

  it("linkTarget directly: controls refused; tabs and newlines removed; leading C0/space trimmed", () => {
    expect(linkTarget("https://x.example/a\u0000b", "t")).toBeNull();
    // A control at either end is trimmed (plan 6.4 step 2), not refused.
    expect(linkTarget("https://x.example/\u0000", "t")).toBe("https://x.example/");
    expect(linkTarget(`https://x.example/${ch(0x85)}`, "t")).toBeNull();
    expect(linkTarget("ht\ntp\ts://x.example/", "t")).toBe("https://x.example/");
    expect(linkTarget(`${ch(1)} https://x.example/ `, "t")).toBe("https://x.example/");
    expect(linkTarget(null, "t")).toBeNull();
  });
});

describe("signatureToText: cost", () => {
  const timed = (html: string) => {
    const t0 = performance.now();
    signatureToText(html);
    return performance.now() - t0;
  };
  it("hostile 64 KiB inputs finish quickly", () => {
    const fill = (unit: string) => unit.repeat(Math.floor(MAX_SIGNATURE_HTML / unit.length));
    for (const html of [fill("<a href=\"https://x.test/\">"), fill("<a href=\"https://x.test/\">x</a>"), `<a href="${"x".repeat(65_000)}`, fill("&#"), fill("<a "), fill("<"), fill("<p>"), fill("<a href=x>a.test</a>")]) {
      expect(html.length).toBeLessThanOrEqual(MAX_SIGNATURE_HTML);
      expect(timed(html)).toBeLessThan(500);
    }
  });
});

const legacy: EmailSendPayload = {
  to: ["bob@example.org"],
  cc: [],
  subject: "Re: Lunch",
  bodyText: "See you then.\n",
  quote: { included: true, text: "On Mon, Bob wrote:\n> Lunch?" },
  threading: { gmailThreadId: "t1", inReplyTo: "<m1@example.org>", references: ["<m1@example.org>"] },
  replyToNotice: false,
};
const ACCOUNT = "4b1d6d7e-0f9e-4d5c-9a51-0d2b7f9b7c11";
const SIG = "Jane Doe\nExample Co <https://example.com/>";

describe("payload: signature key", () => {
  it("a legacy payload parses and its hash equals the one frozen from main (a9d059d)", () => {
    expect(emailSendPayload.parse(legacy)).toEqual(legacy);
    expect("signature" in emailSendPayload.parse(legacy)).toBe(false);
    expect(contentHash("email.send", ACCOUNT, emailSendPayload.parse(legacy))).toBe("24679dd6aefd3b8e4e4471e3c179d1e074a985b4582f7672ec0bace91bef78f0");
  });

  it("null and { text } are accepted and change the hash", () => {
    const withNull = emailSendPayload.parse({ ...legacy, signature: null });
    const withText = emailSendPayload.parse({ ...legacy, signature: { text: SIG } });
    const h = contentHash("email.send", ACCOUNT, legacy);
    expect(contentHash("email.send", ACCOUNT, withNull)).not.toBe(h);
    expect(contentHash("email.send", ACCOUNT, withText)).not.toBe(h);
    expect(contentHash("email.send", ACCOUNT, withText)).not.toBe(contentHash("email.send", ACCOUNT, withNull));
  });

  it("empty, over-cap, control-character and extra-key signatures are refused; unknown top-level keys too", () => {
    for (const signature of [{ text: "" }, { text: "a".repeat(10_001) }, { text: "a\u0000b" }, { text: `a${ch(0x1b)}b` }, { text: "a", html: "<b>a</b>" }, "text", {}]) {
      expect(emailSendPayload.safeParse({ ...legacy, signature }).success, JSON.stringify(signature).slice(0, 40)).toBe(false);
    }
    expect(emailSendPayload.safeParse({ ...legacy, signature: { text: "a".repeat(10_000) } }).success).toBe(true);
    expect(emailSendPayload.safeParse({ ...legacy, extra: 1 }).success).toBe(false);
  });
});

describe("outgoingBody and buildMessage: exact bytes", () => {
  const p = (over: Partial<EmailSendPayload>): EmailSendPayload => ({ ...legacy, ...over });
  it("without a signature: unchanged from main", () => {
    expect(outgoingBody(legacy)).toBe("See you then.\n\n\nOn Mon, Bob wrote:\n> Lunch?");
    expect(outgoingBody(p({ quote: null }))).toBe("See you then.\n");
    expect(outgoingBody(p({ quote: { included: false, text: "q" } }))).toBe("See you then.\n");
    expect(outgoingBody(p({ quote: { included: true, text: "" } }))).toBe("See you then.\n");
    expect(outgoingBody(p({ signature: null }))).toBe(outgoingBody(legacy));
  });

  it("with a signature: text, blank line, signature, blank line, quote; no -- line", () => {
    expect(outgoingBody(p({ signature: { text: SIG } }))).toBe(`See you then.\n\n${SIG}\n\nOn Mon, Bob wrote:\n> Lunch?`);
    expect(outgoingBody(p({ signature: { text: SIG }, quote: null }))).toBe(`See you then.\n\n${SIG}`);
    expect(outgoingBody(p({ signature: { text: SIG }, bodyText: "Hi\n\n\n" }))).toBe(`Hi\n\n${SIG}\n\nOn Mon, Bob wrote:\n> Lunch?`);
    expect(outgoingBody(p({ signature: { text: SIG }, bodyText: "", quote: null }))).toBe(SIG);
    expect(outgoingBody(p({ signature: { text: SIG }, bodyText: "" }))).toBe(`${SIG}\n\nOn Mon, Bob wrote:\n> Lunch?`);
    expect(outgoingBody(p({ signature: { text: SIG } }))).not.toContain("-- ");
  });

  it("the MIME body is the outgoing body with CRLF line ends", () => {
    const body = outgoingBody(p({ signature: { text: SIG } }));
    const msg = buildMessage({
      from: "owner@example.com",
      to: ["bob@example.org"],
      cc: [],
      subject: "Re: Lunch",
      date: new Date("2026-11-27T10:00:00Z"),
      messageId: "<x1@example.com>",
      inReplyTo: null,
      references: [],
      bodyText: body,
    });
    const b64 = msg.slice(msg.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, "");
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(body.replace(/\n/g, "\r\n"));
  });

  it("maximum sizes build with no body_length error", () => {
    const big = p({ bodyText: "a".repeat(100_000), signature: { text: "s".repeat(10_000) }, quote: { included: true, text: "q".repeat(20_000) } });
    expect(emailSendPayload.safeParse(big).success).toBe(true);
    const body = outgoingBody(big);
    expect(body.length).toBe(130_004);
    expect(() =>
      buildMessage({ from: "owner@example.com", to: ["bob@example.org"], cc: [], subject: "x", date: new Date(), messageId: "<x2@example.com>", inReplyTo: null, references: [], bodyText: body }),
    ).not.toThrow();
  });
});

describe("buildEmailPayload: the snapshot comes only from the caller", () => {
  const base = { quote: () => null, threading: null, parent: null, previousNotice: false, newMessage: true };
  const fields = { to: "bob@example.org", cc: "", subject: "Hi", bodyText: "Hello", includeQuote: false };
  it("sets the key from base.signature, and a forged field on the input is ignored", () => {
    const forged = { ...fields, signature: "<b>forged</b>" } as typeof fields;
    const a = buildEmailPayload(forged, { ...base, signature: { text: SIG } });
    expect(a.ok && a.payload.signature).toEqual({ text: SIG });
    const b = buildEmailPayload(forged, { ...base, signature: null });
    expect(b.ok && b.payload.signature).toBeNull();
    const c = buildEmailPayload(forged, base);
    expect(c.ok && "signature" in c.payload).toBe(false);
  });

  it("signatureSnapshot: { text } only for a set row", () => {
    expect(signatureSnapshot({ state: "set", text: SIG })).toEqual({ text: SIG });
    for (const state of ["none", "not_found", "too_large", null] as const) expect(signatureSnapshot({ state, text: null })).toBeNull();
    expect(signatureSnapshot(null)).toBeNull();
    expect(signatureSnapshot(undefined)).toBeNull();
  });
});

describe("refresh: content-free codes and audit detail", () => {
  it("error codes", () => {
    expect(signatureErrorCode(new GmailApiError(403, "insufficientPermissions", "settings.sendAs.get"))).toBe("http_403:insufficientPermissions");
    expect(signatureErrorCode(new GmailApiError(500, null, "settings.sendAs.get"))).toBe("http_500");
    expect(signatureErrorCode(new GmailShapeError("settings.sendAs.get"))).toBe("shape");
    expect(signatureErrorCode(new TypeError("x"))).toBe("error:TypeError");
    const odd = new Error("x");
    odd.name = "Bad name with jane@example.com";
    expect(signatureErrorCode(odd)).toBe("error");
    expect(signatureErrorCode("string")).toBe("error");
    for (const c of ["http_403:insufficientPermissions", "http_500", "shape", "error:TypeError", "error", `http_429:${"r".repeat(64)}`]) {
      expect(/^[A-Za-z0-9_.:-]{1,80}$/.test(c), c).toBe(true);
    }
  });

  it("account.signature_updated detail keys are exactly state, changed and an optional code", () => {
    expect(signatureUpdatedDetail({ state: "set", changed: "text" })).toEqual({ state: "set", changed: "text" });
    expect(signatureUpdatedDetail({ state: "unread", changed: "error", code: "http_403" })).toEqual({ state: "unread", changed: "error", code: "http_403" });
  });
});

// ---- Static rules (AC 16) ---------------------------------------------------------------------------

const SRC = path.resolve(import.meta.dirname, "..", "src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const sources = files(SRC).map((f) => ({ file: path.relative(SRC, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8").replace(/\r\n/g, "\n") }));
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const importsOf = (t: string) => [...code(t).matchAll(/import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g)].map((m) => ({ type: !!m[1], spec: m[2]! }));

function converterProblems(t: string): string[] {
  const out: string[] = [];
  const specs = importsOf(t).map((i) => i.spec);
  const allowed = ["@/lib/approvals/text", "@/lib/approvals/addresses"];
  for (const s of specs) if (!allowed.includes(s)) out.push(`import ${s}`);
  if (/\bfetch\s*\(/.test(code(t))) out.push("fetch(");
  if (/\bimport\s*\(/.test(code(t))) out.push("import(");
  if (/\brequire\s*\(/.test(code(t))) out.push("require(");
  return out;
}

describe("static: the converter and the pages (AC 16)", () => {
  const convert = sources.find((s) => s.file === "lib/signatures/convert.ts")!;

  it("convert.ts imports only approvals/text and approvals/addresses, with no fetch( or import(", () => {
    expect(converterProblems(convert.text)).toEqual([]);
  });

  it("positive controls for the converter rule", () => {
    expect(converterProblems(`import { x } from "@/lib/email/plain-text";\n${convert.text}`)).not.toEqual([]);
    expect(converterProblems(`${convert.text}\nconst r = fetch("https://x.test/");`)).not.toEqual([]);
    expect(converterProblems(`${convert.text}\nconst m = import("node:dns");`)).not.toEqual([]);
  });

  it("convert.ts is imported only by refresh.ts; refresh.ts only by gmail/sync.ts", () => {
    const importers = (re: RegExp) => sources.filter((s) => importsOf(s.text).some((i) => re.test(i.spec))).map((s) => s.file).sort();
    expect(importers(/signatures\/convert$|^\.\/convert$/)).toEqual(["lib/signatures/refresh.ts"]);
    expect(importers(/signatures\/refresh$/)).toEqual(["lib/gmail/sync.ts"]);
  });

  it("no file in src uses dangerouslySetInnerHTML (signatures are rendered as React text)", () => {
    expect(sources.filter((s) => /dangerouslySetInnerHTML/.test(s.text)).map((s) => s.file)).toEqual([]);
    // Positive control.
    expect(/dangerouslySetInnerHTML/.test("<div dangerouslySetInnerHTML={{ __html: x }} />")).toBe(true);
  });

  it("the signature UI renders the text inside <pre>{…}</pre>", () => {
    const ui = sources.find((s) => s.file === "app/(app)/signature-ui.tsx")!;
    expect(code(ui.text)).toMatch(/<pre [^>]*>\{text\}<\/pre>/);
    expect(importsOf(ui.text)).toEqual([]);
  });
});
