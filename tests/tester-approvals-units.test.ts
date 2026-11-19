import { describe, expect, it } from "vitest";
import { ReauthRequiredError } from "@/lib/accounts";
import { extractAddresses, isValidAddress, parseRecipientInput, replyDefaults, replyToDiffers } from "@/lib/approvals/addresses";
import { isAllowedOrigin } from "@/lib/approvals/origin";
import { quoteText, MAX_QUOTE_CHARS } from "@/lib/approvals/payload";
import { buildMessage, ComposeError, MSG_ID_RE, replySubject, replyThreading, toRaw } from "@/lib/gmail/compose";
import { sendRawMessage } from "@/lib/gmail/send";

// Tester (phase 2b): the send classifier around the 401 refresh-and-retry, Origin look-alikes,
// recipient extraction on hostile headers, and MIME builder edges.

type Call = { url: string; body: string; auth: string | null };
function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body), auth: new Headers(init?.headers).get("authorization") });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next();
  };
  return { calls, fn };
}
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokens = (list: (string | Error)[]) => {
  const seen: (boolean | undefined)[] = [];
  const fn = async (opts?: { forceRefresh?: boolean }) => {
    seen.push(opts?.forceRefresh);
    const t = list.shift();
    if (t instanceof Error) throw t;
    return t!;
  };
  return { seen, fn };
};
const REQ = { raw: "cmF3", threadId: "t1" };

describe("sendRawMessage: exactly one request, a 401 is failed (round 2: the refresh-and-retry was removed)", () => {
  it("401: exactly one POST, failed gmail_401, and the token is never refreshed", async () => {
    for (const body of [{ error: { code: 401, status: "UNAUTHENTICATED" } }, { id: "m1", threadId: "t1" }, "not json"]) {
      const f = fakeFetch([json(401, body)]);
      const t = tokens(["old", "should-not-be-used"]);
      expect(await sendRawMessage(t.fn, REQ, f.fn)).toEqual({ kind: "failed", code: "gmail_401", status: 401 });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.auth).toBe("Bearer old");
      expect(JSON.parse(f.calls[0]!.body)).toEqual({ raw: "cmF3", threadId: "t1" });
      expect(t.seen).toEqual([undefined]);
    }
  });

  it("whatever the first answer is, there is never a second request", async () => {
    const answers = [json(200, { id: "m1", threadId: "t1" }), json(200, { nope: 1 }), json(401, {}), json(403, {}), json(408, {}), json(429, {}), json(500, {}), json(503, {}), json(302, {}), () => Promise.reject(new TypeError("fetch failed")), () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }))];
    for (const a of answers) {
      const f = fakeFetch([a, json(200, { id: "second", threadId: "t1" })]);
      const r = await sendRawMessage(tokens(["a", "b"]).fn, REQ, f.fn);
      expect(f.calls).toHaveLength(1);
      expect(r.kind === "succeeded" ? r.gmailMessageId : r.kind).not.toBe("second");
    }
  });

  it("classification: 4xx failed, 5xx/3xx unknown, one POST each", async () => {
    for (const [status, kind] of [[403, "failed"], [429, "failed"], [400, "failed"], [404, "failed"], [500, "unknown"], [502, "unknown"], [302, "unknown"]] as const) {
      const f = fakeFetch([json(status, {})]);
      const r = await sendRawMessage(tokens(["a"]).fn, REQ, f.fn);
      expect(r.kind, String(status)).toBe(kind);
      expect(f.calls).toHaveLength(1);
    }
  });

  it("a token failure before any request: failed with zero requests", async () => {
    for (const err of [new ReauthRequiredError("acc", "x"), new Error("decrypt failed")]) {
      const f = fakeFetch([]);
      const r = await sendRawMessage(tokens([err]).fn, REQ, f.fn);
      expect(r.kind).toBe("failed");
      expect(f.calls).toHaveLength(0);
    }
  });
});

