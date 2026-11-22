import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { mailMessages, mailTriage, type ConnectedAccount } from "@/db/schema";
import { aiCaps, nextUtcMidnight, type Caps } from "@/lib/ai-ledger/config";
import { ambiguousFailureCost } from "@/lib/ai-ledger/pricing";
import { auditCapReachedOnce, auditProviderErrorDeduped, capState, logAiCall, SPEND_LIMIT_CODE } from "@/lib/ai-ledger/ledger";
import { extractAddresses } from "@/lib/approvals/addresses";
import { auditForAccount, lockAccountForWrite } from "@/lib/db-locks";
import { TRIAGE_MODEL, TRIAGE_PROMPT_VERSION } from "./prompts";
import type { ThreadTextMessage, TriageOutcome, TriageProvider } from "./types";

/**
 * Triage (Phase 2c, owner Q1/Q2): one Haiku call per recent INBOX message, sequentially, inside
 * the sync run's budget. Advisory only: it never hides, moves or changes mail, and its failures
 * never fail the sync (the caller catches everything).
 */

/** Owner Q1: mail received in the last 3 days is triaged on ingest; older mail on demand. */
export const TRIAGE_WINDOW_MS = 3 * 86_400_000;
/** Stop starting new calls when less than this is left of the run budget. */
export const TRIAGE_BUDGET_GUARD_MS = 15_000;
export const TRIAGE_MAX_ATTEMPTS = 3;
export const TRIAGE_BATCH = 50;
export const TRIAGE_TIMEOUT_MS = 30_000;
/** Backoff after a failed attempt: 5 minutes, doubled each time. */
const backoffMs = (attempts: number) => 5 * 60_000 * 2 ** Math.max(0, attempts - 1);

export type TriageStageDeps = {
  db: Executor;
  provider: TriageProvider;
  now?: () => Date;
  /** Milliseconds left in the run's budget; no limit when omitted. */
  remainingMs?: () => number;
  caps?: Caps;
};

export type TriageRunResult = { triaged: number; failed: number; skippedCap: number; costUsdMicros: number };

type Candidate = {
  id: string;
  threadId: string;
  fromHeader: string | null;
  dateHeader: string | null;
  subject: string | null;
  bodyText: string | null;
  renderedText: string | null;
  isSent: boolean;
  attempts: number | null;
};

const candidateColumns = {
  id: mailMessages.id,
  threadId: mailMessages.threadId,
  fromHeader: mailMessages.fromHeader,
  dateHeader: mailMessages.dateHeader,
  subject: mailMessages.subject,
  bodyText: mailMessages.bodyText,
  renderedText: mailMessages.renderedText,
  isSent: mailMessages.isSent,
  attempts: mailTriage.attempts,
};

/** No row for this prompt version yet, or a retryable one (error under the attempt limit, or a past cap pause) that is due. */
const isDue = (now: Date) => sql`(
  ${mailTriage.id} is null
  or (${mailTriage.status} = 'error' and ${mailTriage.attempts} < ${TRIAGE_MAX_ATTEMPTS} and (${mailTriage.nextAttemptAt} is null or ${mailTriage.nextAttemptAt} <= ${now.toISOString()}::timestamptz))
  or (${mailTriage.status} = 'skipped_cap' and (${mailTriage.nextAttemptAt} is null or ${mailTriage.nextAttemptAt} <= ${now.toISOString()}::timestamptz))
)`;

const inInbox = sql`'INBOX' = any(${mailMessages.labelIds}) and not ('SPAM' = any(${mailMessages.labelIds})) and not ('TRASH' = any(${mailMessages.labelIds}))`;

/** Due INBOX, non-SENT messages of the account received inside the window, newest first. */
export async function triageCandidates(ex: Executor, accountId: string, now: Date, limit = TRIAGE_BATCH): Promise<Candidate[]> {
  return ex
    .select(candidateColumns)
    .from(mailMessages)
    .leftJoin(mailTriage, and(eq(mailTriage.messageId, mailMessages.id), eq(mailTriage.promptVersion, TRIAGE_PROMPT_VERSION)))
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        eq(mailMessages.isSent, false),
        inInbox,
        gte(mailMessages.internalDate, new Date(now.getTime() - TRIAGE_WINDOW_MS)),
        isDue(now),
      ),
    )
    .orderBy(desc(mailMessages.internalDate), desc(mailMessages.id))
    .limit(limit);
}

/** The model's view of one message: plain stored text, never HTML. */
export function toTriageMessage(m: Pick<Candidate, "fromHeader" | "dateHeader" | "subject" | "bodyText" | "renderedText" | "isSent">): ThreadTextMessage {
  return {
    source: m.isSent ? "owner_sent" : "inbound_email",
    from_address: extractAddresses(m.fromHeader).addresses[0] ?? null,
    date: m.dateHeader,
    subject: m.subject,
    text: m.bodyText ?? m.renderedText ?? "",
  };
}

