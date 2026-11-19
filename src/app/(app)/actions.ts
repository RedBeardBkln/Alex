"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { deleteAccount, getAccount, ReauthRequiredError, setLabel } from "@/lib/accounts";
import { audit } from "@/lib/audit";
import { accountDisconnectedDetail } from "@/lib/audit-details";
import { decrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { gmailClientFor } from "@/lib/gmail/runtime";
import { stopWatchBeforeDisconnect } from "@/lib/gmail/watch-stop";
import { googleClient } from "@/lib/google";
import { checkGoogleConnection } from "@/lib/google-api";
import { destroySession, requireUser } from "@/lib/session";

const idSchema = z.uuid();

export async function signOut() {
  await destroySession();
  redirect("/login");
}

export async function updateLabel(formData: FormData) {
  const user = await requireUser();
  const id = idSchema.parse(formData.get("accountId"));
  const label = z.enum(["personal", "business"]).parse(formData.get("label"));
  if (await setLabel(db(), user.id, id, label)) {
    await audit({ userId: user.id, accountId: id, action: "account.label_changed", detail: { label } });
  }
  revalidatePath("/");
}

export async function disconnect(formData: FormData) {
  const user = await requireUser();
  const id = idSchema.parse(formData.get("accountId"));
  const account = await getAccount(db(), user.id, id);
  if (!account) return;
  // Stop Gmail push notifications (best-effort; never blocks the disconnect).
  await stopWatchBeforeDisconnect(db(), account, gmailClientFor(account));
  // Revoke at Google first so the grant disappears from the user's Google security settings too.
  const token = account.refreshTokenEnc ?? account.accessTokenEnc;
  if (token) {
    await googleClient("connect")
      .revokeToken(decrypt(token, env().ALEX_ENCRYPTION_KEY))
      .catch((err) => console.warn("Google token revocation failed; deleting locally anyway", err));
  }
  // Deleting the account also deletes its stored mail (ON DELETE CASCADE).
  await deleteAccount(db(), user.id, id);
  await audit({ userId: user.id, action: "account.disconnected", detail: accountDisconnectedDetail(account) });
  revalidatePath("/");
}

export type CheckResult = { ok: true; message: string } | { ok: false; message: string } | null;

export async function testConnection(_prev: CheckResult, formData: FormData): Promise<CheckResult> {
  const user = await requireUser();
  const id = idSchema.parse(formData.get("accountId"));
  const account = await getAccount(db(), user.id, id);
  if (!account) return { ok: false, message: "Account not found." };
  try {
    const r = await checkGoogleConnection(account);
    return {
      ok: true,
      message: `Working: Gmail reports ${r.gmailMessagesTotal.toLocaleString()} messages; ${r.calendars} calendars visible.`,
    };
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      revalidatePath("/");
      return { ok: false, message: "Google no longer accepts this connection. Reconnect the account." };
    }
    console.error("Connection check failed", err);
    return { ok: false, message: "Check failed. See server logs for details." };
  }
}