describe("Origin check look-alikes", () => {
  const APP = "https://alex.example.com";
  it("only the exact APP_URL origin passes", () => {
    expect(isAllowedOrigin("https://alex.example.com", APP)).toBe(true);
    for (const o of [
      null, "", "null", "https://alex.example.com.evil.example", "https://evil.example/https://alex.example.com", "http://alex.example.com",
      "https://alex.example.com:444", "https://user@alex.example.com", "https://xalex.example.com", "https://alex.example.co",
      "https://alex.example.com/path", "https://alex.example.com, https://evil.example", " https://alex.example.com", "https://alex.example.com.",
      "file://", "chrome-extension://abc",
    ]) {
      expect(isAllowedOrigin(o, APP), String(o)).toBe(false);
    }
  });
});

describe("recipient extraction on hostile headers", () => {
  it("never yields an address that came only from a display name, comment, group or encoded word", () => {
    const from = '"ceo@example.com" <attacker@evil.example>';
    expect(extractAddresses(from).addresses).toEqual(["attacker@evil.example"]);
    expect(extractAddresses("=?UTF-8?B?Y2VvQGV4YW1wbGUuY29t?= <a@evil.example>").addresses).toEqual(["a@evil.example"]);
    const e = extractAddresses('team: x@example.org, y@example.org;, z@example.org (CEO <ceo@example.com>), "a, b" <ok@example.org>, <@route:r@example.org>, bad@, @bad, a@b');
    expect(e.addresses).toEqual(["ok@example.org"]);
    expect(e.unreadable).toBeGreaterThanOrEqual(5);
    expect(extractAddresses('"unbalanced <x@example.org>').unreadable).toBe(1);
  });

  it("Reply-To warning: set exactly when a To address came from a Reply-To that isn't the sender; case-insensitive", () => {
    const p = (fromHeader: string, replyToHeader: string | null) => ({ isSent: false, fromHeader, toHeader: "me@example.com", ccHeader: null, replyToHeader });
    const d = (h: ReturnType<typeof p>) => replyToDiffers(h, replyDefaults(h, "me@example.com", "reply").to);
    expect(d(p("A <a@example.org>", "billing@evil.example"))).toBe(true);
    expect(d(p("A <a@example.org>", "A@EXAMPLE.ORG"))).toBe(false);
    expect(d(p("A <a@example.org>", null))).toBe(false);
    // An unreadable Reply-To: Reply goes nowhere (To empty) rather than falling back to From silently.
    const unreadable = p("A <a@example.org>", "group: x@evil.example;");
    expect(replyDefaults(unreadable, "me@example.com", "reply")).toMatchObject({ to: [], unreadable: 1 });
  });

  it("own address removed case-insensitively; owner-typed input splits on whitespace, comma and semicolon only", () => {
    const h = { isSent: false, fromHeader: "a@example.org", toHeader: "ME@Example.com, b@example.org", ccHeader: "me@example.com", replyToHeader: null };
    expect(replyDefaults(h, "me@example.com", "all")).toEqual({ to: ["a@example.org"], cc: ["b@example.org"], unreadable: 0 });
    expect(parseRecipientInput("a@example.org\r\nBcc: x@evil.example")).toEqual({ addresses: ["a@example.org", "x@evil.example"], invalid: ["Bcc:"] });
    expect(isValidAddress("a@example.org ")).toBe(false);
    expect(isValidAddress("a@exam\u0000ple.org")).toBe(false);
  });
});

