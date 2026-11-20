import { db } from "@/db";
import { listAccounts } from "@/lib/accounts";
import { requireUser } from "@/lib/session";
import { ComposeForm } from "./compose-form";

export const dynamic = "force-dynamic";

/**
 * Compose a new email (Phase 2d, plan §6.1). Saving creates a pending approval item; nothing is
 * sent until the owner ticks every recipient and approves it in the Queue.
 *
 * The page reads no searchParams: no URL, thread or model output can fill any field (owner
 * constraint 1). The owner picks the sending account; none is preselected (constraint 2).
 */
export default async function ComposePage() {
  const user = await requireUser();
  const accounts = (await listAccounts(db(), user.id))
    .filter((a) => a.provider === "google")
    .map((a) => ({ id: a.id, email: a.email, label: a.label, active: a.status === "active" }));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">New email</h1>
      <p className="text-sm text-[var(--muted)]">Plain text only. Nothing is sent until you approve it in the Queue.</p>
      {accounts.length === 0 ? (
        <p className="text-sm">
          Connect a Google account on the{" "}
          <a href="/" className="underline">
            Accounts
          </a>{" "}
          page first.
        </p>
      ) : (
        <ComposeForm accounts={accounts} />
      )}
    </div>
  );
}
