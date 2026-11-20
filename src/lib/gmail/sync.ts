import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { auditLog, connectedAccounts, mailFetchQueue, mailMessages, type ConnectedAccount, type MailFetchQueueRow, type MailSyncState } from "@/db/schema";
import { ReauthRequiredError } from "@/lib/accounts";
import { audit } from "@/lib/audit";
import { RENDER_LIMIT_MS, renderEmailBody } from "@/lib/email/render";
import type { RenderFields } from "@/lib/email/types";
import { SANITIZER_VERSION } from "@/lib/email/version";
import { runTriageStage } from "@/lib/ai/triage";
import type { TriageProvider } from "@/lib/ai/types";
import { describeError } from "./errors";
import { REAUTH_MARK } from "./marks";
import { GmailApiError, GmailShapeError, type GmailClient, type HistoryRecord } from "./client";
import { applyFetchedBody, isBodyPart, parseMessage } from "./mime";
import {
  acquireLease,
  countPendingQueue,
  deferQueueRow,
  deleteQueueRow,
  deleteQueueRowForMessage,
  deleteStoredMessage,
  dropQueueRow,
  dueQueueRows,
  enqueueLabelRefresh,
  enqueueMessages,
  ensureSyncState,
  failQueueRow,
  getSyncState,
  isMessageStored,
  knownThreadIds,
  releaseLease,
  storedMessageIds,
  storeMessage,
  threadRowId,
  updateSyncState,
  changeLabels,
  countMessagesNeedingRender,
  inboxBoundQueueRow,
  messagesNeedingRender,
  updateMessageRender,
  PARKED_AT,
  type EnqueueRow,
  type FetchSource,
} from "./store";

// Re-exported for existing importers.
export { describeError } from "./errors";
export { STOP_OVERALL_TIMEOUT_MS, stopWatchBeforeDisconnect } from "./watch-stop";

/**
 * Mail ingestion engine (plan section 6). One-way: Gmail -> Alex. The only Gmail writes are
 * users.watch and users.stop (notification config). Every run is idempotent and lease-protected,
 * because Vercel Cron may deliver twice and pushes can overlap.
 */

// ---- Tunables ---------------------------------------------------------------------------------

export const BACKFILL_DAYS = 30;
/** Stop starting new work after this long; routes run with maxDuration = 300 s. */
export const DEFAULT_BUDGET_MS = 240_000;
/** Gmail allows 6,000 units per user per minute; stay below it per account. */
export const DEFAULT_UNITS_PER_MINUTE = 4_800;
export const WATCH_RENEW_WITHIN_MS = 24 * 60 * 60_000;
export const DEFER_DELAY_MS = 60_000;
/**
 * Most deferrals a sent message may spend waiting for a queued inbox sibling before its waits
 * start using up attempts. Counted in deferrals actually processed (at most one per
 * DEFER_DELAY_MS, and only while the account syncs), so time an account can't sync, for example
 * a reauth outage, doesn't count. 1,440 deferrals is at least 24 h of continuous hydration; a busy
 * 30-day backfill takes about an hour (plan 6.6).
 */
export const MAX_DEFERRALS = 1_440;
export const MAX_ATTEMPTS = 5;
/**
 * Transient (429/5xx) failures after which one queue row is parked. With 30 s doubling backoff
 * capped at 1 h, that's roughly a day of retries: short outages recover, a message Gmail never
 * serves stops blocking the backfill and stops producing hourly sync_error audits.
 */
export const MAX_TRANSIENT_ATTEMPTS = 24;
/**
 * Lowercase, as in Gmail's discovery document (WatchRequest.labelFilterBehavior enum: "include",
 * "exclude"). Owner decision of 2026-11-18, superseding the push guide's "INCLUDE". Whether the
 * live API accepts it is unverified: a rejected watch is audited as mail.watch_failed and
 * ingestion continues on polling.
 */
export const WATCH_LABEL_FILTER_BEHAVIOR = "include";
export const WATCH_FAILURE_AUDIT_HOURS = 6;
export { REAUTH_MARK };

/** Gmail quota units per method (Gmail API quota reference). */
export const QUOTA_UNITS = {
  getProfile: 1,
  watch: 100,
  stop: 50,
  listHistory: 2,
  listMessages: 5,
  getMessageMinimal: 20,
  getMessageFull: 60,
  getBodyPartData: 20,
} as const satisfies Record<keyof GmailClient, number>;

const DAY_MS = 24 * 60 * 60_000;

// ---- Dependencies -----------------------------------------------------------------------------

export type SyncDeps = {
  db: Executor;
  gmailFor: (account: ConnectedAccount) => GmailClient;
  /** Pub/Sub topic for users.watch; undefined means polling only. */
  topic?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
  unitsPerMinute?: number;
  /** Ingest-time body renderer (Revision 4); defaults to renderEmailBody with the process-wide worker pool. */
  render?: (body: { html: string | null; text: string | null }, opts: { version: number }) => Promise<RenderFields>;
  /** Current sanitizer version; defaults to SANITIZER_VERSION (tests raise it to exercise re-rendering). */
  sanitizerVersion?: number;
  /** Phase 2c: AI triage after hydrate on cron and push runs. Omitted means triage is off. */
  triage?: { provider: TriageProvider };
};

export type RunMode = "cron" | "push" | "connect";

