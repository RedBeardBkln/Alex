import { z } from "zod";
import { isValidAddress } from "@/lib/approvals/addresses";
import { googleRequest, type FetchLike, type TokenProvider } from "@/lib/google-api";

/**
 * Minimal Gmail REST client for ingestion. Shapes follow the Gmail API v1 reference and discovery
 * document (users.getProfile, users.watch, users.stop, users.history.list, users.messages.list,
 * users.messages.get, users.messages.attachments.get, users.settings.sendAs.get).
 *
 * Read-only apart from `watch` and `stop`, which only change push-notification configuration.
 * There is deliberately no send, modify, trash, delete, draft or label call here. The one settings
 * call is a GET of the account's own send-as entry, for its signature (phase email-signatures);
 * nothing here writes Gmail settings.
 */

export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Charset of Gmail message and attachment ids accepted in URLs. */
export const GMAIL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** users.stop timeout in ms (it runs inside the disconnect action). */
export const STOP_TIMEOUT_MS = 5_000;

/** Gmail answered with a non-2xx status. `reason` is Google's machine-readable reason, never message content. */
export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string | null,
    public readonly op: string,
  ) {
    super(`Gmail ${op} failed: ${status}${reason ? ` ${reason}` : ""}`);
    this.name = "GmailApiError";
  }
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** Gmail answered 2xx with a body that doesn't match the documented shape. */
export class GmailShapeError extends Error {
  constructor(public readonly op: string) {
    super(`Gmail ${op} returned an unexpected response shape`);
    this.name = "GmailShapeError";
  }
}

const errorBody = z.object({
  error: z
    .object({
      status: z.string().optional(),
      errors: z.array(z.object({ reason: z.string().optional() })).optional(),
    })
    .optional(),
});

function reasonOf(body: unknown): string | null {
  const parsed = errorBody.safeParse(body);
  if (!parsed.success || !parsed.data.error) return null;
  const reason = parsed.data.error.errors?.[0]?.reason ?? parsed.data.error.status ?? null;
  // Keep it to a short token so nothing descriptive ends up in logs or the audit log.
  return reason && /^[A-Za-z0-9_.-]{1,64}$/.test(reason) ? reason : null;
}

// ---- Response shapes ----

export type MessagePartHeader = { name: string; value: string };
export type MessagePartBody = { attachmentId?: string; size?: number; data?: string };
export type MessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: MessagePartHeader[];
  body?: MessagePartBody;
  parts?: MessagePart[];
};

const headerSchema = z.object({ name: z.string(), value: z.string() });
const bodySchema = z.object({
  attachmentId: z.string().optional(),
  size: z.number().optional(),
  data: z.string().optional(),
});
const partSchema: z.ZodType<MessagePart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(headerSchema).optional(),
    body: bodySchema.optional(),
    parts: z.array(partSchema).optional(),
  }),
);

const profileSchema = z.object({ historyId: z.string(), emailAddress: z.string().optional() });
const watchSchema = z.object({ historyId: z.string(), expiration: z.string() });
const idRef = z.object({ id: z.string(), threadId: z.string().optional(), labelIds: z.array(z.string()).optional() });
const historySchema = z.object({
  id: z.string().optional(),
  messagesAdded: z.array(z.object({ message: idRef })).optional(),
  messagesDeleted: z.array(z.object({ message: idRef })).optional(),
  labelsAdded: z.array(z.object({ message: idRef, labelIds: z.array(z.string()).optional() })).optional(),
  labelsRemoved: z.array(z.object({ message: idRef, labelIds: z.array(z.string()).optional() })).optional(),
});
const historyListSchema = z.object({
  history: z.array(historySchema).optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string(),
});
const messageListSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});
const minimalSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  historyId: z.string().optional(),
});
const fullSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  internalDate: z.string().optional(),
  sizeEstimate: z.number().optional(),
  payload: partSchema.optional(),
});

// users.settings.sendAs resource: only the two fields Alex reads (other keys are stripped).
const sendAsSchema = z.object({ sendAsEmail: z.string(), signature: z.string().optional() });

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** users.settings.sendAs.get result: the entry's HTML signature (null when missing or empty), or a 404. */
export type SendAsResult = { kind: "found"; signature: string | null } | { kind: "not_found" };

export type HistoryRecord = z.infer<typeof historySchema>;
export type HistoryList = z.infer<typeof historyListSchema>;
export type MessageList = z.infer<typeof messageListSchema>;
export type MinimalMessage = z.infer<typeof minimalSchema>;
export type FullMessage = z.infer<typeof fullSchema>;
export type WatchResponse = z.infer<typeof watchSchema>;

export const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] as const;

