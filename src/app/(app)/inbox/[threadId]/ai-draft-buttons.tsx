"use client";

import { useFormStatus } from "react-dom";

/**
 * The draft form's submit buttons (review round 1, D4): disabled while the draft is being written,
 * so a second click can't queue a second Opus call. The server also refuses a second draft for the
 * same thread while one is in flight.
 */
export function AiDraftButtons() {
  const { pending } = useFormStatus();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button name="mode" value="reply" disabled={pending} className="rounded-md border border-[var(--border)] px-3 py-1.5 disabled:opacity-50">
        Draft reply with AI
      </button>
      <button name="mode" value="all" disabled={pending} className="rounded-md border border-[var(--border)] px-3 py-1.5 disabled:opacity-50">
        Draft reply all with AI
      </button>
      {pending && <span role="status">Drafting… this can take up to a minute.</span>}
    </div>
  );
}