export type AccountRunResult = {
  accountId: string;
  outcome: "ok" | "busy" | "skipped_reauth" | "skipped_not_ready" | "error";
  stage?: string;
  /** Messages rendered in this run, by "kind" or "kind:reason" (content-free; logged by the cron for the SETUP §6.8 check). */
  renders?: Record<string, number>;
};

type Ctx = {
  db: Executor;
  account: ConnectedAccount;
  gmail: GmailClient;
  topic?: string;
  now: () => Date;
  outOfTime: () => boolean;
  /** Milliseconds left in this run's budget. */
  remainingMs: () => number;
  render: (body: { html: string | null; text: string | null }) => Promise<RenderFields>;
  sanitizerVersion: number;
};

// ---- Pure decisions (plan 6.5.2 and 6.6) ------------------------------------------------------

const NEVER_INGEST = ["DRAFT", "SPAM", "TRASH"];

export type HistoryEvent =
  | { type: "messageAdded"; labelIds?: string[] }
  | { type: "messageDeleted" }
  | { type: "labelsAdded"; labelIds: string[] }
  | { type: "labelsRemoved"; labelIds: string[] };

export type HistoryAction =
  | { kind: "ignore" }
  | { kind: "drop" }
  | { kind: "enqueue"; needsClassify: boolean }
  | { kind: "add_labels" }
  | { kind: "remove_labels" }
  | { kind: "delete_message" }
  | { kind: "delete_queue" };

/** The 6.5.2 decision table. `stored`: Alex has the message; `knownThread`: plan 6.5.1. */
export function decideHistoryAction(event: HistoryEvent, ctx: { stored: boolean; knownThread: boolean }): HistoryAction {
  switch (event.type) {
    case "messageAdded": {
      if (ctx.stored) return { kind: "ignore" };
      const labels = event.labelIds;
      // History messages "typically only have id and threadId": absent (or empty) labels mean unknown.
      if (!labels || labels.length === 0) return { kind: "enqueue", needsClassify: true };
      if (labels.some((l) => NEVER_INGEST.includes(l))) return { kind: "drop" };
      if (labels.includes("INBOX")) return { kind: "enqueue", needsClassify: false };
      if (labels.includes("SENT") && ctx.knownThread) return { kind: "enqueue", needsClassify: false };
      return { kind: "drop" };
    }
    case "messageDeleted":
      return ctx.stored ? { kind: "delete_message" } : { kind: "delete_queue" };
    case "labelsAdded":
      if (ctx.stored) return { kind: "add_labels" };
      if (event.labelIds.includes("INBOX")) return { kind: "enqueue", needsClassify: false };
      if (event.labelIds.includes("SENT") && ctx.knownThread) return { kind: "enqueue", needsClassify: false };
      return { kind: "ignore" };
    case "labelsRemoved":
      return ctx.stored ? { kind: "remove_labels" } : { kind: "ignore" };
  }
}

export type IngestDecision = "drop" | "inbox" | "sent" | "defer" | "outbound";

/**
 * Whether a not-yet-stored message with these (current) labels is ingested. Sent mail needs a
 * stored thread; if the thread's inbox message is still queued, the sent message waits. The
 * exception (Phase 2d, plan §6.4) is an `outbound` row, the SENT copy of a new message Alex sent:
 * it is stored and creates its thread.
 */
export function classifyForIngest(
  labels: string[],
  thread: { stored: boolean; inboxQueued: boolean },
  source?: FetchSource,
): IngestDecision {
  if (labels.some((l) => NEVER_INGEST.includes(l))) return "drop";
  if (labels.includes("INBOX")) return "inbox";
  if (labels.includes("SENT")) {
    if (thread.stored) return "sent";
    if (source === "outbound") return "outbound";
    if (thread.inboxQueued) return "defer";
  }
  return "drop";
}

/** Larger of two Gmail historyIds (uint64 strings). */
export function maxHistoryId(a: string | null, b: string): string {
  if (a === null) return b;
  return BigInt(b) > BigInt(a) ? b : a;
}


// ---- Pacing -----------------------------------------------------------------------------------

/** Wraps a client so each call first spends its quota cost against a per-minute rate. */
export function pacedClient(
  gmail: GmailClient,
  opts: { unitsPerMinute: number; now: () => Date; sleep: (ms: number) => Promise<void>; burstUnits?: number },
): GmailClient {
  const start = opts.now().getTime();
  const burst = opts.burstUnits ?? 600;
  let spent = 0;
  const spend = async (units: number) => {
    spent += units;
    const elapsed = opts.now().getTime() - start;
    const allowed = burst + (opts.unitsPerMinute * elapsed) / 60_000;
    if (spent > allowed) await opts.sleep(((spent - allowed) / opts.unitsPerMinute) * 60_000);
  };
  const wrapped = {} as Record<string, unknown>;
  for (const key of Object.keys(QUOTA_UNITS) as (keyof GmailClient)[]) {
    const fn = gmail[key] as (...args: unknown[]) => Promise<unknown>;
    wrapped[key] = async (...args: unknown[]) => {
      await spend(QUOTA_UNITS[key]);
      return fn.apply(gmail, args);
    };
  }
  return wrapped as unknown as GmailClient;
}

// ---- Setup and watch --------------------------------------------------------------------------

