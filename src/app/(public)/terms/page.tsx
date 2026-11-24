import type { Metadata } from "next";
import { LAST_UPDATED, OWNER_CONTACT } from "../site-info";

// Terms of use (Google Auth Platform Branding: "Application terms of service link"). Static.
export const dynamic = "error";

export const metadata: Metadata = { title: "Terms · Alex" };

export default function TermsPage() {
  return (
    <article className="space-y-4">
      <h1 className="text-2xl font-semibold">Terms of use</h1>
      <p className="text-sm text-[var(--muted)]">Last updated: {LAST_UPDATED}</p>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <strong>What Alex is.</strong> Alex is a personal tool that its owner built and runs for their own email. It
          isn&apos;t offered to the public, and there are no customer accounts.
        </li>
        <li>
          <strong>Who may use it.</strong> Only Google accounts on the owner&apos;s allow list can sign in. Anyone else is
          refused at sign-in.
        </li>
        <li>
          <strong>Your Google data.</strong> How Alex uses Google account data is described in the{" "}
          <a href="/privacy" className="underline">
            privacy policy
          </a>
          . You can remove Alex&apos;s access from your Google Account at any time.
        </li>
        <li>
          <strong>AI can be wrong.</strong> Summaries, categories and drafts are written by an AI model and may be
          inaccurate. Alex never sends anything by itself: the owner reviews and approves every email and is responsible
          for what is sent.
        </li>
        <li>
          <strong>No guarantees.</strong> Alex is provided as is, without any warranty, and may change or stop at any
          time.
        </li>
        <li>
          <strong>Changes.</strong> These terms may be updated; the date at the top shows the latest version.
        </li>
        <li>
          <strong>Contact.</strong> {OWNER_CONTACT}
        </li>
      </ol>
    </article>
  );
}
