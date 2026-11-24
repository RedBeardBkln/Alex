"use client";

import { useEffect, useState } from "react";

/**
 * "Use this browser's zone" (Phase T, plan 6.1). It only fills the form and saves nothing: the
 * select if the browser's zone name is one of its options, otherwise the text field, which the
 * server validates and canonicalises like the select.
 */
export function BrowserZoneButton({ selectId, textId }: { selectId: string; textId: string }) {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    try {
      setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || null);
    } catch {
      setZone(null);
    }
  }, []);
  if (!zone) return null;
  return (
    <button
      type="button"
      className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
      onClick={() => {
        const select = document.getElementById(selectId) as HTMLSelectElement | null;
        const text = document.getElementById(textId) as HTMLInputElement | null;
        if (select && Array.from(select.options).some((o) => o.value === zone)) {
          select.value = zone;
          if (text) text.value = "";
        } else if (text) {
          text.value = zone;
        }
      }}
    >
      Use this browser&apos;s zone ({zone})
    </button>
  );
}
