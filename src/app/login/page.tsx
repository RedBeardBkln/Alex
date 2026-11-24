import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";

const ERRORS: Record<string, string> = {
  not_allowed: "That Google account isn't allowed to sign in to Alex.",
  cancelled: "Sign-in was cancelled.",
  state: "Sign-in expired or was tampered with. Please try again.",
  google: "Google sign-in failed. Please try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect("/");
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="text-3xl font-semibold">Alex</h1>
      <p className="mt-1 text-[var(--muted)]">Your executive assistant.</p>
      {error && ERRORS[error] && (
        <p role="alert" className="mt-6 rounded-md border border-[var(--border)] bg-[var(--warn-bg)] px-3 py-2 text-sm">
          {ERRORS[error]}
        </p>
      )}
      <a
        href="/api/auth/google"
        className="mt-8 inline-flex justify-center rounded-md bg-[var(--accent)] px-4 py-2.5 font-medium text-[var(--bg)]"
      >
        Sign in with Google
      </a>
      <nav className="mt-10 text-center text-sm text-[var(--muted)]">
        <a href="/about" className="underline-offset-4 hover:underline">
          About
        </a>
        {" · "}
        <a href="/privacy" className="underline-offset-4 hover:underline">
          Privacy
        </a>
        {" · "}
        <a href="/terms" className="underline-offset-4 hover:underline">
          Terms
        </a>
      </nav>
    </main>
  );
}
