import { describe, expect, it } from "vitest";
import "./setup-env";
import type { Executor } from "@/db";
import { handlePush, parsePushBody } from "@/lib/gmail/push";
import {
  classifyForIngest,
  decideHistoryAction,
  describeError,
  maxHistoryId,
  pacedClient,
  QUOTA_UNITS,
} from "@/lib/gmail/sync";
import { GmailApiError } from "@/lib/gmail/client";
import { FakeGmail } from "./mail-fixtures";

const S = (stored: boolean, knownThread: boolean) => ({ stored, knownThread });

describe("decideHistoryAction (plan 6.5.2)", () => {
  describe("messagesAdded", () => {
    it("ignores a message already stored", () => {
      expect(decideHistoryAction({ type: "messageAdded", labelIds: ["INBOX"] }, S(true, true))).toEqual({ kind: "ignore" });
      expect(decideHistoryAction({ type: "messageAdded" }, S(true, false))).toEqual({ kind: "ignore" });
    });
    it("labels absent (or empty): enqueue with needs_classify", () => {
      expect(decideHistoryAction({ type: "messageAdded" }, S(false, false))).toEqual({ kind: "enqueue", needsClassify: true });
      expect(decideHistoryAction({ type: "messageAdded", labelIds: [] }, S(false, true))).toEqual({ kind: "enqueue", needsClassify: true });
    });
    it("labels present: DRAFT, SPAM, TRASH are dropped even with INBOX or SENT", () => {
      for (const bad of ["DRAFT", "SPAM", "TRASH"]) {
        expect(decideHistoryAction({ type: "messageAdded", labelIds: [bad, "INBOX"] }, S(false, true))).toEqual({ kind: "drop" });
        expect(decideHistoryAction({ type: "messageAdded", labelIds: [bad, "SENT"] }, S(false, true))).toEqual({ kind: "drop" });
      }
    });
    it("labels present: INBOX enqueues without classify", () => {
      expect(decideHistoryAction({ type: "messageAdded", labelIds: ["INBOX", "UNREAD"] }, S(false, false))).toEqual({ kind: "enqueue", needsClassify: false });
    });
    it("labels present: SENT enqueues only for a known thread", () => {
      expect(decideHistoryAction({ type: "messageAdded", labelIds: ["SENT"] }, S(false, true))).toEqual({ kind: "enqueue", needsClassify: false });
      expect(decideHistoryAction({ type: "messageAdded", labelIds: ["SENT"] }, S(false, false))).toEqual({ kind: "drop" });
    });
    it("labels present: anything else is dropped", () => {
      expect(decideHistoryAction({ type: "messageAdded", labelIds: ["CATEGORY_PROMOTIONS"] }, S(false, true))).toEqual({ kind: "drop" });
    });
  });

  it("messagesDeleted: delete the stored message, or the queue row", () => {
    expect(decideHistoryAction({ type: "messageDeleted" }, S(true, false))).toEqual({ kind: "delete_message" });
    expect(decideHistoryAction({ type: "messageDeleted" }, S(false, true))).toEqual({ kind: "delete_queue" });
  });

  describe("labelsAdded", () => {
    it("stored: add the labels", () => {
      expect(decideHistoryAction({ type: "labelsAdded", labelIds: ["UNREAD"] }, S(true, true))).toEqual({ kind: "add_labels" });
    });
    it("not stored: INBOX added enqueues (unarchive or filter)", () => {
      expect(decideHistoryAction({ type: "labelsAdded", labelIds: ["INBOX"] }, S(false, false))).toEqual({ kind: "enqueue", needsClassify: false });
    });
    it("not stored: SENT added enqueues only for a known thread", () => {
      expect(decideHistoryAction({ type: "labelsAdded", labelIds: ["SENT"] }, S(false, true))).toEqual({ kind: "enqueue", needsClassify: false });
      expect(decideHistoryAction({ type: "labelsAdded", labelIds: ["SENT"] }, S(false, false))).toEqual({ kind: "ignore" });
    });
    it("not stored: other labels are ignored", () => {
      expect(decideHistoryAction({ type: "labelsAdded", labelIds: ["STARRED"] }, S(false, true))).toEqual({ kind: "ignore" });
    });
  });

  it("labelsRemoved: apply if stored, otherwise ignore", () => {
    expect(decideHistoryAction({ type: "labelsRemoved", labelIds: ["INBOX"] }, S(true, false))).toEqual({ kind: "remove_labels" });
    expect(decideHistoryAction({ type: "labelsRemoved", labelIds: ["INBOX"] }, S(false, true))).toEqual({ kind: "ignore" });
  });
});

describe("classifyForIngest (plan 6.6)", () => {
  const t = (stored: boolean, inboxQueued: boolean) => ({ stored, inboxQueued });
  it("never ingests drafts, spam or trash", () => {
    expect(classifyForIngest(["DRAFT"], t(true, false))).toBe("drop");
    expect(classifyForIngest(["INBOX", "SPAM"], t(true, false))).toBe("drop");
    expect(classifyForIngest(["SENT", "TRASH"], t(true, false))).toBe("drop");
  });
  it("INBOX mail is ingested and may create the thread", () => {
    expect(classifyForIngest(["INBOX", "UNREAD"], t(false, false))).toBe("inbox");
  });
  it("sent mail needs a stored thread, waits while the inbox message is queued, otherwise drops", () => {
    expect(classifyForIngest(["SENT"], t(true, false))).toBe("sent");
    expect(classifyForIngest(["SENT"], t(false, true))).toBe("defer");
    expect(classifyForIngest(["SENT"], t(false, false))).toBe("drop");
  });
  it("other mail (archived, filtered) is dropped", () => {
    expect(classifyForIngest(["CATEGORY_UPDATES"], t(true, false))).toBe("drop");
    expect(classifyForIngest([], t(true, false))).toBe("drop");
  });
});

