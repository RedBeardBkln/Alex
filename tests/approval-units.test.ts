import { describe, expect, it } from "vitest";
import { ReauthRequiredError } from "@/lib/accounts";
import { extractAddresses, isValidAddress, parseRecipientInput, replyDefaults, replyToDiffers } from "@/lib/approvals/addresses";
import { isAllowedOrigin } from "@/lib/approvals/origin";
import { canonicalJson, contentHash, emailSendPayload, outgoingBody, quoteText, type EmailSendPayload } from "@/lib/approvals/payload";
import { classifySendStatus, sendRawMessage } from "@/lib/gmail/send";

// Phase 2b: recipient extraction (AC8), payload schema and hash, the outcome classifier (AC6),
// the Origin check (AC9) and the send call shape.

describe("recipient extraction (AC8)", () => {
  it("reads addr-spec and name <addr-spec> tokens, including quoted names with commas", () => {
    expect(extractAddresses('Alice <alice@example.org>, bob@example.net, "Smith, Carol" <carol@example.net>')).toEqual({
      addresses: ["alice@example.org", "bob@example.net", "carol@example.net"],
      unreadable: 0,
    });
  });

  it("groups, comments and malformed tokens are counted as unreadable", () => {
    expect(extractAddresses("Team: a@example.org, b@example.org;")).toEqual({ addresses: [], unreadable: 2 });
    expect(extractAddresses("a@example.org (Alice), b@example.org").unreadable).toBe(1);
    expect(extractAddresses("not an address, broken@, x@y@z.org").unreadable).toBe(3);
    expect(extractAddresses("ok@example.org, <unbalanced@example.org")).toEqual({ addresses: [], unreadable: 1 }); // unbalanced: the whole header
    expect(extractAddresses('"unbalanced <a@example.org>')).toEqual({ addresses: [], unreadable: 1 });
    expect(extractAddresses("Name <a@example.org> <b@example.org>").unreadable).toBe(1);
    expect(extractAddresses("")).toEqual({ addresses: [], unreadable: 0 });
    expect(extractAddresses(null)).toEqual({ addresses: [], unreadable: 0 });
  });

  const parent = {
    isSent: false,
    fromHeader: "Alice <alice@example.org>",
    toHeader: "Work <work@example.com>, dave@example.org, ALICE@example.org",
    ccHeader: "erin@example.org, Work@Example.com",
    replyToHeader: null as string | null,
  };

  it("Reply: From; Reply all: plus To and Cc, without the sending account and duplicates", () => {
    expect(replyDefaults(parent, "work@example.com", "reply")).toEqual({ to: ["alice@example.org"], cc: [], unreadable: 0 });
    expect(replyDefaults(parent, "work@example.com", "all")).toEqual({ to: ["alice@example.org"], cc: ["dave@example.org", "erin@example.org"], unreadable: 0 });
  });

  it("Reply uses Reply-To when present, and the warning appears exactly when it differs from From", () => {
    const withReplyTo = { ...parent, replyToHeader: "Billing <billing@other.example>" };
    const d = replyDefaults(withReplyTo, "work@example.com", "reply");
    expect(d.to).toEqual(["billing@other.example"]);
    expect(replyToDiffers(withReplyTo, d.to)).toBe(true);
    expect(replyToDiffers(withReplyTo, ["alice@example.org"])).toBe(false);
    const same = { ...parent, replyToHeader: "alice@example.org" };
    expect(replyToDiffers(same, replyDefaults(same, "work@example.com", "reply").to)).toBe(false);
    expect(replyToDiffers(parent, ["alice@example.org"])).toBe(false);
  });

  it("an unreadable Reply-To is reported, not silently replaced by From", () => {
    expect(replyDefaults({ ...parent, replyToHeader: "Group: x@example.org;" }, "work@example.com", "reply")).toEqual({ to: [], cc: [], unreadable: 1 });
  });

  it("replying to the owner's own sent message goes to its To (and Cc for Reply all)", () => {
    const sent = { ...parent, isSent: true, fromHeader: "work@example.com", toHeader: "alice@example.org", ccHeader: "bob@example.org" };
    expect(replyDefaults(sent, "work@example.com", "reply")).toEqual({ to: ["alice@example.org"], cc: [], unreadable: 0 });
    expect(replyDefaults(sent, "work@example.com", "all")).toEqual({ to: ["alice@example.org"], cc: ["bob@example.org"], unreadable: 0 });
  });

  it("owner input: separators, invalid tokens and de-duplication", () => {
    expect(parseRecipientInput("a@example.org, b@example.org\nA@example.org;c@example.org")).toEqual({
      addresses: ["a@example.org", "b@example.org", "c@example.org"],
      invalid: [],
    });
    expect(parseRecipientInput("Alice <a@example.org>").invalid.length).toBeGreaterThan(0);
  });

  it("isValidAddress accepts dot-atoms and punycode domains only", () => {
    for (const ok of ["a@example.org", "first.last+tag@sub.example.co.uk", "x@xn--bcher-kva.example", "o'brien@example.ie"]) expect(isValidAddress(ok), ok).toBe(true);
    for (const bad of [".a@example.org", "a.@example.org", "a..b@example.org", "a@example", "a@example..org", "a@exa_mple.org"]) expect(isValidAddress(bad), bad).toBe(false);
  });
});

