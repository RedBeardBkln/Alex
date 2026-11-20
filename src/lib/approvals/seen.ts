import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { approvalItems, approvalRecipientCharges, connectedAccounts, mailMessages, type ApprovalItem } from "@/db/schema";
import { addressKey, extractAddresses } from "./addresses";
import { isNewMessage } from "./payload";
import { recipientKeys } from "./recipients";

/**
 * "Seen" addresses for the daily first-time-recipient cap (Phase 2d, owner Q3 and Q4). User-scoped,
 * across all of the user's accounts. An address is seen if it equals, case-insensitively and as a
 * whole address read by `extractAddresses` (never a substring), one of:
 * (a) the user's connected account addresses
 * (b) a To or Cc address of a stored message with is_sent = true
 * (c) a To or Cc address of the approved payload of a succeeded `email.send` item
 * (d) a From or Reply-To address of a stored inbound message not labelled SPAM or TRASH
 * and, for a reply only (owner amendment to Q3), any From, Reply-To, To or Cc address of the stored
 * parent message being replied to.
 *
 * SQL only prefilters rows with position() on the lowercased header (no LIKE, because % and _ are
 * legal in local parts); every hit is confirmed in code. No addresses are logged or audited.
 */

const COUNTED_STATUSES: ApprovalItem["status"][] = ["approved", "executing", "succeeded", "unknown"];

function candidateArray(keys: string[]) {
  return sql`array[${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )}]::text[]`;
}

/** True if any candidate occurs inside the lowercased SQL text expression (a prefilter only). */
function mentionsAny(keys: string[], expr: ReturnType<typeof sql>) {
  return sql`exists (select 1 from unnest(${candidateArray(keys)}) c where position(c in lower(${expr})) > 0)`;
}

export type ReplyParentRef = { messageId: string; accountId: string } | null;

/** The lowercased candidates that are seen. */
export async function seenAddresses(ex: Executor, userId: string, candidates: string[], parent: ReplyParentRef = null): Promise<Set<string>> {
  const keys = [...new Set(candidates.map(addressKey))];
  const seen = new Set<string>();
  if (keys.length === 0) return seen;
  const want = new Set(keys);
  const take = (header: string | null) => {
    for (const a of extractAddresses(header).addresses) {
      const k = addressKey(a);
      if (want.has(k)) seen.add(k);
    }
  };

  // (a) the owner's own accounts.
  const accounts = await ex.select({ email: connectedAccounts.email }).from(connectedAccounts).where(eq(connectedAccounts.userId, userId));
  for (const a of accounts) {
    const k = addressKey(a.email.trim());
    if (want.has(k)) seen.add(k);
  }

  // Amendment to Q3: the stored parent of a reply (scoped to the user and the item's account). Round 2,
  // F1: only a parent not labelled SPAM or TRASH, consistent with (d); otherwise the normal rules apply.
  if (parent) {
    const [p] = await ex
      .select({ from: mailMessages.fromHeader, replyTo: mailMessages.replyToHeader, to: mailMessages.toHeader, cc: mailMessages.ccHeader })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.id, parent.messageId),
          eq(mailMessages.userId, userId),
          eq(mailMessages.accountId, parent.accountId),
          sql`not ('SPAM' = any(${mailMessages.labelIds}) or 'TRASH' = any(${mailMessages.labelIds}))`,
        ),
      )
      .limit(1);
    if (p) for (const h of [p.from, p.replyTo, p.to, p.cc]) take(h);
  }
  if (seen.size === want.size) return seen;

  // (b) and (d): stored mail, prefiltered in SQL, confirmed with extractAddresses.
  const rows = await ex
    .select({
      isSent: mailMessages.isSent,
      from: mailMessages.fromHeader,
      replyTo: mailMessages.replyToHeader,
      to: mailMessages.toHeader,
      cc: mailMessages.ccHeader,
    })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.userId, userId),
        sql`(
          (${mailMessages.isSent} and ${mentionsAny(keys, sql`coalesce(${mailMessages.toHeader}, '') || ' ' || coalesce(${mailMessages.ccHeader}, '')`)})
          or (not ${mailMessages.isSent}
              and not ('SPAM' = any(${mailMessages.labelIds}) or 'TRASH' = any(${mailMessages.labelIds}))
              and ${mentionsAny(keys, sql`coalesce(${mailMessages.fromHeader}, '') || ' ' || coalesce(${mailMessages.replyToHeader}, '')`)})
        )`,
      ),
    );
  for (const r of rows) {
    if (r.isSent) {
      take(r.to);
      take(r.cc);
    } else {
      take(r.from);
      take(r.replyTo);
    }
  }
  if (seen.size === want.size) return seen;

  // (c) recipients of Alex's own succeeded sends (validated bare addresses, so an exact match is a whole-address match).
  const payloadList = (key: "to" | "cc") => {
    const field = sql.raw(`'${key}'`); // a fixed literal, so `->` resolves to the text-key operator
    return sql`case when jsonb_typeof(${approvalItems.approvedPayload}->${field}) = 'array' then ${approvalItems.approvedPayload}->${field} else '[]'::jsonb end`;
  };
  const sent = await ex.execute<{ a: string }>(sql`
    select distinct lower(e.v) as a
    from ${approvalItems}
    cross join lateral jsonb_array_elements_text(${payloadList("to")} || ${payloadList("cc")}) as e(v)
    where ${approvalItems.userId} = ${userId}::uuid
      and ${approvalItems.kind} = 'email.send'
      and ${approvalItems.status} = 'succeeded'
      and lower(e.v) = any(${candidateArray(keys)})
  `);
  for (const r of sent as unknown as { a: string }[]) if (want.has(r.a)) seen.add(r.a);
  return seen;
}

