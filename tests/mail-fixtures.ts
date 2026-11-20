import { GmailApiError, type FullMessage, type GmailClient, type HistoryRecord, type MessagePart } from "@/lib/gmail/client";

// Constructed fixtures (not captured from real Gmail). Addresses use example.com only.

export const b64url = (s: string | Buffer, enc: BufferEncoding = "utf8") =>
  (typeof s === "string" ? Buffer.from(s, enc) : s).toString("base64url");

export function header(name: string, value: string) {
  return { name, value };
}

export function textPart(mimeType: "text/plain" | "text/html", content: string, extra: Partial<MessagePart> = {}): MessagePart {
  return {
    mimeType,
    filename: "",
    headers: [header("Content-Type", `${mimeType}; charset="UTF-8"`)],
    body: { size: Buffer.byteLength(content), data: b64url(content) },
    ...extra,
  };
}

export function alternative(text: string, html: string): MessagePart {
  return {
    mimeType: "multipart/alternative",
    filename: "",
    headers: [header("Content-Type", 'multipart/alternative; boundary="b1"')],
    body: { size: 0 },
    parts: [
      { ...textPart("text/plain", text), partId: "0" },
      { ...textPart("text/html", html), partId: "1" },
    ],
  };
}

export type FakeMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  subject?: string;
  from?: string;
  messageIdHeader?: string;
  inReplyTo?: string;
  payload?: MessagePart;
};

export function toFull(m: FakeMessage): FullMessage {
  const headers = [
    header("From", m.from ?? "Sender <sender@example.com>"),
    header("To", "owner@example.com"),
    header("Subject", m.subject ?? `Subject ${m.id}`),
    header("Date", new Date(m.internalDate).toUTCString()),
    header("Message-ID", m.messageIdHeader ?? `<${m.id}@mail.example.com>`),
    ...(m.inReplyTo ? [header("In-Reply-To", m.inReplyTo), header("References", m.inReplyTo)] : []),
  ];
  const payload = m.payload ?? alternative(`Body of ${m.id}`, `<p>Body of ${m.id}</p>`);
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: [...m.labelIds],
    snippet: `Snippet ${m.id}`,
    historyId: "1",
    internalDate: String(m.internalDate),
    sizeEstimate: 1234,
    payload: { ...payload, partId: "", headers: [...headers, ...(payload.headers ?? [])] },
  };
}

type Call = { op: keyof GmailClient; args: unknown[] };

/**
 * In-memory Gmail: a mailbox plus a history log. History records carry only id and threadId
 * (as Google says they "typically" do) unless `historyLabels` is set.
 */
export class FakeGmail implements GmailClient {
  messages = new Map<string, FakeMessage>();
  bodies = new Map<string, string>(); // attachmentId -> base64url data
  history: (HistoryRecord & { id: string })[] = [];
  historyId = 1000;
  calls: Call[] = [];
  historyPageSize = 100;
  listPageSize = 500;
  historyLabels = false;
  /** Next call of an op throws this (once). */
  failures = new Map<keyof GmailClient, GmailApiError[]>();
  expiredBefore: bigint | null = null;

  private record(op: keyof GmailClient, args: unknown[]) {
    this.calls.push({ op, args });
    const queue = this.failures.get(op);
    const err = queue?.shift();
    if (err) throw err;
  }

  count(op: keyof GmailClient) {
    return this.calls.filter((c) => c.op === op).length;
  }

  failNext(op: keyof GmailClient, status: number, reason = "testReason") {
    const list = this.failures.get(op) ?? [];
    list.push(new GmailApiError(status, reason, op));
    this.failures.set(op, list);
  }

