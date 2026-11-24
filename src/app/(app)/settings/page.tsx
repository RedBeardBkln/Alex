import { requireUser } from "@/lib/session";
import { effectiveZone, supportedZones } from "@/lib/tasks/time";
import { setTimeZoneAction } from "./actions";
import { BrowserZoneButton } from "./browser-zone-button";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = { saved: "Time zone saved." };
const ERRORS: Record<string, string> = {
  zone_invalid: "Alex doesn't recognise that time zone. Pick one from the list, or type a name such as Europe/London. Nothing was saved.",
};

const pick = (table: Record<string, string>, key: unknown) => (typeof key === "string" && Object.hasOwn(table, key) ? table[key]! : null);

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const user = await requireUser();
  const params = await searchParams;
  const { zone, set } = effectiveZone(user);
  const zones = supportedZones();
  if (set && !zones.includes(zone)) zones.unshift(zone);
  const notice = pick(NOTICES, params.notice);
  const error = pick(ERRORS, params.error);

  return (
    <div className="space-y-6">
      {notice && (
        <p role="status" className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-[var(--warn-bg)] px-3 py-2 text-sm">
          {error}
        </p>
      )}
      <section>
        <h1 className="text-2xl font-semibold">Settings</h1>
      </section>

      <section className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="text-lg font-semibold">Time zone</h2>
        <p className="text-sm text-[var(--muted)]">
          {set
            ? `Alex uses ${zone} for task deadlines and for what counts as today.`
            : typeof user.timeZone === "string"
              ? "Alex doesn't recognise your saved time zone, so it is using UTC. Pick it again below."
              : "Your time zone isn't set, so Alex is using UTC. Pick yours below."}{" "}
          A task with a date and time keeps the zone it was entered in.
        </p>
        <form action={setTimeZoneAction} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="zone" className="font-medium">
              Zone
            </label>
            <select id="zone" name="zone" defaultValue={set ? zone : "UTC"} className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1">
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
            <BrowserZoneButton selectId="zone" textId="zone_text" />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="zone_text">Or type a zone name</label>
            <input
              id="zone_text"
              name="zone_text"
              maxLength={64}
              placeholder="e.g. Asia/Kolkata"
              className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1"
            />
            <span className="text-[var(--muted)]">(used instead of the list when filled in)</span>
          </div>
          <button className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--bg)]">Save</button>
        </form>
      </section>
    </div>
  );
}
