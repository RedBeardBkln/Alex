import { db, schema } from "@/db";

export async function audit(entry: {
  userId: string | null;
  accountId?: string | null;
  action: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await db()
    .insert(schema.auditLog)
    .values({ userId: entry.userId, accountId: entry.accountId ?? null, action: entry.action, detail: entry.detail });
}
