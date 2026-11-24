"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { guardedWrite } from "@/lib/tasks/errors";
import { storedDueFields } from "@/lib/tasks/format";
import { acceptSuggestion, completeTask, createTask, deleteTask, dismissSuggestion, getTaskForEdit, reopenTask, updateTask } from "@/lib/tasks/service";
import { effectiveZone, normalizeTimeZone } from "@/lib/tasks/time";
import { DUE_KINDS, NOTES_FORM_MAX, PRIORITIES, TITLE_FORM_MAX, parseTaskInput, type TaskFormFields, type TaskInputError } from "@/lib/tasks/validate";
import { requireActionUser } from "../action-guard";

// Phase T (plan sections 8 and 9). Every action: sign-in plus the strict Origin check first; form
// input through zod safeParse, refusals as fixed codes in the URL (typed text never goes into a
// URL); each write wrapped by guardedWrite, so a database error is logged content-free and replaced
// by a fixed error; revalidatePath and redirect only after the write.

const taskFormSchema = z.object({
  title: z.string().max(TITLE_FORM_MAX),
  notes: z.string().max(NOTES_FORM_MAX),
  priority: z.enum(PRIORITIES),
  kind: z.enum(DUE_KINDS),
  date: z.string().max(32),
  time: z.string().max(32),
});

const idSchema = z.uuid();
const returnSchema = z.enum(["list", "done", "detail"]).catch("list");

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

function readTaskForm(formData: FormData): { ok: true; value: TaskFormFields } | { ok: false; error: TaskInputError } {
  const r = taskFormSchema.safeParse({
    title: field(formData, "title"),
    notes: field(formData, "notes"),
    priority: field(formData, "priority") || "normal",
    kind: field(formData, "due_kind") || "none",
    date: field(formData, "due_date"),
    time: field(formData, "due_time"),
  });
  if (r.success) return { ok: true, value: r.data };
  const path = r.error.issues[0]?.path[0];
  return { ok: false, error: path === "title" ? "title_too_long" : path === "notes" ? "notes_too_long" : "form_invalid" };
}

function readId(formData: FormData, name: string): string | null {
  const r = idSchema.safeParse(formData.get(name));
  return r.success ? r.data : null;
}

/** Where a quick action returns to: the list, the Done view or the task's own page. */
function destination(ret: "list" | "done" | "detail", taskId: string, notice?: "stale"): string {
  if (notice) return ret === "done" ? "/tasks?view=done&notice=stale" : "/tasks?notice=stale";
  if (ret === "done") return "/tasks?view=done";
  if (ret === "detail") return `/tasks/${taskId}`;
  return "/tasks";
}

/** New task from /tasks. */
export async function createTaskAction(formData: FormData) {
  const user = await requireActionUser();
  const form = readTaskForm(formData);
  if (!form.ok) redirect(`/tasks?error=${form.error}`);
  const parsed = parseTaskInput(form.value, effectiveZone(user).zone);
  if (!parsed.ok) redirect(`/tasks?error=${parsed.error}`);
  await guardedWrite("createTask", () => createTask(db(), { userId: user.id, task: parsed.value, now: new Date() }));
  revalidatePath("/", "layout");
  redirect("/tasks?notice=saved");
}

/**
 * "Add task" on a thread page. Only the thread id comes from the form; the account is read from
 * the thread row on the server, and the subject is never posted (the title is what the owner saved).
 */
export async function createTaskFromThreadAction(formData: FormData) {
  const user = await requireActionUser();
  const threadId = readId(formData, "threadId");
  if (!threadId) redirect("/inbox?notice=task_thread_gone");
  const back = (code: string) => `/inbox/${threadId}?task=1&task_error=${code}#task`;
  const form = readTaskForm(formData);
  if (!form.ok) redirect(back(form.error));
  const parsed = parseTaskInput(form.value, effectiveZone(user).zone);
  if (!parsed.ok) redirect(back(parsed.error));
  const result = await guardedWrite("createTaskFromThread", () =>
    createTask(db(), { userId: user.id, task: parsed.value, threadId, now: new Date() }),
  );
  if (!result.ok) redirect("/inbox?notice=task_thread_gone");
  revalidatePath("/", "layout");
  redirect("/tasks?notice=saved");
}

/**
 * Edit an open or done task. A date-time deadline keeps the zone it was entered in (owner Q4).
 * Leftover deadline fields equal to what the edit page pre-filled for the current row don't count
 * as filled in for None or Date (round 3); the create forms stay strict.
 */
export async function updateTaskAction(formData: FormData) {
  const user = await requireActionUser();
  const taskId = readId(formData, "taskId");
  if (!taskId) redirect("/tasks?notice=stale");
  const form = readTaskForm(formData);
  if (!form.ok) redirect(`/tasks/${taskId}?error=${form.error}`);
  const current = await getTaskForEdit(db(), user.id, taskId);
  if (!current || (current.status !== "open" && current.status !== "done")) redirect("/tasks?notice=stale");
  const owner = effectiveZone(user).zone;
  const zone = current.dueTz !== null ? (normalizeTimeZone(current.dueTz) ?? owner) : owner;
  const prefill = storedDueFields(current, owner);
  const parsed = parseTaskInput(form.value, zone, { date: prefill.date, time: prefill.time });
  if (!parsed.ok) redirect(`/tasks/${taskId}?error=${parsed.error}`);
  const result = await guardedWrite("updateTask", () => updateTask(db(), { userId: user.id, taskId, task: parsed.value, now: new Date() }));
  if (!result.ok) redirect("/tasks?notice=stale");
  revalidatePath("/", "layout");
  redirect(`/tasks/${taskId}?notice=saved`);
}

type Transition = typeof completeTask;

async function runTransition(userId: string, formData: FormData, name: string, fn: Transition): Promise<string> {
  const taskId = readId(formData, "taskId");
  const ret = returnSchema.parse(field(formData, "return"));
  if (!taskId) return destination(ret, "", "stale");
  const result = await guardedWrite(name, () => fn(db(), userId, taskId, new Date()));
  if (!result.ok) return destination(ret, taskId, "stale");
  revalidatePath("/", "layout");
  return destination(ret, taskId);
}

export async function completeTaskAction(formData: FormData) {
  const user = await requireActionUser();
  redirect(await runTransition(user.id, formData, "completeTask", completeTask));
}

export async function reopenTaskAction(formData: FormData) {
  const user = await requireActionUser();
  redirect(await runTransition(user.id, formData, "reopenTask", reopenTask));
}

export async function acceptSuggestionAction(formData: FormData) {
  const user = await requireActionUser();
  redirect(await runTransition(user.id, formData, "acceptSuggestion", acceptSuggestion));
}

export async function dismissSuggestionAction(formData: FormData) {
  const user = await requireActionUser();
  redirect(await runTransition(user.id, formData, "dismissSuggestion", dismissSuggestion));
}

/** Hard delete (owner Q9): only with the "Yes, delete this task" box ticked in the same form. */
export async function deleteTaskAction(formData: FormData) {
  const user = await requireActionUser();
  const taskId = readId(formData, "taskId");
  if (!taskId) redirect("/tasks?notice=stale");
  if (field(formData, "confirm") !== "yes") redirect(`/tasks/${taskId}?error=confirm_delete`);
  const result = await guardedWrite("deleteTask", () => deleteTask(db(), user.id, taskId));
  if (!result.ok) redirect("/tasks?notice=stale");
  revalidatePath("/", "layout");
  redirect("/tasks?notice=deleted");
}
