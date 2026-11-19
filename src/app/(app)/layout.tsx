import { db } from "@/db";
import { countNeedingOwner } from "@/lib/approvals/service";
import { requireUser } from "@/lib/session";
import { signOut } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const waiting = await countNeedingOwner(db(), user.id);
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="flex items-center justify-between border-b border-[var(--border)] pb-4">
        <nav className="flex items-center gap-4">
          <span className="text-xl font-semibold">Alex</span>
          <a href="/inbox" className="text-sm underline-offset-4 hover:underline">
            Inbox
          </a>
          <a href="/queue" className="text-sm underline-offset-4 hover:underline">
            Queue
            {waiting > 0 && (
              <span className="ml-1 rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-xs text-[var(--bg)]" aria-label={`${waiting} waiting`}>
                {waiting}
              </span>
            )}
          </a>
          <a href="/" className="text-sm underline-offset-4 hover:underline">
            Accounts
          </a>
        </nav>
        <div className="flex items-center gap-3 text-sm text-[var(--muted)]">
          <span className="hidden sm:inline">{user.email}</span>
          <form action={signOut}>
            <button className="underline">Sign out</button>
          </form>
        </div>
      </header>
      <main className="pt-6">{children}</main>
    </div>
  );
}
