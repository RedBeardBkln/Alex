import { describe, expect, it } from "vitest";
import { findInvisible, isInvisibleOrBidi, stripInvisible } from "@/lib/approvals/text";
import { hostsIn, invisibleCharacters, linksNotInThread, normalizeHost } from "@/lib/approvals/warnings";
import { cleanSummary } from "@/lib/ai/parse";

// Phase 2c round 2 (unit): D2 host-boundary link matching with IDN, and the O2 additions to the
// invisible-character set.

const cp = (n: number) => String.fromCodePoint(n);

describe("D2: links match on host boundaries, never substrings", () => {
  it("the tester's repro pairs are all flagged", () => {
    expect(linksNotInThread("Pay at https://evil.co/pay", "See evil.com for details")).toEqual(["https://evil.co/pay"]);
    expect(linksNotInThread("Log in at bank.com", "Your statement from mybank.com")).toEqual(["bank.com"]);
    expect(linksNotInThread("Go to https://pay.example", "https://pay.example.org/invoice/1")).toEqual(["https://pay.example"]);
  });

  it("equal hosts and subdomains of a thread host count as known; parent domains of a thread host don't", () => {
    const thread = "Menu at https://www.cafe.example.org/menu, booking via cafe.example.org, from Alice <alice@example.net>";
    expect(linksNotInThread("https://cafe.example.org/book and https://order.cafe.example.org/x and example.net", thread)).toEqual([]);
    expect(linksNotInThread("https://example.org/", "https://cafe.example.org/")).toEqual(["https://example.org/"]); // a parent of a thread host isn't known
    expect(linksNotInThread("https://xcafe.example.org/", "cafe.example.org")).toEqual(["https://xcafe.example.org/"]);
  });

  it("IDN: Unicode names are compared in punycode, so a homograph never matches the real domain", () => {
    const fakeA = String.fromCharCode(0x0430); // Cyrillic small a
    const homograph = `p${fakeA}ypal.com`;
    expect(normalizeHost(homograph)).toMatch(/^xn--/);
    expect(linksNotInThread(`Verify at ${homograph}`, "Receipt from paypal.com")).toEqual([normalizeHost(homograph)]);
    expect(linksNotInThread(`Verify at https://${homograph}/login`, "Receipt from paypal.com")).toEqual([`https://${homograph}/login`.toLowerCase()]);
    const real = `b${String.fromCharCode(0xfc)}cher.example`; // bücher.example
    expect(linksNotInThread(`Order at ${real}`, `Your order at ${real}`)).toEqual([]);
    expect(hostsIn(`see ${real}`).has("xn--bcher-kva.example")).toBe(true);
  });

  it("ordinary text has no links", () => {
    expect(linksNotInThread("Version 1.2.3, e.g. Tuesday. Café ok.", "")).toEqual([]);
  });
});

describe("O2: more invisible characters are flagged and removed", () => {
  it("U+180E, U+061C, U+2028/U+2029 and the tag characters U+E0000-E007F", () => {
    for (const c of [0x180e, 0x061c, 0x2028, 0x2029, 0xe0000, 0xe0041, 0xe007f]) expect(isInvisibleOrBidi(c), c.toString(16)).toBe(true);
    for (const c of [0x41, 0xe9, 0xe0080, 0x1f600]) expect(isInvisibleOrBidi(c), c.toString(16)).toBe(false);
  });

  it("tag characters (astral) are found with their UTF-16 index, listed in the warning and stripped from summaries", () => {
    const hidden = [0xe0049, 0xe0067, 0xe006e].map(cp).join(""); // "Ign" in tag characters
    const text = `Hello${hidden} world${cp(0x2028)}`;
    expect(findInvisible(text)).toEqual([
      { codePoint: 0xe0049, index: 5 },
      { codePoint: 0xe0067, index: 7 },
      { codePoint: 0xe006e, index: 9 },
      { codePoint: 0x2028, index: 17 },
    ]);
    expect(invisibleCharacters(text).items[0]).toEqual({ codePoint: "U+E0049", index: 5 });
    expect(stripInvisible(text)).toBe("Hello world");
    expect(cleanSummary(`Pay now${hidden}${cp(0x180e)}`)).toBe("Pay now");
  });
});