async function registerWatch(ctx: Ctx, kind: "registered" | "renewed"): Promise<void> {
  const { account } = ctx;
  if (!ctx.topic) {
    if (kind === "registered") {
      await audit(
        { userId: account.userId, accountId: account.id, action: "mail.watch_failed", detail: { reason: "topic_not_configured" } },
        ctx.db,
      );
    }
    return;
  }
  try {
    const res = await ctx.gmail.watch({
      topicName: ctx.topic,
      labelIds: ["INBOX"],
      labelFilterBehavior: WATCH_LABEL_FILTER_BEHAVIOR,
    });
    const expiresAt = new Date(Number(res.expiration));
    await updateSyncState(ctx.db, account.id, {
      watchExpiresAt: Number.isFinite(expiresAt.getTime()) ? expiresAt : null,
      watchRenewedAt: ctx.now(),
      watchTopic: ctx.topic,
    });
    await audit(
      {
        userId: account.userId,
        accountId: account.id,
        action: kind === "registered" ? "mail.watch_registered" : "mail.watch_renewed",
        detail: { expiresAt: Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : null },
      },
      ctx.db,
    );
  } catch (err) {
    if (err instanceof ReauthRequiredError) throw err;
    const { status, reason } = describeError(err);
    // A persistent failure is retried on every 5-minute run; audit it at most every 6 hours.
    const recent = await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.accountId, account.id),
          eq(auditLog.action, "mail.watch_failed"),
          sql`${auditLog.createdAt} > now() - make_interval(hours => ${WATCH_FAILURE_AUDIT_HOURS})`,
        ),
      )
      .limit(1);
    if (recent.length === 0) {
      await audit(
        { userId: account.userId, accountId: account.id, action: "mail.watch_failed", detail: { status, reason } },
        ctx.db,
      );
    }
    console.error("gmail watch failed", { accountId: account.id, status, reason });
  }
}

/**
 * Setup (plan 6.3): cursor from getProfile before any listing, then watch, then start the backfill.
 * Idempotent: on reconnect only the watch is re-registered.
 */
async function setup(ctx: Ctx, state: MailSyncState, mode: RunMode): Promise<MailSyncState> {
  const { account } = ctx;
  const isNew = state.backfillStatus === "pending";
  if (!state.historyId) {
    const profile = await ctx.gmail.getProfile();
    await updateSyncState(ctx.db, account.id, { historyId: profile.historyId });
  }
  if (isNew || mode === "connect") {
    await registerWatch(ctx, "registered");
  } else if (
    mode === "cron" &&
    ctx.topic &&
    (!state.watchExpiresAt || state.watchExpiresAt.getTime() - ctx.now().getTime() < WATCH_RENEW_WITHIN_MS)
  ) {
    await registerWatch(ctx, "renewed");
  }
  if (isNew) {
    const after = new Date(ctx.now().getTime() - BACKFILL_DAYS * DAY_MS);
    await updateSyncState(ctx.db, account.id, {
      backfillStatus: "listing_inbox",
      backfillAfter: after,
      backfillPageToken: null,
      backfillListed: 0,
      backfillStartedAt: ctx.now(),
    });
    await audit(
      { userId: account.userId, accountId: account.id, action: "mail.backfill_started", detail: { after: after.toISOString() } },
      ctx.db,
    );
  }
  return (await getSyncState(ctx.db, account.id))!;
}

// ---- History reconciliation (plan 6.5) --------------------------------------------------------

type PageSets = { stored: Set<string>; known: Set<string> };

async function applyHistoryRecord(ctx: Ctx, rec: HistoryRecord, sets: PageSets): Promise<void> {
  const { account } = ctx;
  const events: { event: HistoryEvent; id: string; threadId: string | null }[] = [];
  for (const a of rec.messagesAdded ?? [])
    events.push({ event: { type: "messageAdded", labelIds: a.message.labelIds }, id: a.message.id, threadId: a.message.threadId ?? null });
  for (const a of rec.labelsAdded ?? [])
    events.push({ event: { type: "labelsAdded", labelIds: a.labelIds ?? [] }, id: a.message.id, threadId: a.message.threadId ?? null });
  for (const a of rec.labelsRemoved ?? [])
    events.push({ event: { type: "labelsRemoved", labelIds: a.labelIds ?? [] }, id: a.message.id, threadId: a.message.threadId ?? null });
  for (const a of rec.messagesDeleted ?? [])
    events.push({ event: { type: "messageDeleted" }, id: a.message.id, threadId: a.message.threadId ?? null });

  for (const { event, id, threadId } of events) {
    const action = decideHistoryAction(event, {
      stored: sets.stored.has(id),
      knownThread: threadId !== null && sets.known.has(threadId),
    });
    switch (action.kind) {
      case "enqueue": {
        const row: EnqueueRow = { gmailMessageId: id, gmailThreadId: threadId, source: "history", needsClassify: action.needsClassify };
        await enqueueMessages(ctx.db, account, [row]);
        if (threadId) sets.known.add(threadId); // a history-sourced queue row makes the thread known (6.5.1)
        break;
      }
      case "add_labels":
        await changeLabels(ctx.db, account.id, id, { add: (event as { labelIds: string[] }).labelIds });
        break;
      case "remove_labels":
        await changeLabels(ctx.db, account.id, id, { remove: (event as { labelIds: string[] }).labelIds });
        break;
      case "delete_message":
        await deleteStoredMessage(ctx.db, account.id, id);
        await deleteQueueRowForMessage(ctx.db, account.id, id);
        sets.stored.delete(id);
        break;
      case "delete_queue":
        await deleteQueueRowForMessage(ctx.db, account.id, id);
        break;
      case "ignore":
      case "drop":
        break;
    }
  }
}

