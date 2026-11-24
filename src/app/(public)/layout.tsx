// Public pages (/about, /privacy, /terms). Static content only: this layout and its pages must not
// read the session, cookies, headers or the database, and must import nothing from src/lib or src/db
// (tests/public-pages.test.ts).

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="border-b border-[var(--border)] pb-4">
        <a href="/about" className="text-xl font-semibold">
          Alex
        </a>
      </header>
      <main className="pt-6">{children}</main>
      <footer className="mt-10 flex flex-wrap gap-4 border-t border-[var(--border)] pt-4 text-sm text-[var(--muted)]">
        <a href="/about" className="underline-offset-4 hover:underline">
          About
        </a>
        <a href="/privacy" className="underline-offset-4 hover:underline">
          Privacy
        </a>
        <a href="/terms" className="underline-offset-4 hover:underline">
          Terms
        </a>
        <a href="/login" className="underline-offset-4 hover:underline">
          Owner sign-in
        </a>
      </footer>
    </div>
  );
}
