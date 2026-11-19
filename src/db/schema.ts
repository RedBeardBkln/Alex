import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const accountLabel = pgEnum("account_label", ["personal", "business"]);
export const accountProvider = pgEnum("account_provider", ["google", "slack", "remarkable"]);
export const accountStatus = pgEnum("account_status", ["active", "reauth_required", "revoked"]);

/** The person who owns this Alex instance. Single-user today; kept as a table so data is scoped from day one. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Browser sessions. Only a SHA-256 hash of the cookie value is stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256(cookie token), hex
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * An external account Alex acts on: each Google account (personal or business), and later Slack and reMarkable.
 * Tokens are AES-256-GCM encrypted (see src/lib/crypto.ts).
 */
export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: accountProvider("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(), // Google "sub"
    email: text("email").notNull(),
    displayName: text("display_name"),
    label: accountLabel("label").notNull().default("personal"),
    status: accountStatus("status").notNull().default("active"),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    accessTokenEnc: text("access_token_enc"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenEnc: text("refresh_token_enc"),
    /** When the user last granted consent; drives the 7-day reconnect warning in Google "Testing" mode. */
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("connected_accounts_provider_uidx").on(t.userId, t.provider, t.providerAccountId),
  ],
);

/** Append-only record of everything Alex does or is asked to do. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_user_created_idx").on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------------------------------------
// Mail ingestion (Phase 2a). Every mail row is tied to the connected_accounts row that received
// it and is deleted with it (ON DELETE CASCADE). Gmail historyIds are uint64 strings, so they
// are stored as text and compared with BigInt.
// ---------------------------------------------------------------------------------------------

export const mailBackfillStatus = pgEnum("mail_backfill_status", [
  "pending",
  "listing_inbox",
  "listing_sent",
  "hydrating",
  "complete",
]);
export const mailFetchSource = pgEnum("mail_fetch_source", ["backfill_inbox", "backfill_sent", "history", "resync"]);
export const mailRenderKind = pgEnum("mail_render_kind", ["html", "text", "none"]);

/** Sync cursor, watch, backfill progress and lease for one Google account (1:1). */
export const mailSyncState = pgTable("mail_sync_state", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => connectedAccounts.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** history.list cursor. Only moves forward, and only after a full page set has been applied. */
  historyId: text("history_id"),
  lastHistorySyncAt: timestamp("last_history_sync_at", { withTimezone: true }),
  /** Informational only; a push notification's historyId never becomes the cursor. */
  lastPushAt: timestamp("last_push_at", { withTimezone: true }),
  lastPushHistoryId: text("last_push_history_id"),
  watchExpiresAt: timestamp("watch_expires_at", { withTimezone: true }),
  watchRenewedAt: timestamp("watch_renewed_at", { withTimezone: true }),
  watchTopic: text("watch_topic"),
  backfillStatus: mailBackfillStatus("backfill_status").notNull().default("pending"),
  backfillAfter: timestamp("backfill_after", { withTimezone: true }),
  /** Page token for whichever listing phase (backfill or resync) is active. */
  backfillPageToken: text("backfill_page_token"),
  backfillListed: integer("backfill_listed").notNull().default(0),
  backfillStartedAt: timestamp("backfill_started_at", { withTimezone: true }),
  backfillCompletedAt: timestamp("backfill_completed_at", { withTimezone: true }),
  /** Set while an expired-history resync's listing is in progress. */
  resyncAfter: timestamp("resync_after", { withTimezone: true }),
  leaseOwner: text("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  /** Content-free (stage, HTTP status, Google reason). */
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Message ids waiting to be fetched from Gmail. */
export const mailFetchQueue = pgTable(
  "mail_fetch_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id"),
    source: mailFetchSource("source").notNull(),
    /** True when the labels are unknown: hydration runs a format=minimal get first. */
    needsClassify: boolean("needs_classify").notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Set when the row is classified as a sent message waiting for its thread to be stored. */
    deferredAt: timestamp("deferred_at", { withTimezone: true }),
    /** How many times the row has been deferred; the wait ceiling counts these, not wall-clock time. */
    deferCount: integer("defer_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mail_fetch_queue_account_message_uidx").on(t.accountId, t.gmailMessageId),
    index("mail_fetch_queue_account_next_idx").on(t.accountId, t.nextAttemptAt),
    index("mail_fetch_queue_account_thread_idx").on(t.accountId, t.gmailThreadId),
  ],
);

