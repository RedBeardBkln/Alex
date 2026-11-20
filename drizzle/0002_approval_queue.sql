CREATE TYPE "public"."approval_kind" AS ENUM('email.send');--> statement-breakpoint
CREATE TYPE "public"."approval_source" AS ENUM('owner');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'executing', 'succeeded', 'failed', 'unknown', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "approval_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "approval_kind" NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"source" "approval_source" NOT NULL,
	"account_id" uuid,
	"thread_id" uuid,
	"parent_message_id" uuid,
	"parent_internal_date" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"approved_revision" integer,
	"approved_hash" text,
	"approved_payload" jsonb,
	"approved_at" timestamp with time zone,
	"message_id_header" text,
	"execution_id" uuid,
	"executing_since" timestamp with time zone,
	"result" jsonb,
	"error_code" text,
	"thread_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "approval_items_email_send_account_chk" CHECK ("approval_items"."kind" <> 'email.send' OR "approval_items"."account_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "approval_items" ADD CONSTRAINT "approval_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_items" ADD CONSTRAINT "approval_items_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_items" ADD CONSTRAINT "approval_items_thread_id_mail_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_items" ADD CONSTRAINT "approval_items_parent_message_id_mail_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."mail_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_items_user_status_created_idx" ON "approval_items" USING btree ("user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "approval_items_status_executing_idx" ON "approval_items" USING btree ("status","executing_since");--> statement-breakpoint
CREATE INDEX "approval_items_thread_idx" ON "approval_items" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "approval_items_account_message_id_idx" ON "approval_items" USING btree ("account_id","message_id_header");