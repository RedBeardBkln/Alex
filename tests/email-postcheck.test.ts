import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isStructurallySafe as fromHtmlModule } from "@/lib/email-html";
import { EMAIL_ALLOWED_TAGS, isStructurallySafe } from "@/lib/email/postcheck";

// Round 10 (security W1): the structural post-check lives in an import-free module, so the main
// thread can re-check worker output without loading the sanitizer.

describe("postcheck module", () => {
  it("has no imports at all", () => {
    const code = readFileSync(path.resolve(import.meta.dirname, "../src/lib/email/postcheck.ts"), "utf8");
    expect(code).not.toMatch(/^\s*import\b/m);
    expect(code).not.toMatch(/\brequire\(|\bimport\(/);
  });

  it("is the same function email-html.ts uses", () => {
    expect(fromHtmlModule).toBe(isStructurallySafe);
  });

  it("accepts sanitized shapes and rejects breakouts and unknown tags", () => {
    expect(isStructurallySafe('<p style="color:red">Hi <img alt="a" /></p><style>a{color:red}</style>')).toBe(true);
    expect(isStructurallySafe("<p>a &lt;script&gt;</p>")).toBe(true);
    expect(isStructurallySafe("<p>hi</p><script>alert(1)</script>")).toBe(false);
    expect(isStructurallySafe("<style>a{}</sty</style><img src=x onerror=alert(1)>")).toBe(false);
    expect(isStructurallySafe("<style>a{}")).toBe(false);
    expect(isStructurallySafe("<iframe src=x></iframe>")).toBe(false);
    expect(isStructurallySafe("<META http-equiv=refresh>")).toBe(false);
  });

  it("the allowlist includes style and the common email tags, and no active or loading tags", () => {
    for (const t of ["style", "table", "td", "img", "a", "p", "div", "span"]) expect(EMAIL_ALLOWED_TAGS).toContain(t);
    for (const t of ["script", "iframe", "object", "embed", "form", "input", "link", "meta", "base", "svg", "math"]) expect(EMAIL_ALLOWED_TAGS).not.toContain(t);
  });
});