type RowWrite = {
  status: (typeof mailTriage.$inferInsert)["status"];
  category?: (typeof mailTriage.$inferInsert)["category"];
  needsReply?: boolean | null;
  summary?: string | null;
  nextAttemptAt?: Date | null;
  countAttempt: boolean;
};

async function writeTriageRow(ex: Executor, account: Pick<ConnectedAccount, "id" | "userId">, m: Candidate, provider: string, w: RowWrite, now: Date): Promise<void> {
  const attempts = (m.attempts ?? 0) + (w.countAttempt ? 1 : 0);
  const values = {
    status: w.status,
    category: w.category ?? null,
    needsReply: w.needsReply ?? null,
    summary: w.summary ?? null,
    provider,
    model: TRIAGE_MODEL,
    attempts,
    nextAttemptAt: w.nextAttemptAt ?? null,
    updatedAt: now,
  };
  await ex
    .insert(mailTriage)
    .values({ userId: account.userId, accountId: account.id, messageId: m.id, threadId: m.threadId, promptVersion: TRIAGE_PROMPT_VERSION, ...values })
    .onConflictDoUpdate({ target: [mailTriage.messageId, mailTriage.promptVersion], set: values });
}

/** O2 sibling (phase-2-followups-2, owner Q10): the ai_calls code of a finished call whose account was disconnected meanwhile. */
const DISCONNECTED = "account_disconnected";

type Recorded = { cost: number; accountLive: boolean };

async function writeTriageOutcome(
  tx: Executor,
  account: Pick<ConnectedAccount, "id" | "userId">,
  m: Candidate,
  provider: string,
  out: TriageOutcome,
  now: Date,
  live: { account: boolean; message: boolean },
): Promise<Recorded> {
  const accountId = live.account ? account.id : null;
  if (out.status === "error") await auditProviderErrorDeduped(tx, account.userId, accountId, "triage", out.errorCode ?? "error");
  const call = await logAiCall(tx, {
    userId: account.userId,
    accountId,
    purpose: "triage",
    status: out.status,
    // Owner Q6 rules: a finished call whose account is gone records account_disconnected; a failed
    // call keeps the provider's code (the reserve and the "estimated" column depend on it).
    errorCode: !live.account && out.status === "ok" ? DISCONNECTED : out.errorCode,
    messageId: live.message ? m.id : null,
    // Round 4, B1: an ambiguous failure is recorded at the triage reserve (no usage came back).
    usage: ((r) => (r !== null ? { ...out.usage, costUsdMicros: r } : out.usage))(ambiguousFailureCost("triage", out.status, out.errorCode)),
  });
  // No triage row for a message that is gone (with its account, or deleted on its own).
  if (live.account && live.message) {
    if (out.status === "ok" && out.result) {
      await writeTriageRow(tx, account, m, provider, { status: "ok", category: out.result.category, needsReply: out.result.needsReply, summary: out.result.summary, countAttempt: true }, now);
    } else if (out.status === "error") {
      const attempts = (m.attempts ?? 0) + 1;
      await writeTriageRow(tx, account, m, provider, { status: "error", nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)), countAttempt: true }, now);
    } else {
      await writeTriageRow(tx, account, m, provider, { status: out.status, countAttempt: true }, now);
    }
  }
  return { cost: call.costUsdMicros ?? 0, accountLive: live.account };
}

/**
 * Triages one message (any age). Returns the outcome; caps are checked by the caller.
 *
 * O2 sibling (owner Q10): the call's row, its provider-error audit and the triage row are written in
 * one transaction that locks the account first. If the account was disconnected during the call, the
 * billed call is still recorded (null account and message ids, real usage) and no triage row is
 * written. The message row is locked too, so a message deleted on its own is handled the same way.
 */
async function triageOne(deps: TriageStageDeps, account: Pick<ConnectedAccount, "id" | "userId">, m: Candidate, now: Date) {
  const out = await deps.provider.triage({ message: toTriageMessage(m) }, AbortSignal.timeout(TRIAGE_TIMEOUT_MS));
  const recorded = await deps.db.transaction(async (tx) => {
    if (!(await lockAccountForWrite(tx, account.id))) return writeTriageOutcome(tx, account, m, deps.provider.id, out, now, { account: false, message: false });
    const [message] = await tx.select({ id: mailMessages.id }).from(mailMessages).where(eq(mailMessages.id, m.id)).for("key share");
    return writeTriageOutcome(tx, account, m, deps.provider.id, out, now, { account: true, message: !!message });
  });
  return { status: out.status, errorCode: out.errorCode, cost: recorded.cost, accountLive: recorded.accountLive };
}

