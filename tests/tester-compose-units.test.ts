import { describe, expect, it } from "vitest";
import "./setup-env";
import { emailSendPayload, isNewMessage } from "@/lib/approvals/payload";
import { confirmationMatches, idnDisplay, parseNewRecipientLimit, recipientKeys } from "@/lib/approvals/recipients";
import { buildEmailPayload } from "@/lib/approvals/service";
import { assertHeaderBlock, buildMessage } from "@/lib/gmail/compose";

// Tester (phase 2d, compose), no database. Tries to get anything other than the owner's typed bare
// addresses into a header, or Bcc anywhere, through every field and every Unicode line breaker.
// All special characters are built with String.fromCodePoint (the Write tool mangles escapes).

const ch = (cp: number) => String.fromCodePoint(cp);
const CR = ch(13);
const LF = ch(10);
const CRLF = CR + LF;

const NEW = { quote: () => "never", threading: null, parent: null, previousNotice: false, newMessage: true } as const;
const fields = (over: Partial<{ to: string; cc: string; subject: string; bodyText: string; includeQuote: boolean }> = {}) => ({
  to: "bob@example.org",
  cc: "",
  subject: "Hello",
  bodyText: "Hi Bob",
  includeQuote: false,
  ...over,
});
const build = (over: Parameters<typeof fields>[0] = {}) => buildEmailPayload(fields(over), NEW);

/** Header names (unfolded) of a built message. */
function headerNames(text: string): string[] {
  const head = text.slice(0, text.indexOf(CRLF + CRLF));
  return head
    .split(CRLF)
    .filter((l) => !l.startsWith(" "))
    .map((l) => l.slice(0, l.indexOf(":")));
}
function raw(p: { to: string[]; cc: string[]; subject: string; bodyText: string }) {
  return buildMessage({ from: "me@example.com", to: p.to, cc: p.cc, subject: p.subject, bodyText: p.bodyText, messageId: "<alex.x.1.ab@alex.example.com>", inReplyTo: null, references: [], date: new Date("2026-11-20T10:00:00Z") });
}

// Every character that some parser treats as a line break or header separator.
const BREAKERS: [string, string][] = [
  ["CR", CR],
  ["LF", LF],
  ["CRLF", CRLF],
  ["VT", ch(0x0b)],
  ["FF", ch(0x0c)],
  ["NEL", ch(0x85)],
  ["LS", ch(0x2028)],
  ["PS", ch(0x2029)],
  ["NUL", ch(0)],
  ["FS", ch(0x1c)],
  ["RS", ch(0x1e)],
  ["IDEOGRAPHIC SPACE", ch(0x3000)],
  ["ZWSP", ch(0x200b)],
  ["BOM", ch(0xfeff)],
];