describe("payload schema and content hash", () => {
  const payload: EmailSendPayload = {
    to: ["a@example.org"],
    cc: [],
    subject: "Re: x",
    bodyText: "hi",
    quote: { included: true, text: "> q" },
    threading: { gmailThreadId: "abc", inReplyTo: "<p@x.example>", references: ["<p@x.example>"] },
    replyToNotice: false,
  };

  it("the hash covers kind, account and every payload field, independent of key order", () => {
    const h = contentHash("email.send", "acc", payload);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    expect(contentHash("email.send", "acc", reordered)).toBe(h);
    expect(contentHash("email.send", "other", payload)).not.toBe(h);
    for (const change of [{ to: ["b@example.org"] }, { subject: "Re: y" }, { bodyText: "hi!" }, { quote: { included: false, text: "> q" } }, { replyToNotice: true }]) {
      expect(contentHash("email.send", "acc", { ...payload, ...change })).not.toBe(h);
    }
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("rejects unknown keys, bad addresses, CR/LF subjects and bad threading ids", () => {
    expect(emailSendPayload.safeParse(payload).success).toBe(true);
    expect(emailSendPayload.safeParse({ ...payload, bcc: ["x@example.org"] }).success).toBe(false);
    expect(emailSendPayload.safeParse({ ...payload, to: ["bad"] }).success).toBe(false);
    expect(emailSendPayload.safeParse({ ...payload, to: [] }).success).toBe(false);
    expect(emailSendPayload.safeParse({ ...payload, subject: "a\nb" }).success).toBe(false);
    expect(emailSendPayload.safeParse({ ...payload, threading: { ...payload.threading!, inReplyTo: "<a b@x>" } }).success).toBe(false);
    expect(emailSendPayload.safeParse({ ...payload, threading: { ...payload.threading!, gmailThreadId: "../x" } }).success).toBe(false);
  });

  it("the sent body is the owner's text plus the quote only when included", () => {
    expect(outgoingBody(payload)).toBe("hi\n\n> q");
    expect(outgoingBody({ ...payload, quote: { included: false, text: "> q" } })).toBe("hi");
    expect(outgoingBody({ ...payload, quote: null })).toBe("hi");
  });

  it("the quote is > lines with an attribution, capped at 20,000 characters", () => {
    expect(quoteText({ fromHeader: "Alice <a@example.org>", dateHeader: "Mon, 1 Jan 2026", text: "one\n\ntwo" })).toBe(
      "On Mon, 1 Jan 2026, Alice <a@example.org> wrote:\n> one\n>\n> two",
    );
    expect(quoteText({ fromHeader: null, dateHeader: null, text: "x\n".repeat(50_000) }).length).toBe(20_000);
    expect(quoteText({ fromHeader: null, dateHeader: null, text: "   " })).toBe("");
  });
});

describe("Origin check (AC9)", () => {
  it("requires the exact APP_URL origin", () => {
    expect(isAllowedOrigin("https://alex.example.com", "https://alex.example.com")).toBe(true);
    for (const bad of [null, "", "null", "https://evil.example", "http://alex.example.com", "https://alex.example.com:444", "https://alex.example.com.evil.example", "https://sub.alex.example.com", "not a url"]) {
      expect(isAllowedOrigin(bad, "https://alex.example.com"), String(bad)).toBe(false);
    }
  });
});

describe("messages.send call and outcome classification (AC6)", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const respond = (...responses: (number | Error)[]) => {
    calls.length = 0;
    return async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init! });
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return new Response(r === 200 ? JSON.stringify({ id: "m1", threadId: "t1", labelIds: ["SENT"] }) : JSON.stringify({ error: { errors: [{ reason: "x" }] } }), { status: r });
    };
  };
  const token = async () => "tok";

  it("POSTs the documented URL with { raw, threadId } and a bearer token", async () => {
    const out = await sendRawMessage(token, { raw: "UkFX", threadId: "t1" }, respond(200));
    expect(out).toEqual({ kind: "succeeded", gmailMessageId: "m1", gmailThreadId: "t1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ raw: "UkFX", threadId: "t1" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("400/401/403/404/429: failed; every other non-2xx, network errors and timeouts: unknown; one request each (B2)", async () => {
    for (const status of [400, 401, 403, 404, 429]) {
      expect(await sendRawMessage(token, { raw: "x", threadId: null }, respond(status))).toEqual({ kind: "failed", code: `gmail_${status}`, status });
      expect(calls).toHaveLength(1);
    }
    for (const status of [500, 503]) {
      expect(await sendRawMessage(token, { raw: "x", threadId: null }, respond(status))).toEqual({ kind: "unknown", code: "gmail_5xx", status });
      expect(calls).toHaveLength(1);
    }
    for (const status of [402, 405, 408, 409, 410, 413, 418, 422, 499]) {
      expect(await sendRawMessage(token, { raw: "x", threadId: null }, respond(status)), String(status)).toEqual({ kind: "unknown", code: `gmail_${status}`, status });
      expect(calls).toHaveLength(1);
    }
    expect(await sendRawMessage(token, { raw: "x", threadId: null }, respond(new TypeError("fetch failed")))).toEqual({ kind: "unknown", code: "network", status: null });
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(await sendRawMessage(token, { raw: "x", threadId: null }, respond(timeout))).toEqual({ kind: "unknown", code: "timeout", status: null });
  });

  it("a 401 is not retried: failed after exactly one request, with no token refresh (review round 1)", async () => {
    const refreshed: boolean[] = [];
    const tok = async (o?: { forceRefresh?: boolean }) => {
      refreshed.push(!!o?.forceRefresh);
      return "old";
    };
    expect(await sendRawMessage(tok, { raw: "x", threadId: null }, respond(401, 200))).toEqual({ kind: "failed", code: "gmail_401", status: 401 });
    expect(calls).toHaveLength(1);
    expect(refreshed).toEqual([false]);
  });

  it("ReauthRequiredError (or any token failure) means failed with no request", async () => {
    const fetchSpy = respond(200);
    expect(await sendRawMessage(async () => { throw new ReauthRequiredError("a", "expired"); }, { raw: "x", threadId: null }, fetchSpy)).toEqual({ kind: "failed", code: "reauth_required", status: null });
    expect(await sendRawMessage(async () => { throw new Error("boom"); }, { raw: "x", threadId: null }, fetchSpy)).toEqual({ kind: "failed", code: "token_unavailable", status: null });
    expect(calls).toHaveLength(0);
  });

  it("a 2xx with an unreadable body is unknown (it was probably sent; reconcile finds it)", async () => {
    const f = async () => new Response("not json", { status: 200 });
    expect(await sendRawMessage(token, { raw: "x", threadId: null }, f)).toEqual({ kind: "unknown", code: "gmail_shape", status: 200 });
  });

  it("classifySendStatus", () => {
    expect([200, 204, 400, 401, 403, 404, 429, 408, 409, 499, 500, 503, 302, 100].map(classifySendStatus)).toEqual([
      "succeeded", "succeeded", "failed", "failed", "failed", "failed", "failed", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown",
    ]);
  });
});
