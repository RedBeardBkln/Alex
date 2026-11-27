import { describe, expect, it } from "vitest";
import { createGmailClient, GmailApiError, GmailShapeError } from "@/lib/gmail/client";

type Seen = { url: URL; method: string; body: unknown; auth: string | null };

function fakeFetch(responses: { status: number; body?: unknown }[]) {
  const seen: Seen[] = [];
  const impl = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: new URL(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers.get("authorization"),
    });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
  return { impl, seen };
}

function client(responses: { status: number; body?: unknown }[]) {
  const f = fakeFetch(responses);
  const tokens: boolean[] = [];
  const gmail = createGmailClient(async (opts) => {
    tokens.push(!!opts?.forceRefresh);
    return opts?.forceRefresh ? "token-2" : "token-1";
  }, f.impl);
  return { gmail, seen: f.seen, tokens };
}

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

describe("Gmail client requests", () => {
  it("getProfile", async () => {
    const { gmail, seen } = client([{ status: 200, body: { historyId: "123", emailAddress: "a@example.com", messagesTotal: 1 } }]);
    expect(await gmail.getProfile()).toMatchObject({ historyId: "123" });
    expect(seen[0]!.url.href).toBe(`${BASE}/profile`);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.auth).toBe("Bearer token-1");
  });

  it("watch posts topic, INBOX and the label filter behaviour", async () => {
    const { gmail, seen } = client([{ status: 200, body: { historyId: "5", expiration: "1800000000000" } }]);
    const res = await gmail.watch({ topicName: "projects/p/topics/t", labelIds: ["INBOX"], labelFilterBehavior: "include" });
    expect(res).toEqual({ historyId: "5", expiration: "1800000000000" });
    expect(seen[0]!.url.href).toBe(`${BASE}/watch`);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toEqual({ topicName: "projects/p/topics/t", labelIds: ["INBOX"], labelFilterBehavior: "include" });
  });

  it("stop posts to /stop", async () => {
    const { gmail, seen } = client([{ status: 204 }]);
    await gmail.stop();
    expect(seen[0]!.url.href).toBe(`${BASE}/stop`);
    expect(seen[0]!.method).toBe("POST");
  });

  it("history.list asks for all four history types and never a labelId", async () => {
    const { gmail, seen } = client([{ status: 200, body: { historyId: "9" } }]);
    await gmail.listHistory({ startHistoryId: "42", pageToken: "pt" });
    const p = seen[0]!.url.searchParams;
    expect(seen[0]!.url.pathname).toBe("/gmail/v1/users/me/history");
    expect(p.get("startHistoryId")).toBe("42");
    expect(p.get("maxResults")).toBe("500");
    expect(p.getAll("historyTypes")).toEqual(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]);
    expect(p.has("labelId")).toBe(false);
    expect(p.get("pageToken")).toBe("pt");
  });

  it("messages.list passes labelIds and an epoch-seconds after: query", async () => {
    const { gmail, seen } = client([{ status: 200, body: { messages: [{ id: "m", threadId: "t" }] } }]);
    const res = await gmail.listMessages({ labelIds: ["SENT"], q: "after:1794000000" });
    expect(res.messages).toEqual([{ id: "m", threadId: "t" }]);
    const p = seen[0]!.url.searchParams;
    expect(seen[0]!.url.pathname).toBe("/gmail/v1/users/me/messages");
    expect(p.getAll("labelIds")).toEqual(["SENT"]);
    expect(p.get("q")).toBe("after:1794000000");
    expect(p.get("maxResults")).toBe("500");
    expect(p.has("pageToken")).toBe(false);
  });

  it("messages.get uses format=minimal or format=full", async () => {
    const { gmail, seen } = client([
      { status: 200, body: { id: "18c2f0a1b2c3d4e5", threadId: "t", labelIds: ["INBOX"] } },
      { status: 200, body: { id: "18c2f0a1b2c3d4e5", threadId: "t", payload: { mimeType: "text/plain", body: { size: 1, data: "eA" } } } },
    ]);
    await gmail.getMessageMinimal("18c2f0a1b2c3d4e5");
    await gmail.getMessageFull("18c2f0a1b2c3d4e5");
    expect(seen[0]!.url.href).toBe(`${BASE}/messages/18c2f0a1b2c3d4e5?format=minimal`);
    expect(seen[1]!.url.href).toBe(`${BASE}/messages/18c2f0a1b2c3d4e5?format=full`);
  });

  it("attachments.get path for a body part", async () => {
    const { gmail, seen } = client([{ status: 200, body: { size: 3, data: "eHl6" } }]);
    expect(await gmail.getBodyPartData("m1", "att1")).toEqual({ size: 3, data: "eHl6" });
    expect(seen[0]!.url.href).toBe(`${BASE}/messages/m1/attachments/att1`);
    expect(seen[0]!.method).toBe("GET");
  });
});