describe("helpers", () => {
  it("maxHistoryId compares uint64 strings numerically", () => {
    expect(maxHistoryId(null, "5")).toBe("5");
    expect(maxHistoryId("9", "10")).toBe("10");
    expect(maxHistoryId("18446744073709551615", "18446744073709551614")).toBe("18446744073709551615");
  });

  it("describeError is content-free", () => {
    expect(describeError(new GmailApiError(500, "backendError", "history.list"))).toEqual({ status: 500, reason: "backendError" });
    expect(describeError(new Error("duplicate key value (subject)=(Secret subject)"))).toEqual({ status: null, reason: "Error" });
  });

  it("pacedClient sleeps once the unit budget is exceeded", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const gmail = new FakeGmail();
    gmail.seed({ id: "m", threadId: "t", labelIds: ["INBOX"], internalDate: 1 });
    const paced = pacedClient(gmail, {
      unitsPerMinute: 600,
      burstUnits: 120,
      now: () => new Date(now),
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await paced.getMessageFull("m"); // 60
    await paced.getMessageFull("m"); // 120: still within burst
    expect(sleeps).toEqual([]);
    await paced.getMessageFull("m"); // 180 > 120: wait 60 units at 600/min = 6 s
    expect(sleeps).toHaveLength(1);
    expect(Math.round(sleeps[0]!)).toBe(6000);
    expect(gmail.count("getMessageFull")).toBe(3);
  });

  it("quota costs match the Gmail quota table used in the plan", () => {
    expect(QUOTA_UNITS).toEqual({
      getProfile: 1,
      watch: 100,
      stop: 50,
      listHistory: 2,
      listMessages: 5,
      getMessageMinimal: 20,
      getMessageFull: 60,
      getBodyPartData: 20,
      getSendAs: 1,
    });
  });
});

describe("parsePushBody", () => {
  const wrap = (inner: unknown, enc: BufferEncoding = "base64url") =>
    JSON.stringify({ message: { data: Buffer.from(JSON.stringify(inner)).toString(enc), messageId: "1", publishTime: "2026-11-18T00:00:00Z" }, subscription: "projects/p/subscriptions/s" });

  it("decodes Gmail's {emailAddress, historyId} in base64url or base64", () => {
    expect(parsePushBody(wrap({ emailAddress: "a@example.com", historyId: 12345 }))).toEqual({ emailAddress: "a@example.com", historyId: "12345" });
    expect(parsePushBody(wrap({ emailAddress: "a@example.com", historyId: "999" }, "base64"))).toEqual({ emailAddress: "a@example.com", historyId: "999" });
  });

  it("returns null for anything malformed", () => {
    expect(parsePushBody("not json")).toBeNull();
    expect(parsePushBody(JSON.stringify({}))).toBeNull();
    expect(parsePushBody(JSON.stringify({ message: { data: "" } }))).toBeNull();
    expect(parsePushBody(JSON.stringify({ message: { data: "!!!" } }))).toBeNull();
    expect(parsePushBody(wrap({ emailAddress: "a@example.com" }))).toBeNull();
    expect(parsePushBody(wrap({ emailAddress: "a@example.com", historyId: "12; drop" }))).toBeNull();
    expect(parsePushBody(wrap({ historyId: 1 }))).toBeNull();
  });
});

describe("handlePush without a database", () => {
  // Any DB access in these paths is a bug: the proxy throws.
  const noDb = new Proxy({}, { get: () => { throw new Error("database must not be touched"); } }) as unknown as Executor;
  const body = JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress: "a@example.com", historyId: 1 })).toString("base64url") } });
  const cfg = { audience: "https://alex.example.com/api/gmail/push", serviceAccount: "push@test-project.iam.gserviceaccount.com" };

  it("503 when push auth isn't configured, without verifying", async () => {
    let verified = false;
    const deps = { db: noDb, verify: async () => ((verified = true), { ok: true as const }), schedule: () => { throw new Error("no"); } };
    expect(await handlePush({ authorization: "Bearer x", body }, { audience: undefined, serviceAccount: cfg.serviceAccount }, deps)).toBe(503);
    expect(await handlePush({ authorization: "Bearer x", body }, { audience: cfg.audience, serviceAccount: undefined }, deps)).toBe(503);
    expect(verified).toBe(false);
  });

  it("401 when verification fails, with no DB work and nothing scheduled", async () => {
    const deps = { db: noDb, verify: async () => ({ ok: false as const, reason: "x" }), schedule: () => { throw new Error("no"); } };
    expect(await handlePush({ authorization: null, body }, cfg, deps)).toBe(401);
  });

  it("204 for a malformed body after verification, with no DB work", async () => {
    const deps = { db: noDb, verify: async () => ({ ok: true as const }), schedule: () => { throw new Error("no"); } };
    expect(await handlePush({ authorization: "Bearer x", body: "garbage" }, cfg, deps)).toBe(204);
  });
});
