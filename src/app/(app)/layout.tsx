import { db } from "@/db";
import { countNeedingOwner } from "@/lib/approvals/service";
import { requireUser } from "@/lib/session";
import { countDueForNav } from "@/lib/tasks/service";
import { effectiveZone } from "@/lib/tasks/time";
import { signOut } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [waiting, due] = await Promise.all([
    countNeedingOwner(db(), user.id),
    // Phase T: overdue plus due today in the owner's zone. Nav links are plain <a> (full page loads)
    // and task actions revalidate the layout, so this is fresh on every navigation.
    countDueForNav(db(), user.id, new Date(), effectiveZone(user).zone),
  ]);
  const dueTotal = due.overdue + due.today;
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="flex items-center justify-between border-b border-[var(--border)] pb-4">
        <nav className="flex items-center gap-4">
          <span className="text-xl font-semibold">Alex</span>
          <a href="/inbox" className="text-sm underline-offset-4 hover:underline">
            Inbox
          </a>
          <a href="/compose" className="text-sm underline-offset-4 hover:underline">
            Compose
          </a>
          <a href="/tasks" className="text-sm underline-offset-4 hover:underline">
            Tasks
            {dueTotal > 0 && (
              <span
                className={`ml-1 rounded-full px-1.5 py-0.5 text-xs text-[var(--bg)] ${due.overdue > 0 ? "bg-[var(--danger)]" : "bg-[var(--accent)]"}`}
                aria-label={`${dueTotal} due`}
              >
                {dueTotal}
              </span>
            )}
          </a>
          <a href="/queue" className="text-sm underline-offset-4 hover:underline">
            Queue
            {waiting > 0 && (
              <span className="ml-1 rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-xs text-[var(--bg)]" aria-label={`${waiting} waiting`}>
                {waiting}
              </span>
            )}
          </a>
          <a href="/ai-usage" className="text-sm underline-offset-4 hover:underline">
            AI usage
          </a>
          <a href="/" className="text-sm underline-offset-4 hover:underline">
            Accounts
          </a>
        </nav>
        <div className="flex items-center gap-3 text-sm text-[var(--muted)]">
          <span className="hidden sm:inline">{user.email}</span>
          <a href="/settings" className="underline">
            Settings
          </a>
          <form action={signOut}>
            <button className="underline">Sign out</button>
          </form>
        </div>
      </header>
      <main className="pt-6">{children}</main>
    </div>
  );
}
