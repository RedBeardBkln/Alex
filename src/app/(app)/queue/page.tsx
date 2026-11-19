import Link from "next/link";
import { db } from "@/db";
import { listItems, QUEUE_TABS, type QueueTab } from "@/lib/approvals/service";
import { requireUser } from "@/lib/session";
import { LocalTime } from "../../local-time";

export const dynamic = "force-dynamic";

const TAB_LABELS: Record<QueueTab, string> = { pending: "Pending", attention: "Needs attention", done: "Done" };
const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for approval",
  approved: "Approved",
  executing: "Sending",
  succeeded: "Sent",
  failed: "Not sent",
  unknown: "Outcome unknown",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const { tab: rawTab } = await searchParams;
  const tab: QueueTab = rawTab && Object.hasOwn(QUEUE_TABS, rawTab) ? (rawTab as QueueTab) : "pending";
  const rows = await listItems(db(), user.id, tab);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Approval queue</h1>
      <p className="text-sm text-[var(--muted)]">Nothing is sent until you approve it here.</p>
      <nav className="flex gap-4 text-sm">
        {(Object.keys(QUEUE_TABS) as QueueTab[]).map((t) => (
          <Link key={t} href={`/queue?tab=${t}`} className={t === tab ? "font-semibold underline" : "underline-offset-4 hover:underline"}>
            {TAB_LABELS[t]}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">Nothing here.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          {rows.map((r) => {
            const p = r.payload as { to?: string[]; cc?: string[]; subject?: string };
            const recipients = [...(p.to ?? []), ...(p.cc ?? [])];
            return (
              <li key={r.id}>
                <Link href={`/queue/${r.id}`} className="block p-3 text-sm hover:bg-[var(--bg)]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{p.subject || "(no subject)"}</span>
                    <span className="text-xs text-[var(--muted)]">{STATUS_LABEL[r.status]}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[var(--muted)]">
                    <span>Email reply</span>
                    {r.accountLabel && (
                      <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs">{r.accountLabel === "business" ? "Business" : "Personal"}</span>
                    )}
                    <span className="font-mono">
                      {recipients[0] ?? ""}
                      {recipients.length > 1 ? ` +${recipients.length - 1}` : ""}
                    </span>
                    <span>
                      created <LocalTime iso={r.createdAt.toISOString()} />, updated <LocalTime iso={r.updatedAt.toISOString()} />
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
