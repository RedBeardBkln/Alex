"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { setTimeZone } from "@/lib/settings";
import { guardedWrite } from "@/lib/tasks/errors";
import { normalizeTimeZone } from "@/lib/tasks/time";
import { requireActionUser } from "../action-guard";

/**
 * Saves the owner's time zone (Phase T, plan 6.1). The typed name (`zone_text`, filled by the
 * "Use this browser's zone" button when the browser's name isn't in the list) wins over the select.
 * Either way it is validated and canonicalised on the server; an unknown name is refused by code.
 */
export async function setTimeZoneAction(formData: FormData) {
  const user = await requireActionUser();
  const typed = formData.get("zone_text");
  const picked = formData.get("zone");
  const raw = typeof typed === "string" && typed.trim() !== "" ? typed : typeof picked === "string" ? picked : "";
  const zone = raw.length <= 200 ? normalizeTimeZone(raw) : null;
  if (!zone) redirect("/settings?error=zone_invalid");
  await guardedWrite("setTimeZone", () => setTimeZone(db(), user.id, zone));
  revalidatePath("/", "layout");
  redirect("/settings?notice=saved");
}