describe("tester: header injection through every field (plan §5, constraint 1, Bcc)", () => {
  for (const [name, br] of BREAKERS) {
    for (const field of ["to", "cc", "subject"] as const) {
      it(`${name} + "Bcc: evil@example.net" in ${field}: refused, or no Bcc and only our headers`, () => {
        const injected = `bob@example.org${br}Bcc: evil@example.net`;
        const over = field === "subject" ? { subject: `Hi${br}Bcc: evil@example.net` } : field === "cc" ? { cc: injected } : { to: injected };
        const r = build(over);
        if (!r.ok) return; // refused: fine
        // Accepted: the result must hold only valid addresses, and the built message no Bcc header.
        const all = [...r.payload.to, ...r.payload.cc];
        expect(all.some((a) => a.toLowerCase().includes("evil"))).toBe(false);
        const text = raw(r.payload);
        expect(headerNames(text)).not.toContain("Bcc");
        expect(() => assertHeaderBlock(text.slice(0, text.indexOf(CRLF + CRLF)))).not.toThrow();
      });
    }
  }

  it("each breaker between two valid addresses: either refused or exactly those two addresses", () => {
    const out: Record<string, string> = {};
    for (const [name, br] of BREAKERS) {
      const r = build({ to: `bob@example.org${br}amy@example.net` });
      out[name] = r.ok ? `ok:${r.payload.to.join("|")}` : `refused:${r.error}`;
      if (r.ok) expect(r.payload.to).toEqual(["bob@example.org", "amy@example.net"]);
    }
    // Pin what JS \s splits (CR, LF, VT, FF, LS, PS, U+3000, BOM) vs what is refused as non-ASCII/invalid.
    expect(out).toMatchObject({ CR: "ok:bob@example.org|amy@example.net", LS: "ok:bob@example.org|amy@example.net", NEL: "refused:idn_not_punycode", NUL: "refused:invalid_recipients", ZWSP: "refused:idn_not_punycode" });
  });

  it("a body full of header-looking lines is base64 and adds no header", () => {
    const r = build({ bodyText: `x${CRLF}Bcc: evil@example.net${CRLF}${CRLF}To: evil@example.net${ch(0x2028)}Cc: e@example.net` });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = raw(r.payload);
    expect(headerNames(text)).toEqual(["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
  });

  it("angle-bracket and display-name tricks are refused, never partly accepted", () => {
    for (const to of [
      "Bob <bob@example.org>",
      "<bob@example.org>",
      '"evil@example.net" bob@example.org',
      "bob@example.org>,<evil@example.net",
      "bob@example.org(evil@example.net)",
      "bob@[192.0.2.1]",
      "bob@localhost",
      "bob@example.org.",
      "bob@@example.org",
      "bob@example.org@evil.example.net",
      '"bob"@example.org',
      "bob@-example.org",
      "bob@exa_mple.org",
    ]) {
      const r = build({ to });
      expect(r.ok, to).toBe(false);
    }
  });

  it("the Bcc word in an otherwise valid local part is just an address, never a header", () => {
    const r = build({ to: "bcc:evil@example.net" });
    expect(r.ok).toBe(false);
    const r2 = build({ to: "Bcc@example.org" });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(headerNames(raw(r2.payload))).not.toContain("Bcc");
  });
});

describe("tester: IDN and look-alikes (Q7)", () => {
  const CYR_A = ch(0x430);
  it("non-ASCII domains (Cyrillic a, fullwidth @, Unicode digit) are refused as idn_not_punycode, with the token echoed", () => {
    for (const to of [`bob@ex${CYR_A}mple.org`, `bob${ch(0xff20)}example.org`, `bob@example.org${ch(0x0663)}`, `bob@caf${ch(0xe9)}.example`]) {
      const r = build({ to });
      expect(r, to).toMatchObject({ ok: false, error: "idn_not_punycode" });
      if (!r.ok) expect(r.invalid).toEqual([to]);
    }
  });
  it("punycode is accepted and idnDisplay shows the Unicode (homograph) form, any case, any label", () => {
    // xn--80ak6aa92e is the well-known all-Cyrillic look-alike of "apple".
    const r = build({ to: "bob@xn--80ak6aa92e.example\nAMY@MAIL.XN--80AK6AA92E.EXAMPLE" });
    expect(r.ok).toBe(true);
    const u = idnDisplay("bob@xn--80ak6aa92e.example");
    expect(u).not.toBeNull();
    expect(u).not.toBe("apple.example");
    expect([...u!.split(".")[0]!].every((c) => c.codePointAt(0)! > 0x3ff)).toBe(true); // Cyrillic, not Latin
    expect(idnDisplay("AMY@MAIL.XN--80AK6AA92E.EXAMPLE")).toBe(`mail.${u}`);
    expect(idnDisplay("bob@example.org")).toBeNull();
  });
  it("records what idnDisplay does with an invalid punycode label (no warning when it can't decode)", () => {
    // Accepted by the LDH rule; check what the approval page would show.
    const r = build({ to: "bob@xn--a.example" });
    const shown = idnDisplay("bob@xn--a.example");
    expect({ ok: r.ok, shown }).toMatchObject({ ok: true });
    // Either a decoded form or null; never the raw string disguised as a decode.
    expect(shown === null || shown !== "xn--a.example").toBe(true);
  });
});

describe("tester: duplicates, counts and confirmation (plan §5, Q2)", () => {
  it("51 typed with one case-duplicate is 50 and allowed; 51 distinct is refused; Cc duplicates of To don't count", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `u${i}@example.org`);
    expect(build({ to: [...fifty, "U0@EXAMPLE.ORG"].join("\n") })).toMatchObject({ ok: true });
    expect(build({ to: [...fifty, "u50@example.org"].join("\n") })).toMatchObject({ ok: false, error: "too_many_recipients" });
    const r = build({ to: fifty.join(","), cc: fifty.map((a) => a.toUpperCase()).join(";") });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.payload.cc).toEqual([]);
    expect(build({ to: fifty.slice(0, 25).join(" "), cc: fifty.slice(25).join(" ") + " extra@example.org" })).toMatchObject({ ok: false, error: "too_many_recipients" });
  });
  it("confirmation: whitespace-padded or angle-bracketed values don't match; exact set only", () => {
    const p = { to: ["bob@example.org"], cc: ["amy@example.net"] };
    expect(confirmationMatches(["bob@example.org", "amy@example.net"], p)).toBe(true);
    expect(confirmationMatches([" bob@example.org", "amy@example.net"], p)).toBe(false);
    expect(confirmationMatches(["<bob@example.org>", "amy@example.net"], p)).toBe(false);
    expect(confirmationMatches(["bob@example.org,amy@example.net"], p)).toBe(false);
    expect(confirmationMatches(["bob@example.org", "amy@example.net", ""], p)).toBe(false);
    expect(confirmationMatches(["amy@example.net", "BOB@example.org"], p)).toBe(true);
    // Each payload key is confirmed once even if the payload were to hold a case duplicate.
    expect(recipientKeys({ to: ["Bob@example.org", "bob@example.org"], cc: [] })).toEqual(["bob@example.org"]);
  });
  it("isNewMessage is false for anything but an object with threading exactly null", () => {
    for (const v of [null, undefined, "x", [], {}, { threading: undefined }, { threading: false }, { threading: 0 }, { threading: {} }, [null]]) expect(isNewMessage(v), JSON.stringify(v)).toBe(false);
    expect(isNewMessage({ threading: null })).toBe(true);
  });
});

