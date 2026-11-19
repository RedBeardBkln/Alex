import type { AccountSummary } from "@/lib/accounts";
import type { AccountMailStatus } from "@/lib/gmail/store";
import { REAUTH_MARK } from "@/lib/gmail/marks";
import { LocalTime } from "../local-time";

const PHASES: Record<AccountMailStatus["backfillStatus"], string> = {
  pending: "waiting to start",
  listing_inbox: "listing inbox",
  listing_sent: "listing sent replies",
  hydrating: "downloading messages",
  complete: "up to date",
};

/** One-line mail ingestion status for an account (backfill phase and progress, last sync, reconnect needed). */
export function MailStatusLine({ account, status }: { account: AccountSummary; status: AccountMailStatus | undefined }) {
  if (account.status !== "active") return <span className="text-[var(--danger)]">mail sync paused: reconnect needed</span>;
  if (!status) return <span>mail sync not started yet</span>;
  const phase = status.resyncing && status.backfillStatus !== "complete" ? `catching up (${PHASES[status.backfillStatus]})` : PHASES[status.backfillStatus];
  return (
    <span>
      {phase}
      {status.queued > 0 && `, ${status.queued.toLocaleString()} queued`}
      {status.lastHistorySyncAt && (
        <>
          {" "}
          · last synced <LocalTime iso={status.lastHistorySyncAt.toISOString()} />
        </>
      )}
      {status.lastError && status.lastError !== REAUTH_MARK && (
        <span className="text-[var(--danger)]"> · last error: {status.lastError}</span>
      )}
    </span>
  );
}