export interface GmailClient {
  getProfile(): Promise<{ historyId: string }>;
  watch(req: { topicName: string; labelIds: string[]; labelFilterBehavior: string }): Promise<WatchResponse>;
  stop(): Promise<void>;
  /** All four history types, no labelId filter. */
  listHistory(req: { startHistoryId: string; pageToken?: string }): Promise<HistoryList>;
  listMessages(req: { labelIds: string[]; q: string; pageToken?: string }): Promise<MessageList>;
  getMessageMinimal(id: string): Promise<MinimalMessage>;
  getMessageFull(id: string): Promise<FullMessage>;
  /** Only for text/plain or text/html body parts delivered by attachmentId; see `isBodyPart` in mime.ts. */
  getBodyPartData(messageId: string, attachmentId: string): Promise<MessagePartBody>;
  /** GET settings/sendAs/{address}: the signature of the account's own address (phase email-signatures). */
  getSendAs(sendAsEmail: string): Promise<SendAsResult>;
}

export function createGmailClient(getToken: TokenProvider, fetchImpl: FetchLike = fetch): GmailClient {
  async function call<S extends z.ZodType>(
    op: string,
    url: string,
    schema: S | null,
    init: { method?: "GET" | "POST"; json?: unknown; timeoutMs?: number } = {},
  ): Promise<z.infer<S>> {
    let res = await googleRequest(url, await getToken(), init, fetchImpl);
    if (res.status === 401) {
      // The token may have been revoked or expired early: refresh once, then give up.
      res = await googleRequest(url, await getToken({ forceRefresh: true }), init, fetchImpl);
    }
    if (!res.ok) throw new GmailApiError(res.status, reasonOf(res.body), op);
    if (!schema) return undefined as z.infer<S>;
    const parsed = schema.safeParse(res.body);
    if (!parsed.success) throw new GmailShapeError(op);
    return parsed.data;
  }

  // Gmail ids are URL-safe tokens. Anything else (".", "..", "/", "%") is refused before a URL is
  // built, so an id can never change the request path.
  const id = (value: string, op: string, max = 256) => {
    if (!GMAIL_ID_PATTERN.test(value) || value.length > max) throw new GmailShapeError(op);
    return value;
  };

  return {
    getProfile: () => call("profile", `${GMAIL_BASE}/profile`, profileSchema),

    watch: (req) => call("watch", `${GMAIL_BASE}/watch`, watchSchema, { method: "POST", json: req }),

    stop: async () => {
      // Short timeout: this runs inside the disconnect action, which must not hang.
      await call("stop", `${GMAIL_BASE}/stop`, null, { method: "POST", timeoutMs: STOP_TIMEOUT_MS });
    },

    listHistory: ({ startHistoryId, pageToken }) => {
      const p = new URLSearchParams({ startHistoryId, maxResults: "500" });
      for (const t of HISTORY_TYPES) p.append("historyTypes", t);
      if (pageToken) p.set("pageToken", pageToken);
      return call("history.list", `${GMAIL_BASE}/history?${p}`, historyListSchema);
    },

    listMessages: ({ labelIds, q, pageToken }) => {
      const p = new URLSearchParams({ q, maxResults: "500" });
      for (const l of labelIds) p.append("labelIds", l);
      if (pageToken) p.set("pageToken", pageToken);
      return call("messages.list", `${GMAIL_BASE}/messages?${p}`, messageListSchema);
    },

    getMessageMinimal: async (messageId) =>
      call("messages.get", `${GMAIL_BASE}/messages/${id(messageId, "messages.get")}?format=minimal`, minimalSchema),

    getMessageFull: async (messageId) =>
      call("messages.get", `${GMAIL_BASE}/messages/${id(messageId, "messages.get")}?format=full`, fullSchema),

    getBodyPartData: async (messageId, attachmentId) =>
      call(
        "messages.attachments.get",
        `${GMAIL_BASE}/messages/${id(messageId, "messages.attachments.get")}/attachments/${id(attachmentId, "messages.attachments.get", 4096)}`,
        bodySchema,
      ),

    getSendAs: async (sendAsEmail) => {
      // Only a valid bare address is ever put in the path (and it is percent-encoded), so it can't
      // change the request path.
      if (!isValidAddress(sendAsEmail)) throw new GmailShapeError("settings.sendAs.get");
      let entry: z.infer<typeof sendAsSchema>;
      try {
        entry = await call("settings.sendAs.get", `${GMAIL_BASE}/settings/sendAs/${encodeURIComponent(sendAsEmail)}`, sendAsSchema);
      } catch (err) {
        // "Fails with an HTTP 404 error if the specified address is not a member of the collection."
        if (err instanceof GmailApiError && err.status === 404) return { kind: "not_found" };
        throw err;
      }
      // ASCII-only case folding: toLowerCase() would also fold non-ASCII lookalikes (U+212A KELVIN SIGN to "k").
      if (asciiLower(entry.sendAsEmail) !== asciiLower(sendAsEmail)) throw new GmailShapeError("settings.sendAs.get");
      return { kind: "found", signature: entry.signature ? entry.signature : null };
    },
  };
}