function idsInRecords(records: HistoryRecord[]): { messageIds: string[]; threadIds: string[] } {
  const m = new Set<string>();
  const t = new Set<string>();
  for (const r of records) {
    for (const list of [r.messagesAdded, r.messagesDeleted, r.labelsAdded, r.labelsRemoved]) {
      for (const x of list ?? []) {
        m.add(x.message.id);
        if (x.message.threadId) t.add(x.message.threadId);
      }
    }
  }
  return { messageIds: [...m], threadIds: [...t] };
}

async function reconcileHistory(ctx: Ctx, state: MailSyncState): Promise<MailSyncState> {
  if (!state.historyId) return state;
  const cursor = state.historyId;
  let pageToken: string | undefined;
  for (;;) {
    if (ctx.outOfTime()) return state; // cursor unchanged; the next run re-applies (idempotent)
    let page;
    try {
      page = await ctx.gmail.listHistory({ startHistoryId: cursor, pageToken });
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) return startResync(ctx, state);
      throw err;
    }
    const records = page.history ?? [];
    if (records.length > 0) {
      const ids = idsInRecords(records);
      const sets: PageSets = {
        stored: await storedMessageIds(ctx.db, ctx.account.id, ids.messageIds),
        known: await knownThreadIds(ctx.db, ctx.account.id, ids.threadIds),
      };
      for (const rec of records) await applyHistoryRecord(ctx, rec, sets);
    }
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      continue;
    }
    // Every page has been applied: only now may the cursor move (forward only).
    const next = maxHistoryId(cursor, page.historyId);
    await updateSyncState(ctx.db, ctx.account.id, { historyId: next, lastHistorySyncAt: ctx.now() });
    return (await getSyncState(ctx.db, ctx.account.id))!;
  }
}

/** Expired cursor (history.list 404): new cursor, bounded re-list, label refresh of stored mail in the window. */
async function startResync(ctx: Ctx, state: MailSyncState): Promise<MailSyncState> {
  const { account } = ctx;
  const profile = await ctx.gmail.getProfile();
  const now = ctx.now();
  const floor = now.getTime() - BACKFILL_DAYS * DAY_MS;
  let after = state.lastHistorySyncAt ? Math.max(state.lastHistorySyncAt.getTime() - DAY_MS, floor) : floor;
  // A backfill or earlier resync that never finished must still cover its whole window.
  if (state.resyncAfter) after = Math.min(after, state.resyncAfter.getTime());
  else if (state.backfillStatus !== "complete" && state.backfillAfter) after = Math.min(after, state.backfillAfter.getTime());
  const afterDate = new Date(after);

  await ctx.db.transaction(async (tx) => {
    await updateSyncState(tx, account.id, {
      historyId: profile.historyId,
      lastHistorySyncAt: now,
      resyncAfter: afterDate,
      backfillStatus: "listing_inbox",
      backfillPageToken: null,
      backfillListed: 0,
    });
    await enqueueLabelRefresh(tx, account, afterDate);
    await audit(
      { userId: account.userId, accountId: account.id, action: "mail.resync", detail: { reason: "history_expired", after: afterDate.toISOString() } },
      tx,
    );
  });
  return (await getSyncState(ctx.db, account.id))!;
}

// ---- Listing phases (backfill 6.4, resync 6.5) ------------------------------------------------

async function runListing(ctx: Ctx, initial: MailSyncState): Promise<MailSyncState> {
  let state = initial;
  const resync = state.resyncAfter !== null;
  const after = state.resyncAfter ?? state.backfillAfter;
  if (!after) return state;
  const q = `after:${Math.floor(after.getTime() / 1000)}`;
  let restarted = false;

  while (state.backfillStatus === "listing_inbox" || state.backfillStatus === "listing_sent") {
    if (ctx.outOfTime()) return state;
    const phase = state.backfillStatus;
    let page;
    try {
      page = await ctx.gmail.listMessages({
        labelIds: [phase === "listing_inbox" ? "INBOX" : "SENT"],
        q,
        pageToken: state.backfillPageToken ?? undefined,
      });
    } catch (err) {
      // A stored page token can expire (lifetime undocumented): restart this phase from page 1.
      if (err instanceof GmailApiError && err.status === 400 && state.backfillPageToken && !restarted) {
        restarted = true;
        await updateSyncState(ctx.db, ctx.account.id, { backfillPageToken: null });
        state = (await getSyncState(ctx.db, ctx.account.id))!;
        continue;
      }
      throw err;
    }
    const listed = page.messages ?? [];
    let rows: EnqueueRow[];
    if (phase === "listing_inbox") {
      rows = listed.map((m) => ({
        gmailMessageId: m.id,
        gmailThreadId: m.threadId,
        source: resync ? "resync" : "backfill_inbox",
        needsClassify: false,
      }));
    } else {
      // Sent mail is kept only for threads Alex already knows; list results carry threadId, so no extra call.
      const known = await knownThreadIds(ctx.db, ctx.account.id, listed.map((m) => m.threadId));
      rows = listed
        .filter((m) => known.has(m.threadId))
        .map((m) => ({ gmailMessageId: m.id, gmailThreadId: m.threadId, source: resync ? "resync" : "backfill_sent", needsClassify: false }));
    }
    const added = await enqueueMessages(ctx.db, ctx.account, rows);
    const nextPhase = phase === "listing_inbox" ? "listing_sent" : "hydrating";
    await updateSyncState(ctx.db, ctx.account.id, {
      backfillPageToken: page.nextPageToken ?? null,
      backfillListed: state.backfillListed + added,
      ...(page.nextPageToken ? {} : { backfillStatus: nextPhase }),
    });
    state = (await getSyncState(ctx.db, ctx.account.id))!;
  }
  return state;
}

