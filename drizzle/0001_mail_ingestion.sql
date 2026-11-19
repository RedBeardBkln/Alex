CREATE TYPE "public"."mail_backfill_status" AS ENUM('pending', 'listing_inbox', 'listing_sent', 'hydrating', 'complete');--> statement-breakpoint
CREATE TYPE "public"."mail_fetch_source" AS ENUM('backfill_inbox', 'backfill_sent', 'history', 'resync');--> statement-breakpoint
CREATE TYPE "public"."mail_render_kind" AS ENUM('html', 'text', 'none');--> statement-breakpoint
CREATE TABLE "mail_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"part_id" text NOT NULL,
	"filename" text,
	"mime_type" text,
	"size_bytes" integer,
	"gmail_attachment_id" text,
	"content_id" text,
	"is_inline" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_fetch_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text,
	"source" "mail_fetch_source" NOT NULL,
	"needs_classify" boolean NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"deferred_at" timestamp with time zone,
	"defer_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"history_id" text,
	"internal_date" timestamp with time zone NOT NULL,
	"label_ids" text[] NOT NULL,
	"is_sent" boolean NOT NULL,
	"snippet" text,
	"subject" text,
	"from_header" text,
	"to_header" text,
	"cc_header" text,
	"reply_to_header" text,
	"date_header" text,
	"rfc822_message_id" text,
	"in_reply_to" text,
	"references" text,
	"headers" jsonb NOT NULL,
	"body_text" text,
	"body_html" text,
	"size_estimate" integer,
	"body_incomplete" boolean DEFAULT false NOT NULL,
	"render_kind" "mail_render_kind",
	"render_reason" text,
	"rendered_html" text,
	"rendered_html_remote" text,
	"rendered_text" text,
	"render_truncated" boolean DEFAULT false NOT NULL,
	"sanitizer_version" integer,
	"rendered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_sync_state" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"history_id" text,
	"last_history_sync_at" timestamp with time zone,
	"last_push_at" timestamp with time zone,
	"last_push_history_id" text,
	"watch_expires_at" timestamp with time zone,
	"watch_renewed_at" timestamp with time zone,
	"watch_topic" text,
	"backfill_status" "mail_backfill_status" DEFAULT 'pending' NOT NULL,
	"backfill_after" timestamp with time zone,
	"backfill_page_token" text,
	"backfill_listed" integer DEFAULT 0 NOT NULL,
	"backfill_started_at" timestamp with time zone,
	"backfill_completed_at" timestamp with time zone,
	"resync_after" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"subject" text,
	"snippet" text,
	"last_message_at" timestamp with time zone NOT NULL,
	"message_count" integer NOT NULL,
	"in_inbox" boolean NOT NULL,
	"has_unread" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_fetch_queue" ADD CONSTRAINT "mail_fetch_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_fetch_queue" ADD CONSTRAINT "mail_fetch_queue_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_thread_id_mail_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sync_state" ADD CONSTRAINT "mail_sync_state_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sync_state" ADD CONSTRAINT "mail_sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_attachments_message_part_uidx" ON "mail_attachments" USING btree ("message_id","part_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_fetch_queue_account_message_uidx" ON "mail_fetch_queue" USING btree ("account_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "mail_fetch_queue_account_next_idx" ON "mail_fetch_queue" USING btree ("account_id","next_attempt_at");--> statement-breakpoint
CREATE INDEX "mail_fetch_queue_account_thread_idx" ON "mail_fetch_queue" USING btree ("account_id","gmail_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_messages_account_message_uidx" ON "mail_messages" USING btree ("account_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "mail_messages_thread_date_idx" ON "mail_messages" USING btree ("thread_id","internal_date");--> statement-breakpoint
CREATE INDEX "mail_messages_render_version_idx" ON "mail_messages" USING btree ("account_id","sanitizer_version");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_threads_account_thread_uidx" ON "mail_threads" USING btree ("account_id","gmail_thread_id");--> statement-breakpoint
CREATE INDEX "mail_threads_user_inbox_idx" ON "mail_threads" USING btree ("user_id","in_inbox","last_message_at" DESC NULLS LAST);