/** The ai.triage_run audit; written with a null account id if the account is gone (O2 sibling). */
async function auditTriageRun(ex: Executor, account: Pick<ConnectedAccount, "id" | "userId">, r: { triaged: number; failed: number; skippedCap: number; costUsdMicros: number }) {
  await auditForAccount(ex, {
    userId: account.userId,
    accountId: account.id,
    action: "ai.triage_run",
    detail: { triaged: r.triaged, failed: r.failed, skipped_cap: r.skippedCap, costUsdMicros: r.costUsdMicros },
  });
}

/**
 * The sync job's triage stage for one account (plan §7): newest first, one call at a time, until
 * the batch, the budget or a daily cap stops it. When a cap stops it, the remaining candidates get
 * a `skipped_cap` row that becomes due again at the next UTC midnight.
 */
export async function runTriageStage(deps: TriageStageDeps, account: Pick<ConnectedAccount, "id" | "userId">): Promise<TriageRunResult> {
  const now = () => (deps.now ?? (() => new Date()))();
  const remaining = deps.remainingMs ?? (() => Number.POSITIVE_INFINITY);
  const caps = deps.caps ?? aiCaps();
  const result: TriageRunResult = { triaged: 0, failed: 0, skippedCap: 0, costUsdMicros: 0 };
  const candidates = await triageCandidates(deps.db, account.id, now());
  for (let i = 0; i < candidates.length; i++) {
    if (remaining() < TRIAGE_BUDGET_GUARD_MS) break;
    const cap = await capState(deps.db, account.userId, "triage", now(), caps);
    if (cap.capped) {
      await auditCapReachedOnce(deps.db, account.userId, "triage", cap.cap, now());
      const rest = candidates.slice(i);
      // Lock order (O2 sibling): the account first; if it is gone, so are its messages, and nothing is written.
      result.skippedCap += await deps.db.transaction(async (tx) => {
        if (!(await lockAccountForWrite(tx, account.id))) return 0;
        for (const m of rest) {
          await writeTriageRow(tx, account, m, deps.provider.id, { status: "skipped_cap", nextAttemptAt: nextUtcMidnight(now()), countAttempt: false }, now());
        }
        return rest.length;
      });
      break;
    }
    const r = await triageOne(deps, account, candidates[i]!, now());
    result.costUsdMicros += r.cost;
    if (r.status === "ok") result.triaged++;
    else result.failed++;
    // The account was disconnected during the call: its other messages are gone too, so stop.
    if (!r.accountLive) break;
    if (r.errorCode === SPEND_LIMIT_CODE) {
      await auditCapReachedOnce(deps.db, account.userId, "triage", "spend_limit", now());
      break;
    }
  }
  if (result.triaged + result.failed + result.skippedCap > 0) await auditTriageRun(deps.db, account, result);
  return result;
}

/**
 * "Triage this thread" (on demand, for mail outside the window): the newest inbound message of the
 * user's thread, if it has no current result. Respects the daily caps.
 */
export async function triageThreadNow(
  deps: TriageStageDeps,
  userId: string,
  threadId: string,
): Promise<"triaged" | "already" | "not_found" | "capped" | "failed" | "account_disconnected"> {
  const now = (deps.now ?? (() => new Date()))();
  const [m] = await deps.db
    .select({ ...candidateColumns, accountId: mailMessages.accountId, triageStatus: mailTriage.status })
    .from(mailMessages)
    .leftJoin(mailTriage, and(eq(mailTriage.messageId, mailMessages.id), eq(mailTriage.promptVersion, TRIAGE_PROMPT_VERSION)))
    .where(and(eq(mailMessages.threadId, threadId), eq(mailMessages.userId, userId), eq(mailMessages.isSent, false), inInbox))
    .orderBy(desc(mailMessages.internalDate), desc(mailMessages.id))
    .limit(1);
  if (!m) return "not_found";
  if (m.triageStatus === "ok" || m.triageStatus === "refused" || m.triageStatus === "invalid") return "already";
  if (m.triageStatus === "error" && (m.attempts ?? 0) >= TRIAGE_MAX_ATTEMPTS) return "already";
  const cap = await capState(deps.db, userId, "triage", now, deps.caps ?? aiCaps());
  if (cap.capped) {
    await auditCapReachedOnce(deps.db, userId, "triage", cap.cap, now);
    return "capped";
  }
  const account = { id: m.accountId, userId };
  const r = await triageOne(deps, account, m, now);
  await auditTriageRun(deps.db, account, { triaged: r.status === "ok" ? 1 : 0, failed: r.status === "ok" ? 0 : 1, skippedCap: 0, costUsdMicros: r.cost });
  // O2 sibling: the thread went with its account, so the owner gets a clean answer, not a 500.
  if (!r.accountLive) return "account_disconnected";
  return r.status === "ok" ? "triaged" : "failed";
}