async function maybeCompleteListing(ctx: Ctx, state: MailSyncState): Promise<void> {
  if (state.backfillStatus !== "hydrating") return;
  const resync = state.resyncAfter !== null;
  const firstCompletion = state.backfillCompletedAt === null;
  // A resync that started during an unfinished backfill must also wait for the backfill's rows.
  const sources: ("resync" | "backfill_inbox" | "backfill_sent")[] = !resync
    ? ["backfill_inbox", "backfill_sent"]
    : firstCompletion
      ? ["resync", "backfill_inbox", "backfill_sent"]
      : ["resync"];
  const pending = await countPendingQueue(ctx.db, ctx.account.id, sources);
  if (pending > 0) return;
  const { account } = ctx;
  await updateSyncState(ctx.db, account.id, {
    backfillStatus: "complete",
    backfillPageToken: null,
    resyncAfter: null,
    ...(firstCompletion ? { backfillCompletedAt: ctx.now() } : {}),
  });
  if (firstCompletion) {
    const counts = await ctx.db
      .select({
        inbox: sql<number>`count(*) filter (where not ${mailMessages.isSent})::int`,
        sent: sql<number>`count(*) filter (where ${mailMessages.isSent})::int`,
      })
      .from(mailMessages)
      .where(eq(mailMessages.accountId, account.id));
    await audit(
      {
        userId: account.userId,
        accountId: account.id,
        action: "mail.backfill_completed",
        detail: { inbox: counts[0]?.inbox ?? 0, sent: counts[0]?.sent ?? 0 },
      },
      ctx.db,
    );
  }
}

// ---- Classify and hydrate (plan 6.6) ----------------------------------------------------------

