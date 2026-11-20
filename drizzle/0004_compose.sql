ALTER TYPE "public"."mail_fetch_source" ADD VALUE 'outbound';--> statement-breakpoint
CREATE TABLE "approval_recipient_charges" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	"approved_at" timestamp with time zone NOT NULL,
	"new_recipients" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_items" ADD COLUMN "new_recipient_count" integer;--> statement-breakpoint
ALTER TABLE "approval_recipient_charges" ADD CONSTRAINT "approval_recipient_charges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_recipient_charges_user_approved_idx" ON "approval_recipient_charges" USING btree ("user_id","approved_at");--> statement-breakpoint
ALTER TABLE "approval_items" ADD CONSTRAINT "approval_items_new_message_shape_chk" CHECK ("approval_items"."kind" <> 'email.send' OR "approval_items"."payload"->'threading' <> 'null'::jsonb OR ("approval_items"."thread_id" IS NULL AND "approval_items"."parent_message_id" IS NULL));