  private ref(m: FakeMessage) {
    return this.historyLabels ? { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] } : { id: m.id, threadId: m.threadId };
  }

  private push(rec: HistoryRecord) {
    this.historyId += 7; // ids increase with gaps
    this.history.push({ ...rec, id: String(this.historyId) });
  }

  /** Puts a message in the mailbox without a history record (it existed before the cursor). */
  seed(m: FakeMessage) {
    this.messages.set(m.id, { ...m, labelIds: [...m.labelIds] });
  }

  /** New message arriving after the cursor: stored and recorded as messagesAdded. */
  deliver(m: FakeMessage) {
    this.seed(m);
    this.push({ messagesAdded: [{ message: this.ref(this.messages.get(m.id)!) }] });
  }

  addLabels(id: string, labels: string[]) {
    const m = this.messages.get(id)!;
    m.labelIds = [...new Set([...m.labelIds, ...labels])];
    this.push({ labelsAdded: [{ message: this.ref(m), labelIds: labels }] });
  }

  removeLabels(id: string, labels: string[]) {
    const m = this.messages.get(id)!;
    m.labelIds = m.labelIds.filter((l) => !labels.includes(l));
    this.push({ labelsRemoved: [{ message: this.ref(m), labelIds: labels }] });
  }

  /** Changes labels silently (no history), e.g. during an expired-history gap. */
  silentlySetLabels(id: string, labels: string[]) {
    this.messages.get(id)!.labelIds = [...labels];
  }

  deleteForever(id: string) {
    const m = this.messages.get(id)!;
    this.messages.delete(id);
    this.push({ messagesDeleted: [{ message: { id: m.id, threadId: m.threadId } }] });
  }

  async getProfile() {
    this.record("getProfile", []);
    return { historyId: String(this.historyId) };
  }

  async watch(req: { topicName: string; labelIds: string[]; labelFilterBehavior: string }) {
    this.record("watch", [req]);
    return { historyId: String(this.historyId), expiration: String(Date.now() + 7 * 24 * 3600_000) };
  }

  async stop() {
    this.record("stop", []);
  }

  async listHistory(req: { startHistoryId: string; pageToken?: string }) {
    this.record("listHistory", [req]);
    const start = BigInt(req.startHistoryId);
    if (this.expiredBefore !== null && start < this.expiredBefore) throw new GmailApiError(404, "notFound", "history.list");
    const all = this.history.filter((h) => BigInt(h.id) > start);
    const offset = req.pageToken ? Number(req.pageToken) : 0;
    const page = all.slice(offset, offset + this.historyPageSize);
    const next = offset + this.historyPageSize < all.length ? String(offset + this.historyPageSize) : undefined;
    return { history: page.length ? page : undefined, nextPageToken: next, historyId: String(this.historyId) };
  }

  async listMessages(req: { labelIds: string[]; q: string; pageToken?: string }) {
    this.record("listMessages", [req]);
    const after = Number(req.q.match(/^after:(\d+)$/)?.[1] ?? "0") * 1000;
    const matching = [...this.messages.values()]
      .filter((m) => req.labelIds.every((l) => m.labelIds.includes(l)))
      .filter((m) => !m.labelIds.includes("SPAM") && !m.labelIds.includes("TRASH"))
      .filter((m) => m.internalDate > after)
      .sort((a, b) => b.internalDate - a.internalDate);
    const offset = req.pageToken ? Number(req.pageToken) : 0;
    const page = matching.slice(offset, offset + this.listPageSize);
    const next = offset + this.listPageSize < matching.length ? String(offset + this.listPageSize) : undefined;
    return { messages: page.length ? page.map((m) => ({ id: m.id, threadId: m.threadId })) : undefined, nextPageToken: next };
  }

  async getMessageMinimal(id: string) {
    this.record("getMessageMinimal", [id]);
    const m = this.messages.get(id);
    if (!m) throw new GmailApiError(404, "notFound", "messages.get");
    return { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] };
  }

  async getMessageFull(id: string) {
    this.record("getMessageFull", [id]);
    const m = this.messages.get(id);
    if (!m) throw new GmailApiError(404, "notFound", "messages.get");
    return toFull(m);
  }

  async getBodyPartData(messageId: string, attachmentId: string) {
    this.record("getBodyPartData", [messageId, attachmentId]);
    const data = this.bodies.get(attachmentId);
    if (data === undefined) throw new GmailApiError(404, "notFound", "messages.attachments.get");
    return { data, size: Buffer.from(data, "base64url").length };
  }
}