async function otherInboxRowQueued(ex: Executor, accountId: string, gmailThreadId: string, exceptMessageId: string): Promise<boolean> {
  const rows = await ex
    .select({ id: mailFetchQueue.id })
    .from(mailFetchQueue)
    .where(
      and(
        eq(mailFetchQueue.accountId, accountId),
        eq(mailFetchQueue.gmailThreadId, gmailThreadId),
        ne(mailFetchQueue.gmailMessageId, exceptMessageId),
        // Same definition as the known-thread lookup: inbox source, not parked, and not itself a
        // deferred sent message (two sent messages must never wait on each other).
        inboxBoundQueueRow(),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function threadContext(ctx: Ctx, gmailThreadId: string, messageId: string) {
  const stored = (await threadRowId(ctx.db, ctx.account.id, gmailThreadId)) !== null;
  const inboxQueued = stored ? false : await otherInboxRowQueued(ctx.db, ctx.account.id, gmailThreadId, messageId);
  return { stored, inboxQueued };
}

/**
 * Defers a sent message whose thread isn't stored yet. While the thread's inbox message is still
 * pending in the queue (for example behind a long backfill or resync), waiting doesn't use up an
 * attempt, so the reply isn't lost. When there is no stored thread and no pending inbox row,
 * attempts count and the row is dropped at MAX_ATTEMPTS. Each wait costs one DB check per
 * DEFER_DELAY_MS, with no Gmail call (see the deferred fast path in hydrateRow).
 *
 * Backstop: after MAX_DEFERRALS deferrals, attempts count regardless of siblings. Every deferred
 * row therefore leaves the queue within MAX_DEFERRALS + MAX_ATTEMPTS deferrals, and can't block
 * backfill or resync completion indefinitely.
 */
async function deferSent(ctx: Ctx, row: MailFetchQueueRow, gmailThreadId: string | null): Promise<void> {
  const t = gmailThreadId ? await threadContext(ctx, gmailThreadId, row.gmailMessageId) : { stored: false, inboxQueued: false };
  const waitedTooLong = row.deferCount >= MAX_DEFERRALS;
  await deferQueueRow(ctx.db, row, ctx.now(), DEFER_DELAY_MS, MAX_ATTEMPTS, {
    consumeAttempt: !t.inboxQueued || waitedTooLong,
    gmailThreadId,
  });
}

/**
 * Processes one queue row. Every path either deletes the row or moves its next_attempt_at, so the
 * hydrate loop always makes progress. Transient Gmail errors (429/5xx) and 401 are re-thrown to
 * stop this account for the run.
 */
async function hydrateRow(ctx: Ctx, row: MailFetchQueueRow): Promise<void> {
  const { account } = ctx;
  const id = row.gmailMessageId;
  try {
    if (await isMessageStored(ctx.db, account.id, id)) {
      if (row.source === "resync") {
        // Label refresh after an expired-history resync.
        try {
          const m = await ctx.gmail.getMessageMinimal(id);
          await changeLabels(ctx.db, account.id, id, { set: m.labelIds ?? [] });
        } catch (err) {
          if (!(err instanceof GmailApiError && err.status === 404)) throw err;
          await deleteStoredMessage(ctx.db, account.id, id);
        }
      }
      await deleteQueueRow(ctx.db, row.id);
      return;
    }

    // A listed sent message waits for its thread without spending a Gmail call.
    if (row.source === "backfill_sent" && row.gmailThreadId) {
      const t = await threadContext(ctx, row.gmailThreadId, id);
      if (!t.stored) {
        if (t.inboxQueued) await deferSent(ctx, row, row.gmailThreadId);
        else await dropQueueRow(ctx.db, row);
        return;
      }
    }

    // A row that is already waiting keeps waiting, with no Gmail call, while its thread's inbox
    // message is still queued. Without a pending sibling it takes the normal path, which
    // re-checks its labels.
    if (row.deferredAt !== null && row.gmailThreadId) {
      const t = await threadContext(ctx, row.gmailThreadId, id);
      if (!t.stored && t.inboxQueued) {
        await deferSent(ctx, row, row.gmailThreadId);
        return;
      }
    }

    if (row.needsClassify) {
      const m = await ctx.gmail.getMessageMinimal(id);
      const decision = classifyForIngest(m.labelIds ?? [], await threadContext(ctx, m.threadId, id), row.source);
      if (decision === "drop") {
        // Conditional (plan §6.4, R7): a row converted to outbound while this ran is kept.
        await dropQueueRow(ctx.db, row);
        return;
      }
      if (decision === "defer") {
        await deferSent(ctx, row, m.threadId);
        return;
      }
    }

    const full = await ctx.gmail.getMessageFull(id);
    const labels = full.labelIds ?? [];
    const decision = classifyForIngest(labels, await threadContext(ctx, full.threadId, id), row.source);
    if (decision === "drop") {
      await dropQueueRow(ctx.db, row);
      return;
    }
    if (decision === "defer") {
      await deferSent(ctx, row, full.threadId);
      return;
    }

    const parsed = parseMessage(full);
    let bodyIncomplete = false;
    for (const pending of parsed.pendingBodies) {
      // The only use of messages.attachments.get: text/plain or text/html body parts with no
      // filename and no attachment disposition. Real attachments are never fetched.
      if (!isBodyPart(pending.part)) continue;
      try {
        const body = await ctx.gmail.getBodyPartData(full.id, pending.attachmentId);
        applyFetchedBody(parsed, pending, body.data);
      } catch (err) {
        if (err instanceof ReauthRequiredError) throw err;
        if (err instanceof GmailApiError && (err.transient || err.status === 401)) throw err;
        bodyIncomplete = true;
      }
    }

    // Revision 4: render once, at ingest, in the time-limited worker; stored with the message.
    const render = await ctx.render({ html: parsed.bodyHtml, text: parsed.bodyText });

    const internalMs = full.internalDate ? Number(full.internalDate) : NaN;
    const stored = await storeMessage(ctx.db, {
      account,
      gmailMessageId: full.id,
      gmailThreadId: full.threadId,
      historyId: full.historyId ?? null,
      internalDate: Number.isFinite(internalMs) ? new Date(internalMs) : ctx.now(),
      labelIds: labels,
      snippet: full.snippet ?? null,
      sizeEstimate: full.sizeEstimate ?? null,
      parsed,
      bodyIncomplete,
      // INBOX mail, and the SENT copy of a new message Alex sent (outbound), create their thread.
      createThread: decision === "inbox" || decision === "outbound",
      queueRowId: row.id,
      render,
    });
    if (!stored) await deferSent(ctx, row, full.threadId);
  } catch (err) {
    if (err instanceof ReauthRequiredError) throw err;
    if (err instanceof GmailApiError) {
      if (err.status === 404) {
        await deleteQueueRow(ctx.db, row.id); // gone from Gmail
        return;
      }
      if (err.transient) {
        await failQueueRow(ctx.db, row, ctx.now(), { transient: true, error: `${err.status} ${err.reason ?? ""}`.trim(), maxAttempts: MAX_ATTEMPTS, maxTransientAttempts: MAX_TRANSIENT_ATTEMPTS });
        throw err; // stop this account for this run
      }
      if (err.status === 401) throw err;
      await failQueueRow(ctx.db, row, ctx.now(), { transient: false, error: `${err.status} ${err.reason ?? ""}`.trim(), maxAttempts: MAX_ATTEMPTS, maxTransientAttempts: MAX_TRANSIENT_ATTEMPTS });
      return;
    }
    if (err instanceof GmailShapeError) {
      await failQueueRow(ctx.db, row, ctx.now(), { transient: false, error: err.message, maxAttempts: MAX_ATTEMPTS, maxTransientAttempts: MAX_TRANSIENT_ATTEMPTS });
      return;
    }
    throw err;
  }
}

/**
 * Time a row may need beyond the Gmail calls: one render job at its limit, plus margin (R4.8). A
 * row is only started when at least this much of the run budget remains. That bounds this
 * account's own render; it does not cover time spent waiting in the shared render pool. The pool
 * has one worker for all accounts running in parallel, so a job can first queue behind other
 * accounts' jobs, and the run can overrun its budget by up to about
 * (accounts - 1) x (RENDER_LIMIT_MS + worker respawn). That overrun is absorbed by the slack
 * between the 240 s budget, the 290 s lease and maxDuration = 300.
 */
const RENDER_GUARD_MS = RENDER_LIMIT_MS + 5_000;

async function hydrate(ctx: Ctx): Promise<void> {
  for (;;) {
    if (ctx.outOfTime() || ctx.remainingMs() < RENDER_GUARD_MS) return;
    const rows = await dueQueueRows(ctx.db, ctx.account.id, ctx.now(), 25);
    if (rows.length === 0) return;
    for (const row of rows) {
      // Budget guard (R4.8): checked before any Gmail call for the row, so before its full get.
      if (ctx.outOfTime() || ctx.remainingMs() < RENDER_GUARD_MS) return;
      await hydrateRow(ctx, row);
    }
  }
}

const RERENDER_BATCH = 25;

/**
 * Re-render stage (R4.7, cron runs only): stored messages whose rendering is missing or older than
 * the current sanitizer version are rendered again, newest first, in batches, while the budget
 * allows. No Gmail calls. If the worker is unavailable the stage stops and leaves the rows as they
 * are (older but displayable output isn't replaced by a text fallback).
 */
async function rerender(ctx: Ctx): Promise<void> {
  let rendered = 0;
  outer: for (;;) {
    if (ctx.remainingMs() < RENDER_GUARD_MS) break;
    const rows = await messagesNeedingRender(ctx.db, ctx.account.id, ctx.sanitizerVersion, RERENDER_BATCH);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (ctx.remainingMs() < RENDER_GUARD_MS) break outer;
      const fields = await ctx.render({ html: row.bodyHtml, text: row.bodyText });
      if (fields.renderReason === "worker_unavailable") break outer;
      await updateMessageRender(ctx.db, row.id, fields);
      rendered += 1;
    }
  }
  if (rendered > 0) {
    const remaining = await countMessagesNeedingRender(ctx.db, ctx.account.id, ctx.sanitizerVersion);
    await audit(
      { userId: ctx.account.userId, accountId: ctx.account.id, action: "mail.rerender_progress", detail: { rendered, remaining } },
      ctx.db,
    );
  }
}

let workerUnavailableAudited = false;

/** The run's renderer: deps.render or renderEmailBody, auditing an unavailable worker once per process. */
function renderFor(deps: SyncDeps, account: ConnectedAccount, version: number, counts: Record<string, number> = {}) {
  const render = deps.render ?? ((body, opts) => renderEmailBody(body, { version: opts.version }));
  return async (body: { html: string | null; text: string | null }): Promise<RenderFields> => {
    const fields = await render(body, { version });
    const key = fields.renderReason ? `${fields.renderKind}:${fields.renderReason}` : fields.renderKind;
    counts[key] = (counts[key] ?? 0) + 1;
    if (fields.renderReason === "worker_unavailable" && !workerUnavailableAudited) {
      workerUnavailableAudited = true;
      console.error("email render worker unavailable; HTML mail is stored as text until it can be re-rendered", { accountId: account.id });
      await audit({ userId: account.userId, accountId: account.id, action: "mail.render_worker_unavailable" }, deps.db).catch(() => undefined);
    }
    return fields;
  };
}

// ---- Per-account run --------------------------------------------------------------------------

async function noteReauthSkip(db: Executor, account: ConnectedAccount): Promise<void> {
  const state = await ensureSyncState(db, account);
  if (state.lastError === REAUTH_MARK) return;
  await updateSyncState(db, account.id, { lastError: REAUTH_MARK, lastErrorAt: new Date() });
  await audit({ userId: account.userId, accountId: account.id, action: "mail.sync_skipped_reauth" }, db);
}

async function recordFailure(db: Executor, account: ConnectedAccount, stage: string, err: unknown): Promise<void> {
  const { status, reason } = describeError(err);
  const message = `${stage}: ${status ?? ""} ${reason}`.replace(/\s+/g, " ").trim();
  const state = await getSyncState(db, account.id);
  const changed = state?.lastError !== message;
  const firstAfterSuccess = (state?.consecutiveFailures ?? 0) === 0;
  await updateSyncState(db, account.id, {
    lastError: message,
    lastErrorAt: new Date(),
    consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
  });
  if (changed || firstAfterSuccess) {
    await audit({ userId: account.userId, accountId: account.id, action: "mail.sync_error", detail: { stage, status, reason } }, db);
  }
  console.error("mail sync failed", { accountId: account.id, stage, status, reason });
}

/**
 * One sync pass for one account. `cron`: setup if needed, watch renewal, history, listing,
 * hydrate. `connect`: same, re-registering the watch. `push`: history and hydrate only, and
 * nothing at all before setup has stored a cursor.
 */
export async function syncAccount(
  deps: SyncDeps,
  account: ConnectedAccount,
  mode: RunMode,
  deadline?: number,
): Promise<AccountRunResult> {
  const now = deps.now ?? (() => new Date());
  const end = deadline ?? now().getTime() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
  const db = deps.db;

  if (account.provider !== "google") return { accountId: account.id, outcome: "skipped_not_ready" };
  if (account.status !== "active") {
    await noteReauthSkip(db, account);
    return { accountId: account.id, outcome: "skipped_reauth" };
  }

  const initial = await ensureSyncState(db, account);
  if (mode === "push" && !initial.historyId) return { accountId: account.id, outcome: "skipped_not_ready" };

  const owner = randomUUID();
  let state = await acquireLease(db, account.id, owner);
  if (!state) return { accountId: account.id, outcome: "busy" };
  const renders: Record<string, number> = {};

  const ctx: Ctx = {
    db,
    account,
    gmail: pacedClient(deps.gmailFor(account), {
      unitsPerMinute: deps.unitsPerMinute ?? DEFAULT_UNITS_PER_MINUTE,
      now,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, Math.min(ms, Math.max(0, end - now().getTime()))))),
    }),
    topic: deps.topic,
    now,
    outOfTime: () => now().getTime() >= end,
    remainingMs: () => end - now().getTime(),
    render: renderFor(deps, account, deps.sanitizerVersion ?? SANITIZER_VERSION, renders),
    sanitizerVersion: deps.sanitizerVersion ?? SANITIZER_VERSION,
  };

  let stage = "setup";
  try {
    if (mode !== "push") state = await setup(ctx, state, mode);
    stage = "history";
    state = await reconcileHistory(ctx, state);
    if (mode !== "push") {
      stage = "listing";
      state = await runListing(ctx, state);
    }
    stage = "hydrate";
    await hydrate(ctx);
    if (mode === "cron") {
      // Revision 4, R4.7: push and connect runs skip this so they stay short.
      stage = "rerender";
      await rerender(ctx);
    }
    if (deps.triage && (mode === "cron" || mode === "push")) {
      // Phase 2c: advisory triage of recent INBOX mail. Its failures never fail the sync.
      await runTriageStage({ db, provider: deps.triage.provider, now, remainingMs: ctx.remainingMs }, account).catch((err: unknown) => {
        console.error("ai triage stage failed", { accountId: account.id, error: err instanceof Error ? err.name : "unknown" });
      });
    }
    if (mode !== "push") {
      stage = "listing";
      await maybeCompleteListing(ctx, (await getSyncState(db, account.id))!);
    }
    const latest = await getSyncState(db, account.id);
    if (latest && (latest.lastError !== null || latest.consecutiveFailures > 0)) {
      await updateSyncState(db, account.id, { lastError: null, lastErrorAt: null, consecutiveFailures: 0 });
    }
    return { accountId: account.id, outcome: "ok", renders };
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      await noteReauthSkip(db, account);
      return { accountId: account.id, outcome: "skipped_reauth", stage, renders };
    }
    await recordFailure(db, account, stage, err);
    return { accountId: account.id, outcome: "error", stage, renders };
  } finally {
    await releaseLease(db, account.id, owner);
  }
}

