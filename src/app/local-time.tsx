"use client";

const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Formats a timestamp in the viewer's own time zone (the server runs in UTC). */
export function LocalTime({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {fmt.format(new Date(iso))}
    </time>
  );
}
