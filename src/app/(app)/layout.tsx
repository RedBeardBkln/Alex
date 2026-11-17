import { requireUser } from "@/lib/session";
import { signOut } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="flex items-center justify-between border-b border-[var(--border)] pb-4">
        <span className="text-xl font-semibold">Alex</span>
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
