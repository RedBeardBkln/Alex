import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { timeZoneChangedDetail } from "@/lib/tasks/audit-details";

/**
 * Sets the owner's time zone (Phase T). `zone` must already be a canonical name from
 * `normalizeTimeZone` (src/lib/tasks/time.ts). One transaction: the UPDATE, only when the value
 * changes, plus `settings.time_zone_changed {}` (the zone itself isn't audited). No account lock:
 * nothing here references an account. Returns whether the value changed.
 */
export async function setTimeZone(ex: Executor, userId: string, zone: string): Promise<boolean> {
  return ex.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ timeZone: zone })
      .where(and(eq(users.id, userId), sql`${users.timeZone} IS DISTINCT FROM ${zone}`))
      .returning({ id: users.id });
    if (!row) return false;
    await audit({ userId, accountId: null, action: "settings.time_zone_changed", detail: timeZoneChangedDetail() }, tx);
    return true;
  });
}
