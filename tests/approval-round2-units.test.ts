import { describe, expect, it } from "vitest";
import { isValidAddress, parseRecipientInput } from "@/lib/approvals/addresses";
import { MAX_QUOTE_CHARS, quoteText } from "@/lib/approvals/payload";
import { hasBidiControl, hasDisallowedControl, sliceOnCodePoint, stripBidiControls, stripDisallowedControls, wellFormed } from "@/lib/approvals/text";
import { subjectWarnings } from "@/lib/approvals/warnings";
import { replySubject } from "@/lib/gmail/compose";

// Phase 2b review round 1: D2 (surrogates), D4 (controls), the subject cosmetics and bidi characters.

const cp = (n: number) => String.fromCodePoint(n);
const isLoneSurrogateFree = (s: string) => s.isWellFormed();
const RLO = cp(0x202e);
const LRI = cp(0x2066);

describe("D2: quote cap on code-point boundaries", () => {
  it("sliceOnCodePoint never cuts a surrogate pair", () => {
    const s = "ab" + cp(0x1f35c) + "cd";
    expect(sliceOnCodePoint(s, 3)).toBe("ab");
    expect(sliceOnCodePoint(s, 4)).toBe("ab" + cp(0x1f35c));
    expect(sliceOnCodePoint(s, 100)).toBe(s);
  });

  it("for every cut position near the cap, the quote is well-formed and at most 20,000 code units", () => {
    for (let k = 19_850; k < MAX_QUOTE_CHARS; k++) {
      const q = quoteText({ fromHeader: "Alice <a@example.org>", dateHeader: "Mon, 1 Jan 2026", text: "a".repeat(k) + cp(0x1f35c) + " tail" });
      expect(q.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
      expect(isLoneSurrogateFree(q), String(k)).toBe(true);
    }
  });

  it("lone surrogates and controls in the parent text are replaced or removed", () => {
    const lone = String.fromCharCode(0xd83c);
    const q = quoteText({ fromHeader: "A" + lone, dateHeader: null, text: "x" + lone + "y" + cp(0) + "z" + cp(7) });
    expect(isLoneSurrogateFree(q)).toBe(true);
    expect(hasDisallowedControl(q)).toBe(false);
    expect(wellFormed("a" + lone)).toBe("a" + cp(0xfffd));
  });
});

describe("D4: control characters", () => {
  it("NUL and other C0 controls (except tab and newline) and DEL are disallowed in owner text", () => {
    for (const c of [0, 1, 7, 8, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f]) expect(hasDisallowedControl(`a${cp(c)}b`), String(c)).toBe(true);
    expect(hasDisallowedControl("tab\there\nnew line")).toBe(false);
    expect(stripDisallowedControls(`a${cp(0)}b${cp(0x1b)}c\td\n`)).toBe("abc\td\n");
  });

  it("recipient tokens with NUL or controls are invalid", () => {
    expect(parseRecipientInput(`a${cp(0)}@example.org`).invalid).toHaveLength(1);
    expect(isValidAddress(`a@exam${cp(0)}ple.org`)).toBe(false);
  });
});

describe("bidi characters and subject warnings", () => {
  it("the default subject drops bidi controls", () => {
    expect(replySubject(`Invoice ${RLO}fdp.exe`)).toBe("Re: Invoice fdp.exe");
    expect(replySubject(`${LRI}Re: hi`)).toBe("Re: hi");
    expect(stripBidiControls(`a${RLO}b${cp(0x200f)}c${cp(0x061c)}d`)).toBe("abcd");
  });

  it("recipients can't contain bidi controls (ASCII only), so they are rejected as invalid addresses", () => {
    const r = parseRecipientInput(`alice${RLO}@example.org\nbob@example.org`);
    expect(r).toEqual({ addresses: ["bob@example.org"], invalid: [`alice${RLO}@example.org`] });
  });

  it("no 'subject changed' warning when the original has no subject; bidi in the shown subject is flagged", () => {
    expect(subjectWarnings("Re:", null)).toEqual({ changed: false, bidi: false });
    expect(subjectWarnings("Re:", "")).toEqual({ changed: false, bidi: false });
    expect(subjectWarnings("Re: something else", "  ")).toEqual({ changed: false, bidi: false });
    expect(subjectWarnings("Re: Lunch", "Lunch")).toEqual({ changed: false, bidi: false });
    expect(subjectWarnings("Re: Dinner", "Lunch")).toEqual({ changed: true, bidi: false });
    expect(subjectWarnings(`Re: Invoice ${RLO}fdp.exe`, `Invoice ${RLO}fdp.exe`)).toEqual({ changed: true, bidi: true });
    expect(hasBidiControl("plain")).toBe(false);
    const long = "x".repeat(600);
    expect(subjectWarnings(replySubject(long), long).changed).toBe(false);
  });
});