describe("MIME builder edges", () => {
  const base = {
    from: "me@example.com",
    to: ["a@example.org"],
    cc: [],
    subject: "Re: x",
    bodyText: "hi",
    messageId: "<alex.1.1.abc@alex.example.com>",
    inReplyTo: null,
    references: [],
    date: new Date("2026-11-19T10:00:00Z"),
  };
  it("rejects any injected id, address or subject rather than emitting it", () => {
    for (const over of [
      { messageId: "<a@b>\r\nBcc: x@evil.example" },
      { inReplyTo: "<a@b> <c@d>" },
      { references: ["<a@b>\nBcc: x@evil.example"] },
      { to: ["a@example.org\r\nBcc: x@evil.example"] },
      { cc: ["a@example.org,b@evil.example"] },
      { from: "Me <me@example.com>" },
      { subject: "x Bcc: y" },
      { subject: "x\u0085y" },
    ]) {
      expect(() => buildMessage({ ...base, ...over }), JSON.stringify(over)).toThrow(ComposeError);
    }
  });
  it("threading drops invalid parent ids; an invalid parent Message-ID omits both headers", () => {
    expect(replyThreading("t", { rfc822MessageId: "<p@x> junk", references: null, inReplyTo: null })).toEqual({ gmailThreadId: "t", inReplyTo: null, references: [] });
    const t = replyThreading("t", { rfc822MessageId: "<p@x>", references: "<a@x> <b c@x> <d@x>\r\n <e@x>", inReplyTo: null });
    expect(t.references).toEqual(["<a@x>", "<d@x>", "<e@x>", "<p@x>"]);
    const many = Array.from({ length: 40 }, (_, i) => `<id${i}@${"h".repeat(60)}>`).join(" ");
    const t2 = replyThreading("t", { rfc822MessageId: "<p@x>", references: many, inReplyTo: null });
    expect(t2.references[0]).toBe("<id0@" + "h".repeat(60) + ">");
    expect(t2.references.at(-1)).toBe("<p@x>");
    expect(t2.references.join(" ").length).toBeLessThanOrEqual(900);
    for (const r of t2.references) expect(r).toMatch(MSG_ID_RE);
  });
  it("Re: rule and a control-laden parent subject", () => {
    expect(replySubject("  RE:  hi")).toBe("RE:  hi");
    expect(replySubject("Re hi")).toBe("Re: Re hi");
    expect(replySubject("a\r\nBcc: x y")).toBe("Re: a Bcc: x y");
    expect(replySubject(null)).toBe("Re:"); // round 2: trimmed, so it equals the stored subject
    expect(replySubject("")).toBe("Re:");
    expect(replySubject("   ")).toBe("Re:");
  });
  it("raw is unpadded base64url of the exact bytes", () => {
    const m = buildMessage(base);
    const raw = toRaw(m);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(raw, "base64url").toString("utf8")).toBe(m);
  });
  it("quote cap counts the whole quote including the attribution", () => {
    const q = quoteText({ fromHeader: "A <a@example.org>", dateHeader: "Wed, 18 Nov 2026 10:00:00 GMT", text: "x\n".repeat(30_000) });
    expect(q.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(q.startsWith("On Wed, 18 Nov 2026 10:00:00 GMT, A <a@example.org> wrote:\n> x\n> x")).toBe(true);
  });
});

describe("round 4 (B2): status classification for every status family", () => {
  it("2xx succeeded; exactly 400/401/403/404/429 failed; every other status unknown", async () => {
    const { classifySendStatus } = await import("@/lib/gmail/send");
    const failed = new Set([400, 401, 403, 404, 429]);
    const wrong: string[] = [];
    for (const s of [0, 1, 99, ...Array.from({ length: 500 }, (_, i) => i + 100), 600, 999, -1, 200.5, Number.NaN]) {
      const want = s >= 200 && s < 300 ? "succeeded" : failed.has(s) ? "failed" : "unknown";
      if (classifySendStatus(s) !== want) wrong.push(`${s}:${classifySendStatus(s)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("sendRawMessage: one request per family sample, code is gmail_<status> (gmail_5xx for 5xx)", async () => {
    for (const [status, kind, code] of [[408, "unknown", "gmail_408"], [409, "unknown", "gmail_409"], [499, "unknown", "gmail_499"], [418, "unknown", "gmail_418"], [451, "unknown", "gmail_451"], [400, "failed", "gmail_400"], [429, "failed", "gmail_429"], [503, "unknown", "gmail_5xx"], [599, "unknown", "gmail_5xx"], [304, "unknown", "gmail_304"]] as const) {
      const f = fakeFetch([status === 304 ? () => new Response(null, { status }) : json(status, {})]);
      expect(await sendRawMessage(tokens(["a"]).fn, REQ, f.fn), String(status)).toEqual({ kind, code, status });
      expect(f.calls).toHaveLength(1);
    }
  });
});