describe("Gmail client errors", () => {
  it("maps non-2xx to GmailApiError with status and a token-like reason only", async () => {
    const { gmail } = client([
      { status: 404, body: { error: { code: 404, message: "Requested entity was not found.", errors: [{ reason: "notFound" }], status: "NOT_FOUND" } } },
    ]);
    const err = await gmail.listHistory({ startHistoryId: "1" }).catch((e) => e);
    expect(err).toBeInstanceOf(GmailApiError);
    expect(err.status).toBe(404);
    expect(err.reason).toBe("notFound");
    expect(err.transient).toBe(false);
    expect(String(err.message)).not.toContain("Requested entity");
  });

  it("429 and 5xx are transient", async () => {
    const { gmail } = client([{ status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } }, { status: 503 }]);
    const a = await gmail.getProfile().catch((e) => e);
    const b = await gmail.getProfile().catch((e) => e);
    expect([a.status, a.reason, a.transient]).toEqual([429, "RESOURCE_EXHAUSTED", true]);
    expect([b.status, b.reason, b.transient]).toEqual([503, null, true]);
  });

  it("drops a reason that isn't a short token", async () => {
    const { gmail } = client([{ status: 400, body: { error: { errors: [{ reason: "has spaces and a subject line" }] } } }]);
    const err = await gmail.getProfile().catch((e) => e);
    expect(err.reason).toBeNull();
  });

  it("retries once with a forced token refresh on 401", async () => {
    const { gmail, seen, tokens } = client([{ status: 401 }, { status: 200, body: { historyId: "7" } }]);
    expect(await gmail.getProfile()).toMatchObject({ historyId: "7" });
    expect(tokens).toEqual([false, true]);
    expect(seen.map((s) => s.auth)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("gives up after a second 401", async () => {
    const { gmail } = client([{ status: 401 }, { status: 401 }]);
    const err = await gmail.getProfile().catch((e) => e);
    expect(err).toBeInstanceOf(GmailApiError);
    expect(err.status).toBe(401);
  });

  it("rejects a 2xx body with the wrong shape", async () => {
    const { gmail } = client([{ status: 200, body: { nothing: true } }]);
    await expect(gmail.getProfile()).rejects.toBeInstanceOf(GmailShapeError);
  });
});

describe("Gmail id validation (round 4, N2)", () => {
  for (const bad of ["a/b", "..", ".", "a.b", "%2e%2e", "a b", "", "a?b", "a#b", "a\b", "x".repeat(257)]) {
    it(`refuses message id ${JSON.stringify(bad.slice(0, 20))} without any request`, async () => {
      const { gmail, seen } = client([]);
      await expect(gmail.getMessageMinimal(bad)).rejects.toBeInstanceOf(GmailShapeError);
      await expect(gmail.getMessageFull(bad)).rejects.toBeInstanceOf(GmailShapeError);
      await expect(gmail.getBodyPartData(bad, "att1")).rejects.toBeInstanceOf(GmailShapeError);
      await expect(gmail.getBodyPartData("m1", bad === "x".repeat(257) ? "x".repeat(4097) : bad)).rejects.toBeInstanceOf(GmailShapeError);
      expect(seen).toHaveLength(0);
    });
  }

  it("accepts long URL-safe attachment ids", async () => {
    const { gmail, seen } = client([{ status: 200, body: { size: 1, data: "eA" } }]);
    await gmail.getBodyPartData("m1", "ANGjdJ_" + "a-B_9".repeat(150));
    expect(seen).toHaveLength(1);
  });
});

// Phase email-signatures, plan step 2: users.settings.sendAs.get for the account's own address.
describe("getSendAs (settings.sendAs.get)", () => {
  const me = "owner@example.com";
  it("200 with a signature: one GET to settings/sendAs/{address}", async () => {
    const { gmail, seen } = client([{ status: 200, body: { sendAsEmail: me, signature: "<div>Jane</div>", isPrimary: true, displayName: "Jane" } }]);
    expect(await gmail.getSendAs(me)).toEqual({ kind: "found", signature: "<div>Jane</div>" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.href).toBe(`${BASE}/settings/sendAs/owner%40example.com`);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.body).toBeUndefined();
  });

  it("200 without a signature, or with an empty one: signature null", async () => {
    expect(await client([{ status: 200, body: { sendAsEmail: me } }]).gmail.getSendAs(me)).toEqual({ kind: "found", signature: null });
    expect(await client([{ status: 200, body: { sendAsEmail: me, signature: "" } }]).gmail.getSendAs(me)).toEqual({ kind: "found", signature: null });
  });

  it("the returned address is compared ASCII case-insensitively; a different one is a shape error", async () => {
    expect(await client([{ status: 200, body: { sendAsEmail: "Owner@Example.COM", signature: "x" } }]).gmail.getSendAs(me)).toEqual({ kind: "found", signature: "x" });
    await expect(client([{ status: 200, body: { sendAsEmail: "other@example.com", signature: "x" } }]).gmail.getSendAs(me)).rejects.toBeInstanceOf(GmailShapeError);
    // U+212A KELVIN SIGN lowercases to "k" with toLowerCase(); it must not match.
    const kelvin = String.fromCharCode(0x212a);
    await expect(client([{ status: 200, body: { sendAsEmail: `${kelvin}ate@example.com` } }]).gmail.getSendAs("kate@example.com")).rejects.toBeInstanceOf(GmailShapeError);
  });

  it("404 is not_found; 403, 429 and 5xx are GmailApiError; a malformed body is a shape error", async () => {
    expect(await client([{ status: 404, body: { error: { errors: [{ reason: "notFound" }] } } }]).gmail.getSendAs(me)).toEqual({ kind: "not_found" });
    for (const status of [403, 429, 500, 503]) {
      const err = await client([{ status, body: { error: { errors: [{ reason: "someReason" }] } } }]).gmail.getSendAs(me).catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(GmailApiError);
      expect((err as GmailApiError).status).toBe(status);
    }
    await expect(client([{ status: 200, body: { signature: "x" } }]).gmail.getSendAs(me)).rejects.toBeInstanceOf(GmailShapeError);
    await expect(client([{ status: 200, body: { sendAsEmail: me, signature: 5 } }]).gmail.getSendAs(me)).rejects.toBeInstanceOf(GmailShapeError);
  });

  it("a + address is percent-encoded; an invalid address makes no request", async () => {
    const { gmail, seen } = client([{ status: 200, body: { sendAsEmail: "a+b@example.com" } }]);
    await gmail.getSendAs("a+b@example.com");
    expect(seen[0]!.url.href).toBe(`${BASE}/settings/sendAs/a%2Bb%40example.com`);
    // "/" and "%" are valid in a local part; they are percent-encoded, so the path stays one segment.
    const slash = client([{ status: 200, body: { sendAsEmail: "a/b%c@example.com" } }]);
    await slash.gmail.getSendAs("a/b%c@example.com");
    expect(slash.seen[0]!.url.pathname).toBe("/gmail/v1/users/me/settings/sendAs/a%2Fb%25c%40example.com");
    for (const bad of ["", "no-at", "../x@example.com", "a@b", "a b@example.com", "a@example.com/../../profile", "a@exa?mple.com"]) {
      const c = client([]);
      await expect(c.gmail.getSendAs(bad), bad).rejects.toBeInstanceOf(GmailShapeError);
      expect(c.seen, bad).toEqual([]);
    }
  });
});
