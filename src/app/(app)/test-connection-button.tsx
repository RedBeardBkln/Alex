"use client";

import { useActionState } from "react";
import { testConnection, type CheckResult } from "./actions";

export function TestConnectionButton({ accountId }: { accountId: string }) {
  const [result, action, pending] = useActionState<CheckResult, FormData>(testConnection, null);
  return (
    <form action={action} className="contents">
      <input type="hidden" name="accountId" value={accountId} />
      <button disabled={pending} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-60">
        {pending ? "Checking…" : "Test connection"}
      </button>
      {result && (
        <p role="status" className={`basis-full text-sm ${result.ok ? "text-[var(--accent)]" : "text-[var(--danger)]"}`}>
          {result.message}
        </p>
      )}
    </form>
  );
}