async function googleAccounts(db: Executor, accountId?: string): Promise<ConnectedAccount[]> {
  const where = accountId
    ? and(eq(connectedAccounts.provider, "google"), eq(connectedAccounts.id, accountId))
    : eq(connectedAccounts.provider, "google");
  return db.select().from(connectedAccounts).where(where);
}

/** The 5-minute cron: every Google account, in parallel, within one shared deadline. */
export async function runCronSync(deps: SyncDeps): Promise<AccountRunResult[]> {
  const now = deps.now ?? (() => new Date());
  const deadline = now().getTime() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
  const accounts = await googleAccounts(deps.db);
  const results = await Promise.allSettled(accounts.map((a) => syncAccount(deps, a, "cron", deadline)));
  return results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { accountId: accounts[i]!.id, outcome: "error" as const, stage: "run" },
  );
}

/** After connect or reconnect: set up ingestion and run a first pass. */
export async function syncAfterConnect(deps: SyncDeps, accountId: string): Promise<AccountRunResult | null> {
  const [account] = await googleAccounts(deps.db, accountId);
  return account ? syncAccount(deps, account, "connect") : null;
}

/** After a verified push: history and hydrate for that account only. */
export async function syncAfterPush(deps: SyncDeps, accountId: string): Promise<AccountRunResult | null> {
  const [account] = await googleAccounts(deps.db, accountId);
  return account ? syncAccount(deps, account, "push") : null;
}