/** The parent reference that counts as seen for this item: the stored parent of a reply, none for a new message. */
export function replyParentOf(item: Pick<ApprovalItem, "payload" | "parentMessageId" | "accountId">): ReplyParentRef {
  if (isNewMessage(item.payload) || !item.parentMessageId || !item.accountId) return null;
  return { messageId: item.parentMessageId, accountId: item.accountId };
}

/** The payload's distinct recipients (lowercased) that are not seen: its first-time recipients. */
export async function firstTimeRecipients(
  ex: Executor,
  userId: string,
  payload: { to: string[]; cc: string[] },
  parent: ReplyParentRef,
): Promise<string[]> {
  const keys = recipientKeys(payload);
  const seen = await seenAddresses(ex, userId, keys, parent);
  return keys.filter((k) => !seen.has(k));
}

/**
 * First-time recipients already counted today (UTC day starting at `dayStart`), from
 * approval_recipient_charges (round 2, D1), which survives account disconnects. A charge counts
 * while its item is approved, executing, succeeded or unknown, and also once the item no longer
 * exists because its account was deleted (Disconnect cascade-deletes the items; erring toward
 * caution, so a disconnect or reconnect can't hand the day's allowance back). An item that
 * ends failed (including marked not sent), pending again after an edit, or cancelled stops counting.
 */
export async function newRecipientsUsedToday(ex: Executor, userId: string, dayStart: Date): Promise<number> {
  const counted = sql.join(
    COUNTED_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const [row] = await ex
    .select({ n: sql<number>`coalesce(sum(${approvalRecipientCharges.newRecipients}), 0)::int` })
    .from(approvalRecipientCharges)
    .leftJoin(approvalItems, eq(approvalItems.id, approvalRecipientCharges.itemId))
    .where(
      and(
        eq(approvalRecipientCharges.userId, userId),
        // While the item exists its own approved_at is used (they are written together).
        sql`coalesce(${approvalItems.approvedAt}, ${approvalRecipientCharges.approvedAt}) >= ${dayStart.toISOString()}::timestamptz`,
        sql`(
          (${approvalItems.id} is not null and ${approvalItems.status}::text in (${counted}))
          or (${approvalItems.id} is null and (
            ${approvalRecipientCharges.accountId} is null
            or not exists (select 1 from ${connectedAccounts} a where a.id = ${approvalRecipientCharges.accountId})
          ))
        )`,
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Records (or, on a re-approval, replaces) what this approval charged against the daily cap. Call
 * inside the approve transaction, under the per-user cap lock, in the same transaction as the
 * conditional UPDATE that approves the item.
 */
export async function recordRecipientCharge(
  ex: Executor,
  input: { itemId: string; userId: string; accountId: string | null; approvedAt: Date; newRecipients: number },
): Promise<void> {
  await ex
    .insert(approvalRecipientCharges)
    .values(input)
    .onConflictDoUpdate({
      target: approvalRecipientCharges.itemId,
      set: { approvedAt: input.approvedAt, newRecipients: input.newRecipients, userId: input.userId, accountId: input.accountId },
    });
}
