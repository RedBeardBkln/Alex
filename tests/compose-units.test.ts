import { describe, expect, it } from "vitest";
import "./setup-env";
import { emailSendPayload, isNewMessage } from "@/lib/approvals/payload";
import {
  capAllows,
  capRemaining,
  confirmationMatches,
  DEFAULT_NEW_RECIPIENTS_PER_DAY,
  idnDisplay,
  newRecipientLimit,
  parseNewRecipientLimit,
  recipientKeys,
} from "@/lib/approvals/recipients";
import { buildEmailPayload } from "@/lib/approvals/service";
import { assertHeaderBlock, buildMessage } from "@/lib/gmail/compose";

// Phase 2d (compose) unit tests, no database: the new-message payload rules (plan §5), the
// recipient confirmation (Q2), the cap math and env parsing (Q3) and the IDN display (Q7).
// Non-ASCII and control characters are built with String.fromCodePoint, never typed as escapes.

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;
const NUL = String.fromCharCode(0);
const LS = String.fromCodePoint(0x2028);
const E_ACUTE = String.fromCodePoint(0xe9);
const LONE_HIGH = String.fromCharCode(0xd800);

const NEW = { quote: () => "should never be used", threading: null, parent: null, previousNotice: false, newMessage: true } as const;
const fields = (over: Partial<{ to: string; cc: string; subject: string; bodyText: string; includeQuote: boolean }> = {}) => ({
  to: "bob@example.org",
  cc: "",
  subject: "Hello",
  bodyText: "Hi Bob",
  includeQuote: false,
  ...over,
});
const build = (over: Parameters<typeof fields>[0] = {}) => buildEmailPayload(fields(over), NEW);

describe("isNewMessage", () => {
  it("is true only for an explicit threading: null", () => {
    expect(isNewMessage({ threading: null })).toBe(true);
    expect(isNewMessage({ threading: { gmailThreadId: "t", inReplyTo: null, references: [] } })).toBe(false);
    expect(isNewMessage({})).toBe(false); // a missing key takes the stricter reply rules
    expect(isNewMessage({ threading: undefined })).toBe(false);
    expect(isNewMessage(null)).toBe(false);
    expect(isNewMessage("threading")).toBe(false);
  });
});