/**
 * Daily watch renewal for every active Google account that has been set up. Not lease-protected:
 * users.watch is idempotent and only the watch columns are written.
 */
export async function runWatchRenewal(deps: SyncDeps): Promise<{ accountId: string; outcome: "renewed" | "skipped" }[]> {
  const now = deps.now ?? (() => new Date());
  const accounts = (await googleAccounts(deps.db)).filter((a) => a.status === "active");
  const out: { accountId: string; outcome: "renewed" | "skipped" }[] = [];
  await Promise.allSettled(
    accounts.map(async (account) => {
      const state = await getSyncState(deps.db, account.id);
      if (!state || !state.historyId || !deps.topic) {
        out.push({ accountId: account.id, outcome: "skipped" });
        return;
      }
      const ctx: Ctx = {
        db: deps.db,
        account,
        gmail: deps.gmailFor(account),
        topic: deps.topic,
        now,
        outOfTime: () => false,
        remainingMs: () => Infinity,
        render: renderFor(deps, account, deps.sanitizerVersion ?? SANITIZER_VERSION),
        sanitizerVersion: deps.sanitizerVersion ?? SANITIZER_VERSION,
      };
      try {
        await registerWatch(ctx, "renewed");
        out.push({ accountId: account.id, outcome: "renewed" });
      } catch (err) {
        if (err instanceof ReauthRequiredError) await noteReauthSkip(deps.db, account);
        out.push({ accountId: account.id, outcome: "skipped" });
      }
    }),
  );
  return out;
}