describe("tester: EMAIL_NEW_RECIPIENTS_PER_DAY parsing", () => {
  it("invalid values give the default 10, 0 stays 0", () => {
    const cases: [string | undefined, number][] = [
      [undefined, 10],
      ["", 10],
      ["   ", 10],
      ["0", 0],
      [" 0 ", 0],
      ["00", 0],
      ["5", 5],
      ["-1", 10],
      ["1e3", 10],
      ["0x10", 10],
      ["10.0", 10],
      ["3.5", 10],
      ["+5", 10],
      ["five", 10],
      ["Infinity", 10],
      ["NaN", 10],
      [`${ch(0x0663)}`, 10],
      ["999999", 999999],
      ["1000000", 10],
      [`5${LF}`, 5],
    ];
    for (const [v, want] of cases) expect(parseNewRecipientLimit(v), JSON.stringify(v)).toBe(want);
  });
});

describe("tester: no Bcc can exist in a payload", () => {
  it("the strict payload schema refuses a bcc (or Bcc) key, so a tampered stored payload never parses", () => {
    const ok = { to: ["bob@example.org"], cc: [], subject: "s", bodyText: "b", quote: null, threading: null, replyToNotice: false };
    expect(emailSendPayload.safeParse(ok).success).toBe(true);
    for (const k of ["bcc", "Bcc", "BCC", "headers", "from"]) expect(emailSendPayload.safeParse({ ...ok, [k]: ["evil@example.net"] }).success, k).toBe(false);
  });
});