describe("buildEmailPayload for a new message (plan §5)", () => {
  it("builds a payload with no threading, no quote and no Reply-To notice, even if a quote is asked for", () => {
    const r = build({ includeQuote: true, bodyText: `Line 1${CRLF}Line 2` });
    expect(r).toEqual({
      ok: true,
      payload: { to: ["bob@example.org"], cc: [], subject: "Hello", bodyText: `Line 1${LF}Line 2`, quote: null, threading: null, replyToNotice: false },
    });
    expect(emailSendPayload.safeParse((r as { payload: unknown }).payload).success).toBe(true);
  });

  it("requires a non-empty subject and body (owner Q8); replies don't", () => {
    expect(build({ subject: "" })).toEqual({ ok: false, error: "empty_subject" });
    expect(build({ subject: "   " })).toEqual({ ok: false, error: "empty_subject" });
    expect(build({ bodyText: "" })).toEqual({ ok: false, error: "empty_body" });
    expect(build({ bodyText: ` ${LF}${CRLF}\t ` })).toEqual({ ok: false, error: "empty_body" });
    const reply = buildEmailPayload(fields({ subject: "", bodyText: "" }), { quote: () => null, threading: { gmailThreadId: "t1", inReplyTo: null, references: [] }, parent: null, previousNotice: false });
    expect(reply.ok).toBe(true);
  });

  it("refuses CR, LF, NUL, U+2028 and an injected Bcc in the subject; in To or Cc they only split tokens", () => {
    for (const bad of [`x${CRLF}Bcc: evil@example.net`, `x${CR}y`, `x${LF}y`, `x${NUL}y`, `x${LS}y`]) {
      expect(build({ subject: bad }), JSON.stringify(bad)).toEqual({ ok: false, error: "invalid_subject" });
    }
    // CR and LF are separators in recipient input, so the injected header text becomes invalid tokens.
    for (const key of ["to", "cc"] as const) {
      const r = build({ [key]: `bob@example.org${CRLF}Bcc: evil@example.net` });
      expect(r, key).toEqual({ ok: false, error: "invalid_recipients", invalid: ["Bcc:"] });
      const nul = build({ [key]: `bob@example.org${NUL}` });
      expect(nul.ok, key).toBe(false);
      // U+2028 is whitespace to the splitter, so it separates two valid addresses and never reaches a header.
      const ls = build({ [key]: `bob@example.org${LS}x@example.org` });
      // (In Cc, bob@ is dropped as a duplicate of the To address.)
      expect(ls, key).toMatchObject({ ok: true, payload: { [key]: key === "to" ? ["bob@example.org", "x@example.org"] : ["x@example.org"] } });
      const lsInside = build({ [key]: `bob${String.fromCodePoint(0x200b)}@example.org` });
      expect(lsInside, key).toMatchObject({ ok: false, error: "idn_not_punycode" });
    }
  });

  it("refuses NUL and other controls in the body", () => {
    expect(build({ bodyText: `hi${NUL}` })).toEqual({ ok: false, error: "invalid_body" });
  });

  it("50 recipients are fine, 51 are not; To needs at least one", () => {
    const addrs = (n: number) => Array.from({ length: n }, (_, i) => `r${i}@example.org`);
    expect(build({ to: addrs(30).join(LF), cc: addrs(50).slice(30).join(LF) }).ok).toBe(true);
    expect(build({ to: addrs(30).join(LF), cc: addrs(51).slice(30).join(LF) })).toEqual({ ok: false, error: "too_many_recipients" });
    expect(build({ to: "", cc: "c@example.org" })).toEqual({ ok: false, error: "no_recipients" });
  });

  it("de-duplicates case-insensitively, within To and between To and Cc", () => {
    const r = build({ to: `Bob@Example.org, bob@example.org; BOB@EXAMPLE.ORG${LF}amy@example.org`, cc: "AMY@example.org carl@example.org Carl@Example.Org" });
    expect(r).toMatchObject({ ok: true, payload: { to: ["Bob@Example.org", "amy@example.org"], cc: ["carl@example.org"] } });
  });

  it("refuses display names (bare addresses only, owner Q6) and lists the offending tokens", () => {
    expect(build({ to: "Bob <bob@example.org>" })).toEqual({ ok: false, error: "invalid_recipients", invalid: ["Bob", "<bob@example.org>"] });
  });

  it("refuses a Unicode domain as idn_not_punycode (owner Q7); the punycode form is accepted", () => {
    expect(build({ to: `bob@caf${E_ACUTE}.example` })).toEqual({ ok: false, error: "idn_not_punycode", invalid: [`bob@caf${E_ACUTE}.example`] });
    expect(build({ to: "bob@xn--caf-dma.example" }).ok).toBe(true);
  });

  it("echoes at most 10 invalid tokens, each at most 100 characters", () => {
    const tokens = Array.from({ length: 15 }, (_, i) => `bad${i}`);
    const r = build({ to: tokens.join(" ") });
    expect(r).toEqual({ ok: false, error: "invalid_recipients", invalid: tokens.slice(0, 10) });
    const long = build({ cc: "y".repeat(500) }) as { invalid: string[] };
    expect(long.invalid[0]).toHaveLength(100);
  });

  it("a lone surrogate in the subject becomes U+FFFD; in a recipient it is an IDN-style refusal", () => {
    expect(build({ subject: `Hi ${LONE_HIGH}` })).toMatchObject({ ok: true, payload: { subject: `Hi ${String.fromCodePoint(0xfffd)}` } });
    expect(build({ to: `a${LONE_HIGH}@example.org` }).ok).toBe(false);
  });

  it("a reply still reports only the generic invalid_recipients (no token list)", () => {
    const reply = buildEmailPayload(fields({ to: `Bob <bob@example.org> bob@caf${E_ACUTE}.example` }), {
      quote: () => null,
      threading: { gmailThreadId: "t1", inReplyTo: null, references: [] },
      parent: null,
      previousNotice: false,
    });
    expect(reply).toEqual({ ok: false, error: "invalid_recipients" });
  });
});

