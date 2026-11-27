import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup-env";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { ConnectedAccount } from "@/db/schema";
import { deleteAccount, ReauthRequiredError } from "@/lib/accounts";
import { GmailApiError, type SendAsResult } from "@/lib/gmail/client";
import { syncAccount, syncAfterConnect, syncAfterPush, type SyncDeps } from "@/lib/gmail/sync";
import { needsFirstSignatureRead, storeSignatureRead } from "@/lib/signatures/refresh";
import { FakeGmail, type FakeMessage } from "./mail-fixtures";
import { makeGoogleAccount, makeUser, openTestDb, testDbUrl } from "./test-db";

// Tester round 3, phase email-signatures, owner Round 4 (R-1 option A): an account never read
// successfully reads its signature first in cron and connect runs; otherwise after ingestion.
// Constructed data only (example.com / example.org).

const state = vi.hoisted(() => ({ db: null as unknown, user: null as { id: string; email: string; name: string | null; timeZone: string | null } | null }));
vi.mock("@/db", async (orig) => ({ ...(await orig<object>()), db: () => state.db }));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user, currentUser: async () => state.user }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (u: string) => {
    throw new Error(`REDIRECT ${u}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const DAY = 86_400_000;
const SIG_HTML = '<div>Jane Doe</div><a href="https://example.com/book">Book</a>';
const SIG = "Jane Doe\nBook <https://example.com/book>";

describe.skipIf(!testDbUrl)("tester round 3: first signature read (Postgres)", () => {
  let client: Awaited<ReturnType<typeof openTestDb>>["client"];
  let database: Database;
  let userId: string;
  let account: ConnectedAccount;
  let gmail: FakeGmail;
  let clock: number;
  let msPerCall: number;

  beforeAll(async () => {
    ({ client, database } = await openTestDb());
    state.db = database;
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await database.delete(schema.users);
    const u = await makeUser(database);
    userId = u.id;
    state.user = { id: u.id, email: u.email, name: null, timeZone: null };
    account = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    gmail = new FakeGmail();
    gmail.sendAs = { kind: "found", signature: SIG_HTML };
    clock = Date.now();
    msPerCall = 0;
  });

  /** A client that charges msPerCall of fake time per Gmail call (like tester-mail-sync). */
  const timed = (g: FakeGmail) =>
    new Proxy(g, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== "function" || prop === "seed" || prop === "deliver" || prop === "count" || prop === "failNext") return v;
        return async (...args: unknown[]) => {
          clock += msPerCall;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  const deps = (over: Partial<SyncDeps> = {}): SyncDeps => ({
    db: database,
    gmailFor: () => timed(gmail),
    now: () => new Date(clock),
    sleep: async () => {},
    unitsPerMinute: 1e9,
    render: async (body, opts) => ({
      renderKind: body.html ? "text" : "none",
      renderReason: body.html ? "worker_unavailable" : null,
      renderedHtml: null,
      renderedHtmlRemote: null,
      renderedText: body.text,
      renderTruncated: false,
      sanitizerVersion: body.html ? null : opts.version,
      renderedAt: new Date(clock),
    }),
    ...over,
  });
  const reload = async (id = account.id) => (await database.select().from(schema.connectedAccounts).where(eq(schema.connectedAccounts.id, id)))[0]!;
  const row = async (id = account.id) => (await database.select().from(schema.accountSignatures).where(eq(schema.accountSignatures.accountId, id)))[0];
  const ops = () => gmail.calls.map((c) => c.op);
  const cron = async (over: Partial<SyncDeps> = {}, id = account.id) => {
    clock += 5 * 60_000;
    return syncAccount(deps(over), await reload(id), "cron");
  };
  const seedInbox = (n: number) => {
    for (let i = 0; i < n; i++) gmail.seed({ id: `m${i}`, threadId: `t${i}`, labelIds: ["INBOX"], internalDate: clock - (i + 1) * 3600_000, from: "Alice <alice@example.org>", subject: `S${i}` } as FakeMessage);
  };

  it("never read: the first Gmail call of a cron and of a connect run is getSendAs, exactly once; later runs read after ingestion", async () => {
    seedInbox(3);
    expect(await needsFirstSignatureRead(database, account.id)).toBe(true);
    await syncAfterConnect(deps(), account.id);
    expect(ops()[0]).toBe("getSendAs");
    expect(gmail.count("getSendAs")).toBe(1);
    expect(await row()).toMatchObject({ state: "set", signatureText: SIG });
    expect(await needsFirstSignatureRead(database, account.id)).toBe(false);

    gmail.calls = [];
    expect((await cron()).outcome).toBe("ok");
    expect(gmail.count("getSendAs")).toBe(1);
    expect(ops()[0]).not.toBe("getSendAs");
    expect(ops()[ops().length - 1]).toBe("getSendAs");
  });

  it("push runs never read, even for a never-read account", async () => {
    seedInbox(2);
    // Give the account a history cursor without a signature row: run connect with the read failing, then delete the row.
    await syncAfterConnect(deps(), account.id);
    await database.delete(schema.accountSignatures);
    gmail.calls = [];
    gmail.deliver({ id: "new1", threadId: "tn", labelIds: ["INBOX"], internalDate: clock, from: "Bob <bob@example.org>", subject: "New" } as FakeMessage);
    const r = await syncAfterPush(deps(), account.id);
    expect(r?.outcome).toBe("ok");
    expect(gmail.calls.length).toBeGreaterThan(0);
    expect(gmail.count("getSendAs")).toBe(0);
    expect(await row()).toBeUndefined();
  });

  it("a failed first read is retried first on the next run; a row with only an error still counts as never read; one call per run on every path", async () => {
    seedInbox(2);
    gmail.failNext("getSendAs", 500, "backendError");
    expect((await cron()).outcome).toBe("ok");
    expect(await row()).toMatchObject({ state: null, lastErrorCode: "http_500:backendError" });
    expect(await needsFirstSignatureRead(database, account.id)).toBe(true);
    expect(gmail.count("getSendAs")).toBe(1);

    // Next run: first read fails again AND ingestion fails: still exactly one read (not repeated on the error path).
    gmail.calls = [];
    gmail.failNext("getSendAs", 503, "backendError");
    gmail.failNext("getProfile", 500, "backendError");
    gmail.failNext("listHistory", 500, "backendError");
    const r = await cron();
    expect(gmail.count("getSendAs")).toBe(1);
    expect(ops()[0]).toBe("getSendAs");
    void r;

    // Then a success, first again.
    gmail.calls = [];
    expect((await cron()).outcome).toBe("ok");
    expect(ops()[0]).toBe("getSendAs");
    expect(gmail.count("getSendAs")).toBe(1);
    expect(await row()).toMatchObject({ state: "set", lastErrorCode: null });

    // Non-null states other than set are "read": none, not_found, too_large never read first.
    for (const sendAs of [{ kind: "found", signature: null }, { kind: "not_found" }] as SendAsResult[]) {
      gmail.sendAs = sendAs;
      await cron();
      gmail.calls = [];
      await cron();
      expect(ops()[0]).not.toBe("getSendAs");
      expect(gmail.count("getSendAs")).toBe(1);
    }
  });

  it("an ingestion failure after a successful first read doesn't read again on the error path", async () => {
    seedInbox(2);
    gmail.failNext("getProfile", 500, "backendError");
    const r = await cron();
    expect(r.outcome).toBe("error");
    expect(gmail.count("getSendAs")).toBe(1);
    expect(ops()[0]).toBe("getSendAs");
    expect((await row())?.state).toBe("set");
  });

  it("the first-read check failing (table missing, as before migration 0006) never blocks ingestion", async () => {
    seedInbox(3);
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
    await database.execute(sql.raw("alter table account_signatures rename to account_signatures_hidden"));
    try {
      expect(await needsFirstSignatureRead(database, account.id)).toBe(false);
      const r = await syncAfterConnect(deps(), account.id);
      expect(r?.outcome).toBe("ok");
      const stored = await database.select({ id: schema.mailMessages.gmailMessageId }).from(schema.mailMessages).where(eq(schema.mailMessages.accountId, account.id));
      expect(stored.map((s) => s.id).sort()).toEqual(["m0", "m1", "m2"]);
      // The read still happens once (after ingestion); its store fails and is logged content-free.
      expect(gmail.count("getSendAs")).toBe(1);
      expect(ops()[0]).not.toBe("getSendAs");
      expect(JSON.stringify(errors)).toContain("signature store failed");
      expect(JSON.stringify(errors)).not.toContain("Jane");
    } finally {
      await database.execute(sql.raw("alter table account_signatures_hidden rename to account_signatures"));
      spy.mockRestore();
    }
  });

  it("lease: a run that finds the lease busy makes no read; the first read runs inside the lease", async () => {
    seedInbox(1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inRead = new Promise<void>((r) => (entered = r));
    const orig = gmail.getSendAs;
    gmail.getSendAs = async (addr: string) => {
      entered();
      await gate;
      return orig(addr);
    };
    const first = (async () => {
      clock += 5 * 60_000;
      return syncAccount(deps(), await reload(), "cron");
    })();
    await inRead;
    const lease = (await database.select().from(schema.mailSyncState).where(eq(schema.mailSyncState.accountId, account.id)))[0]!;
    expect(lease.leaseOwner).not.toBeNull();
    const second = await syncAccount(deps(), await reload(), "connect");
    expect(second.outcome).toBe("busy");
    release();
    expect((await first).outcome).toBe("ok");
    expect(gmail.calls.filter((c) => c.op === "getSendAs")).toHaveLength(1);
  });

  it("budget: the first read leaves the rest of the budget to ingestion; a first read skipped for budget isn't retried after ingestion", async () => {
    seedInbox(2);
    msPerCall = 50_000; // the first read costs one 50 s call
    expect((await cron({ budgetMs: 240_000 })).outcome).toBe("ok");
    expect(ops()[0]).toBe("getSendAs");
    expect(gmail.count("getSendAs")).toBe(1);

    // A never-read account with under 30 s at the start: skipped, nothing written, and not tried again later in the run.
    const other = await makeGoogleAccount(database, userId, { email: "home@example.com" });
    msPerCall = 0;
    gmail.calls = [];
    expect((await cron({ budgetMs: 29_999 }, other.id)).outcome).toBe("ok");
    expect(gmail.count("getSendAs")).toBe(0);
    expect(await row(other.id)).toBeUndefined();
  });

  it("ReauthRequiredError from the first read takes the reconnect skip path before any ingestion call", async () => {
    gmail.getSendAs = async () => {
      gmail.calls.push({ op: "getSendAs", args: [] });
      throw new ReauthRequiredError(account.id, "test");
    };
    const r = await cron();
    expect(r).toMatchObject({ outcome: "skipped_reauth", stage: "signature" });
    expect(ops()).toEqual(["getSendAs"]);
  });

  it("reconnect after Disconnect is a never-read account again", async () => {
    seedInbox(1);
    await syncAfterConnect(deps(), account.id);
    expect((await row())?.state).toBe("set");
    await deleteAccount(database, userId, account.id, { attempts: 1 });
    const again = await makeGoogleAccount(database, userId, { email: "work@example.com", label: "business" });
    expect(await needsFirstSignatureRead(database, again.id)).toBe(true);
    gmail.calls = [];
    await syncAfterConnect(deps(), again.id);
    expect(ops()[0]).toBe("getSendAs");
    expect((await row(again.id))?.state).toBe("set");
  });

  it("R-6: the Accounts page's 'checked' time is the last successful read, not a later failed attempt", async () => {
    const t1 = new Date(Date.UTC(2026, 10, 20, 9, 0));
    const t2 = new Date(Date.UTC(2026, 10, 26, 17, 30));
    await storeSignatureRead(database, account, { ok: true, state: "set", text: SIG }, t1);
    await storeSignatureRead(database, account, { ok: false, code: "http_500" }, t2);
    type Page<P> = { default: (props: P) => Promise<ReactNode> };
    const { default: AccountsPage } = (await import("@/app/(app)/page")) as Page<{ searchParams: Promise<Record<string, string>> }>;
    const html = renderToStaticMarkup((await AccountsPage({ searchParams: Promise.resolve({}) })) as never);
    const checked = html.slice(html.indexOf("Signature: from Gmail, checked"));
    expect(checked.length).toBeGreaterThan(0);
    const firstTime = /dateTime="([^"]+)"/.exec(checked)?.[1];
    expect(firstTime).toBe(t1.toISOString());
    expect(html).not.toContain(`dateTime="${t2.toISOString()}"`);
    expect(html).toContain("Couldn&#x27;t read it at the last check");
  });
});
void DAY;
void GmailApiError;
