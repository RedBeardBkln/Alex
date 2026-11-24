CREATE TYPE "public"."task_priority" AS ENUM('high', 'normal', 'low');--> statement-breakpoint
CREATE TYPE "public"."task_source" AS ENUM('manual', 'email');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('suggested', 'open', 'done', 'dismissed');--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"due_date" date,
	"due_at" timestamp with time zone,
	"due_tz" text,
	"completed_at" timestamp with time zone,
	"source" "task_source" NOT NULL,
	"source_account_id" uuid,
	"source_thread_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_title_len_chk" CHECK (char_length("tasks"."title") BETWEEN 1 AND 500),
	CONSTRAINT "tasks_notes_len_chk" CHECK ("tasks"."notes" IS NULL OR char_length("tasks"."notes") <= 20000),
	CONSTRAINT "tasks_due_shape_chk" CHECK (NOT ("tasks"."due_date" IS NOT NULL AND "tasks"."due_at" IS NOT NULL) AND (("tasks"."due_at" IS NULL) = ("tasks"."due_tz" IS NULL))),
	CONSTRAINT "tasks_due_tz_len_chk" CHECK ("tasks"."due_tz" IS NULL OR char_length("tasks"."due_tz") BETWEEN 1 AND 64),
	CONSTRAINT "tasks_completed_chk" CHECK (("tasks"."status" = 'done') = ("tasks"."completed_at" IS NOT NULL)),
	CONSTRAINT "tasks_manual_source_chk" CHECK ("tasks"."source" <> 'manual' OR ("tasks"."source_account_id" IS NULL AND "tasks"."source_thread_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_account_id_connected_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_thread_id_mail_threads_id_fk" FOREIGN KEY ("source_thread_id") REFERENCES "public"."mail_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_user_status_idx" ON "tasks" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "tasks_open_due_date_idx" ON "tasks" USING btree ("user_id","due_date") WHERE "tasks"."status" = 'open' AND "tasks"."due_date" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_open_due_at_idx" ON "tasks" USING btree ("user_id","due_at") WHERE "tasks"."status" = 'open' AND "tasks"."due_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_done_idx" ON "tasks" USING btree ("user_id","completed_at" DESC NULLS LAST) WHERE "tasks"."status" = 'done';--> statement-breakpoint
CREATE INDEX "tasks_source_thread_idx" ON "tasks" USING btree ("source_thread_id");--> statement-breakpoint
CREATE INDEX "tasks_source_account_idx" ON "tasks" USING btree ("source_account_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_time_zone_len_chk" CHECK ("users"."time_zone" IS NULL OR char_length("users"."time_zone") BETWEEN 1 AND 64);