/** A Gmail thread as stored by Alex, per receiving account. Derived columns are recomputed with every change. */
export const mailThreads = pgTable(
  "mail_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The receiving account; Phase 2b replies from it. */
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    gmailThreadId: text("gmail_thread_id").notNull(),
    subject: text("subject"),
    snippet: text("snippet"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull(),
    /** True if any stored message carries INBOX. */
    inInbox: boolean("in_inbox").notNull(),
    /** True if any stored message carries both INBOX and UNREAD. */
    hasUnread: boolean("has_unread").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mail_threads_account_thread_uidx").on(t.accountId, t.gmailThreadId),
    index("mail_threads_user_inbox_idx").on(t.userId, t.inInbox, t.lastMessageAt.desc()),
  ],
);

/** A stored Gmail message: headers, text and HTML bodies. Labels are kept current by history reconciliation. */
export const mailMessages = pgTable(
  "mail_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => mailThreads.id, { onDelete: "cascade" }),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    historyId: text("history_id"),
    internalDate: timestamp("internal_date", { withTimezone: true }).notNull(),
    labelIds: text("label_ids").array().notNull(),
    /** SENT was in the labels at ingest. */
    isSent: boolean("is_sent").notNull(),
    snippet: text("snippet"),
    subject: text("subject"),
    fromHeader: text("from_header"),
    toHeader: text("to_header"),
    ccHeader: text("cc_header"),
    replyToHeader: text("reply_to_header"),
    dateHeader: text("date_header"),
    rfc822MessageId: text("rfc822_message_id"),
    inReplyTo: text("in_reply_to"),
    references: text("references"),
    /** Full top-level header list as returned by Gmail. */
    headers: jsonb("headers").$type<{ name: string; value: string }[]>().notNull(),
    bodyText: text("body_text"),
    /** Raw HTML as received; rendered at ingest (Revision 4) into the render_* columns below. */
    bodyHtml: text("body_html"),
    sizeEstimate: integer("size_estimate"),
    /** A body part delivered by attachmentId could not be fetched. */
    bodyIncomplete: boolean("body_incomplete").notNull().default(false),
    /** How the body is displayed; NULL means not rendered yet (src/lib/email/render.ts). */
    renderKind: mailRenderKind("render_kind"),
    /** Why a message with HTML is shown as text (too_large, too_deep, timeout, crash, postcheck, worker_unavailable). Content-free. */
    renderReason: text("render_reason"),
    /** Sanitized body fragment, default mode (no remote images). */
    renderedHtml: text("rendered_html"),
    /** Sanitized fragment with https <img> kept; NULL when identical to rendered_html or not html. */
    renderedHtmlRemote: text("rendered_html_remote"),
    /** Plain-text rendering (render_kind = 'text'). */
    renderedText: text("rendered_text"),
    renderTruncated: boolean("render_truncated").notNull().default(false),
    /** SANITIZER_VERSION that produced the output; NULL means not rendered or the worker was unavailable. */
    sanitizerVersion: integer("sanitizer_version"),
    renderedAt: timestamp("rendered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mail_messages_account_message_uidx").on(t.accountId, t.gmailMessageId),
    index("mail_messages_thread_date_idx").on(t.threadId, t.internalDate),
    index("mail_messages_render_version_idx").on(t.accountId, t.sanitizerVersion),
  ],
);

/** Attachment metadata only. Attachment content is never fetched or stored. */
export const mailAttachments = pgTable(
  "mail_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => mailMessages.id, { onDelete: "cascade" }),
    partId: text("part_id").notNull(),
    filename: text("filename"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    gmailAttachmentId: text("gmail_attachment_id"),
    contentId: text("content_id"),
    isInline: boolean("is_inline").notNull().default(false),
  },
  (t) => [uniqueIndex("mail_attachments_message_part_uidx").on(t.messageId, t.partId)],
);

export type User = typeof users.$inferSelect;
export type ConnectedAccount = typeof connectedAccounts.$inferSelect;
export type MailSyncState = typeof mailSyncState.$inferSelect;
export type MailFetchQueueRow = typeof mailFetchQueue.$inferSelect;
export type MailThread = typeof mailThreads.$inferSelect;
export type MailMessage = typeof mailMessages.$inferSelect;
export type MailAttachment = typeof mailAttachments.$inferSelect;