describe("buildMessage for a new message", () => {
  it("has no In-Reply-To or References, passes the header check, and encodes a non-ASCII subject (RFC 2047)", () => {
    const subject = `Caf${E_ACUTE} compose test`;
    const text = buildMessage({
      from: "me@example.com",
      to: ["bob@example.org"],
      cc: ["amy@example.net"],
      subject,
      bodyText: "Hi",
      messageId: "<alex.x.1.abc@alex.example.com>",
      inReplyTo: null,
      references: [],
      date: new Date("2026-11-20T10:00:00Z"),
    });
    const head = text.slice(0, text.indexOf(`${CRLF}${CRLF}`));
    expect(head).not.toMatch(/In-Reply-To|References/i);
    expect(head).not.toMatch(/^Bcc:/im);
    expect(() => assertHeaderBlock(head)).not.toThrow();
    const subjectLine = head.split(CRLF).find((l) => l.startsWith("Subject: "))!;
    expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const decoded = Buffer.from(subjectLine.slice("Subject: =?UTF-8?B?".length, -2), "base64").toString("utf8");
    expect(decoded).toBe(subject);
    expect(head).toContain(`From: me@example.com${CRLF}To: bob@example.org${CRLF}Cc: amy@example.net${CRLF}`);
  });
});

describe("recipient confirmation (owner Q2)", () => {
  const p = { to: ["Bob@example.org", "amy@example.org"], cc: ["carl@example.net"] };
  it("matches the exact set, case-insensitively, in any order", () => {
    expect(confirmationMatches(["carl@example.net", "bob@EXAMPLE.org", "amy@example.org"], p)).toBe(true);
  });
  it("fails when one is missing, one is extra, any is repeated, or nothing is ticked", () => {
    expect(confirmationMatches(["bob@example.org", "amy@example.org"], p)).toBe(false);
    expect(confirmationMatches(["bob@example.org", "amy@example.org", "carl@example.net", "dan@example.net"], p)).toBe(false);
    expect(confirmationMatches(["bob@example.org", "bob@example.org", "amy@example.org"], p)).toBe(false);
    expect(confirmationMatches(["bob@example.org", "BOB@example.org", "amy@example.org", "carl@example.net"], p)).toBe(false);
    expect(confirmationMatches([], p)).toBe(false);
    expect(confirmationMatches([], { to: [], cc: [] })).toBe(false);
  });
  it("recipientKeys lowercases and de-duplicates to ∪ cc", () => {
    expect(recipientKeys({ to: ["A@example.org", "a@example.org"], cc: ["B@example.org"] })).toEqual(["a@example.org", "b@example.org"]);
  });
});

describe("daily first-time-recipient cap (owner Q3)", () => {
  it("allows n = 0 always, and otherwise used + n up to the limit", () => {
    expect(capAllows(0, 50, 0)).toBe(true);
    expect(capAllows(3, 7, 10)).toBe(true);
    expect(capAllows(4, 7, 10)).toBe(false);
    expect(capAllows(1, 0, 0)).toBe(false);
    expect(capAllows(11, 0, 10)).toBe(false);
    expect(capRemaining(7, 10)).toBe(3);
    expect(capRemaining(12, 10)).toBe(0);
  });

  it("parses EMAIL_NEW_RECIPIENTS_PER_DAY: default 10, 0 allowed, garbage falls back to the default", () => {
    expect(DEFAULT_NEW_RECIPIENTS_PER_DAY).toBe(10);
    expect(parseNewRecipientLimit(undefined)).toBe(10);
    expect(parseNewRecipientLimit("0")).toBe(0);
    expect(parseNewRecipientLimit(" 25 ")).toBe(25);
    for (const bad of ["", "-1", "1.5", "ten", "1e3", "0x10", "9999999", "NaN", "Infinity"]) expect(parseNewRecipientLimit(bad), bad).toBe(10);
    expect(newRecipientLimit({ EMAIL_NEW_RECIPIENTS_PER_DAY: "3" })).toBe(3);
    expect(newRecipientLimit({ EMAIL_NEW_RECIPIENTS_PER_DAY: undefined })).toBe(10);
  });
});

describe("IDN display (owner Q7)", () => {
  it("shows the Unicode form of a punycode domain, and nothing for ASCII domains", () => {
    expect(idnDisplay("bob@xn--caf-dma.example")).toBe(`caf${E_ACUTE}.example`);
    expect(idnDisplay("bob@mail.XN--CAF-DMA.example")).toBe(`mail.caf${E_ACUTE}.example`);
    expect(idnDisplay("bob@example.org")).toBeNull();
    expect(idnDisplay("no-at-sign")).toBeNull();
  });
});
