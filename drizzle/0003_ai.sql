CREATE TYPE "public"."ai_call_status" AS ENUM('ok', 'refused', 'invalid', 'error', 'pending');--> statement-breakpoint
CREATE TYPE "public"."ai_purpose" AS ENUM('triage', 'draft');--> statement-breakpoint
CREATE TYPE "public"."triage_category" AS ENUM('needs_reply', 'fyi', 'newsletter', 'notification', 'promo', 'spam_suspect');--> statement-breakpoint
CREATE TYPE "public"."triage_status" AS ENUM('ok', 'refused', 'invalid', 'error', 'skipped_cap');--> statement-breakpoint
ALTER TYPE "public"."approval_source" ADD VALUE 'ai';--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	"purpose" "ai_purpose" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"message_id" uuid,
	"thread_id" uuid,
	"approval_item_id" uuid,
	"status" "ai_call_status" NOT NULL,
	"error_code" text,
	"request_id" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"thinking_tokens" integer,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd_micros" bigint,
	"pricing_version" text,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_triage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"status" "triage_status" NOT NULL,
	"category" "triage_category",
	"needs_reply" boolean,
	"summary" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_thread_id_mail_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_approval_item_id_approval_items_id_fk" FOREIGN KEY ("approval_item_id") REFERENCES "public"."approval_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_triage" ADD CONSTRAINT "mail_triage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_triage" ADD CONSTRAINT "mail_triage_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_triage" ADD CONSTRAINT "mail_triage_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_triage" ADD CONSTRAINT "mail_triage_thread_id_mail_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_user_created_idx" ON "ai_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_calls_draft_in_flight_uidx" ON "ai_calls" USING btree ("user_id","thread_id") WHERE "ai_calls"."purpose" = 'draft' and "ai_calls"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "mail_triage_message_prompt_uidx" ON "mail_triage" USING btree ("message_id","prompt_version");--> statement-breakpoint
CREATE INDEX "mail_triage_thread_idx" ON "mail_triage" USING btree ("thread_id");