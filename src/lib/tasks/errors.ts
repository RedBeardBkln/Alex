import { errorName, sqlState } from "@/lib/pg-errors";

/**
 * Content-free errors for the task and settings Server Actions (Phase T, plan section 8). A
 * Drizzle query error's message includes the bound parameters (a task's title and notes), and
 * Next.js logs an uncaught Server Action error with its message. So every write in those actions
 * is wrapped: the original error is logged only as `{action, error, code}` and replaced by
 * `TaskActionError`, whose message is fixed and which carries no `cause`.
 */
export const TASK_ACTION_ERROR_MESSAGE = "Alex couldn't save that change. Nothing was saved.";

export class TaskActionError extends Error {
  constructor() {
    super(TASK_ACTION_ERROR_MESSAGE);
    this.name = "TaskActionError";
  }
}

/** Logs the action name, the error's class name and its SQLSTATE, never its message or cause. */
export function logTaskActionError(action: string, err: unknown): void {
  console.error("task action failed", { action, error: errorName(err), code: sqlState(err) });
}

/**
 * Runs one write and returns its result. On any error: logs it content-free and throws a fresh
 * `TaskActionError` (the original error is dropped, not chained).
 */
export async function guardedWrite<T>(action: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    logTaskActionError(action, err);
    throw new TaskActionError();
  }
}
