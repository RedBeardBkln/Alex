import type { Metadata } from "next";
import { LAST_UPDATED, OWNER_CONTACT } from "../site-info";

// Privacy policy (Google Auth Platform Branding: "Application privacy policy link"). Static.
// Keep it true: any change to what Alex reads, stores, sends to the AI or shares must update this
// page (and LAST_UPDATED) before it ships.
export const dynamic = "error";

export const metadata: Metadata = { title: "Privacy · Alex" };

const USER_DATA_POLICY = "https://developers.google.com/terms/api-services-user-data-policy";
const LIMITED_USE = "https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes";

const h2 = "pt-2 text-lg font-semibold";
const list = "list-disc space-y-2 pl-5";

export default function PrivacyPage() {
  return (
    <article className="space-y-4">
      <h1 className="text-2xl font-semibold">Privacy policy</h1>
      <p className="text-sm text-[var(--muted)]">Last updated: {LAST_UPDATED}</p>
      <p>
        Alex is a private assistant that its owner uses for their own email. Only Google accounts on the owner&apos;s
        allow list can sign in. Nobody else has an account. This page explains what Alex does with Google account data,
        and with the email of people who write to the owner.
      </p>

      <h2 className={h2}>What Alex accesses in Google accounts</h2>
      <p>
        <strong>Sign-in</strong> (<code>openid</code>, <code>email</code>, <code>profile</code>): your Google account ID,
        email address and name, used to check that you&apos;re allowed in.
      </p>
      <p>When the owner connects a Google account, Alex asks for:</p>
      <ul className={list}>
        <li>
          <strong>Gmail</strong> (<code>gmail.modify</code>). Alex:
          <ul className="mt-2 list-[circle] space-y-1 pl-5">
            <li>
              reads messages in the Inbox from the last 30 days, then messages as they arrive in the Inbox, including
              older ones moved back into it (through Gmail&apos;s new-mail notifications, with a check every 5 minutes);
            </li>
            <li>reads sent messages, but only in conversations Alex already holds, plus emails Alex itself sent;</li>
            <li>
              reads the signature set in Gmail&apos;s settings for each connected address (every 5 minutes) and adds a
              plain-text copy of it to every email Alex sends: its text, with link addresses written out, but no images
              or formatting;
            </li>
            <li>
              sends an email <strong>only after the owner approves it</strong> in Alex&apos;s approval queue.
            </li>
          </ul>
          <p className="mt-2">
            Alex doesn&apos;t store drafts, spam or trash that it sees arrive, doesn&apos;t download attachment files (it
            keeps only their names, types and sizes), and doesn&apos;t change labels, archive, delete or mark anything as
            read in Gmail.
          </p>
        </li>
        <li>
          <strong>Google Calendar</strong> (<code>calendar.readonly</code>, <code>calendar.events</code>). Today Alex only
          lists your calendars to confirm the connection works (&quot;Test connection&quot;). It doesn&apos;t read or create
          events yet.
        </li>
        <li>
          <strong>Google Drive</strong> (<code>drive.file</code>). This only covers files Alex creates or that you open
          with Alex. Alex doesn&apos;t use it yet.
        </li>
      </ul>
      <p>If Alex starts using Calendar or Drive for more than this, this page will be updated before it does.</p>

      <h2 className={h2}>What Alex stores</h2>
      <p>Alex keeps its data in its own database (Postgres hosted by Neon), and the app runs on Vercel. It stores:</p>
      <ul className={list}>
        <li>your sign-in account: email address and name;</li>
        <li>
          for each connected account: the email address, display name, Google account ID, the permissions granted, and
          the access and refresh tokens, <strong>encrypted</strong> (AES-256-GCM);
        </li>
        <li>
          for each connected account, a plain-text copy of its Gmail signature (not the original formatting) and when
          Alex last checked it;
        </li>
        <li>
          the email it reads: headers (sender, recipients, subject, date), the text and HTML of the message, a cleaned-up
          copy for safe display, Gmail&apos;s labels, and attachment names, types and sizes;
        </li>
        <li>AI results: each message&apos;s category and a summary of up to 200 characters;</li>
        <li>
          the approval queue: emails waiting for approval, approved, sent, rejected or cancelled, with their recipients
          and text, including the signature;
        </li>
        <li>
          tasks the owner writes: title, notes, deadline and priority, and the owner&apos;s time-zone setting. A task the
          owner creates from an email starts with that email&apos;s subject as its title (the owner can change it) and
          links to the conversation;
        </li>
        <li>
          a usage log of AI calls: token counts, cost and timing, with <strong>no email content</strong>;
        </li>
        <li>
          an activity log of actions (sign-ins, connections, approvals, sends, errors). New entries hold no email
          addresses, subjects or message text.{" "}
          <strong>Entries written before late November 2026 may include email addresses.</strong>
        </li>
        <li>
          a sign-in cookie (a random token; Alex stores only its hash) that lasts 30 days, and a short-lived cookie during
          Google sign-in. Alex sets no advertising or analytics cookies.
        </li>
      </ul>

      <h2 className={h2}>AI processing (Anthropic)</h2>
      <p>Alex uses Anthropic&apos;s Claude API for two features:</p>
      <ul className={list}>
        <li>
          <strong>Sorting</strong> happens automatically. New Inbox messages from the last 3 days are sent one at a time
          (sender, date, subject and message text, cut to a fixed size) so Claude can sort and summarise them.
        </li>
        <li>
          <strong>Drafting</strong> happens only when the owner clicks &quot;Draft reply with AI&quot;. The text of that one
          conversation is sent (cut to a fixed size), along with any instruction the owner types. Alex doesn&apos;t send
          its stored copy of the owner&apos;s signature; a signature that is part of a message in the conversation
          (including emails Alex sent) is sent as part of that text.
        </li>
      </ul>
      <p>
        Alex doesn&apos;t save what it sends to Claude or Claude&apos;s raw answer. It keeps only the category and summary,
        and the draft, which waits in the approval queue. Under Anthropic&apos;s standard API policy, Anthropic deletes
        these inputs and outputs within 30 days, and doesn&apos;t use them to train models without permission. Anthropic
        may keep content flagged by its safety systems for up to 2 years, and may keep data longer where the law
        requires. Alex itself doesn&apos;t use any Google data to train AI models.
      </p>

      <h2 className={h2}>Who Alex shares data with</h2>
      <p>Alex doesn&apos;t sell data, show ads or share data with advertisers or data brokers. Data leaves Alex only:</p>
      <ul className={list}>
        <li>to the services that run it: Vercel (hosting), Neon (database) and Anthropic (the AI features above);</li>
        <li>to Google, to send an email the owner approved;</li>
        <li>where the law requires it.</li>
      </ul>
      <p>No person other than the owner reads your messages in Alex.</p>

      <h2 className={h2}>How long Alex keeps data, and how to delete it</h2>
      <ul className={list}>
        <li>
          Stored email stays until it&apos;s permanently deleted in Gmail (Alex then removes it at its next sync) or until
          the owner disconnects the account. Moving a message to Trash or archiving it doesn&apos;t remove it from Alex.
          There&apos;s no automatic time limit.
        </li>
        <li>
          <strong>Disconnecting</strong> an account in Alex asks Gmail to stop its new-mail notifications, asks Google to
          revoke Alex&apos;s access, and deletes the stored tokens and all of that account&apos;s stored mail, AI results,
          approval-queue items and signature copy. Tasks stay: a task created from that account&apos;s email loses its link to the conversation but keeps its
          title, which may be a copy of the email&apos;s subject. The owner can delete any task.
          <p className="mt-2">
            The activity log and the AI usage log stay, without the account link. They contain no message content. So
            does a daily count of first-time recipients.
          </p>
        </li>
        <li>
          You can also remove Alex&apos;s access from your Google Account&apos;s security settings at any time. Alex then
          stops reading that account, but mail it already stored stays until the account is disconnected in Alex.
        </li>
        <li>People who email the owner can ask about or ask to delete their messages at {OWNER_CONTACT}.</li>
      </ul>

      <h2 className={h2}>Security</h2>
      <p>
        Alex is served over HTTPS. Google tokens are encrypted before they&apos;re stored and never reach the browser.
        Only allow-listed accounts can sign in. Email HTML is cleaned and shown in a locked-down frame with remote images
        blocked by default. Server logs hold technical errors; Alex avoids writing message content to them, but an
        unexpected database error can include the data being saved at that moment.
      </p>

      <h2 className={h2}>Google API Services User Data Policy</h2>
      <p>
        Alex&apos;s use and transfer of information received from Google APIs will adhere to the{" "}
        <a href={USER_DATA_POLICY} rel="noreferrer" className="underline">
          Google API Services User Data Policy
        </a>
        , including the{" "}
        <a href={LIMITED_USE} rel="noreferrer" className="underline">
          Limited Use requirements
        </a>
        .
      </p>

      <h2 className={h2}>Changes and contact</h2>
      <p>
        If Alex starts using Google data in a new way, this page will be updated first, with a new date at the top.
        Questions: {OWNER_CONTACT}.
      </p>
    </article>
  );
}
