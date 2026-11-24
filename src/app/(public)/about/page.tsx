import type { Metadata } from "next";
import { OWNER_CONTACT } from "../site-info";

// The app's public home page (Google Auth Platform Branding: "Application home page"). Static.
export const dynamic = "error";

export const metadata: Metadata = { title: "About · Alex" };

export default function AboutPage() {
  return (
    <article className="space-y-4">
      <h1 className="text-2xl font-semibold">Alex</h1>
      <p>
        Alex is a private email assistant. Its owner, a single person, built it for their own use and runs it at
        alex.ericandeva.com. It isn&apos;t a public service, and you can&apos;t sign up for it.
      </p>

      <h2 className="pt-2 text-lg font-semibold">What Alex does</h2>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <strong>One inbox for several Google accounts.</strong> Alex brings mail from the owner&apos;s connected Gmail
          accounts into one place. Each message stays tied to the account that received it.
        </li>
        <li>
          <strong>Sorting and summaries.</strong> Alex uses an AI model (Anthropic&apos;s Claude) to sort new mail into
          categories such as &quot;needs reply&quot; or &quot;newsletter&quot; and to write a one-line summary. It never
          moves, hides or deletes anything in Gmail.
        </li>
        <li>
          <strong>Reply drafts and new emails.</strong> The owner can write replies and new emails, or ask Alex to draft
          a reply with AI.
        </li>
        <li>
          <strong>Nothing is sent without approval.</strong> Every email Alex prepares goes into an approval queue. It is
          sent only after the owner reviews it and clicks approve. Every proposal, approval, rejection and send is
          recorded.
        </li>
      </ul>
      <p>
        Alex also asks for access to Google Calendar and Google Drive, for scheduling and file features. Today it uses
        Calendar only to check that the connection works, and it doesn&apos;t use Drive yet.
      </p>

      <h2 className="pt-2 text-lg font-semibold">More</h2>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <a href="/privacy" className="underline">
            Privacy policy
          </a>
          : what Alex reads, stores and shares, and how to delete it.
        </li>
        <li>
          <a href="/terms" className="underline">
            Terms of use
          </a>
        </li>
        <li>
          <a href="/login" className="underline">
            Owner sign-in
          </a>
        </li>
      </ul>
      <p>Questions: {OWNER_CONTACT}</p>
    </article>
  );
}
