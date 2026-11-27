CREATE TYPE "public"."signature_state" AS ENUM('set', 'none', 'not_found', 'too_large');--> statement-breakpoint
CREATE TABLE "account_signatures" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"state" "signature_state",
	"signature_text" text,
	"last_error_code" text,
	"checked_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_signatures_text_state_chk" CHECK (("account_signatures"."state" IS NOT DISTINCT FROM 'set') = ("account_signatures"."signature_text" IS NOT NULL)),
	CONSTRAINT "account_signatures_text_len_chk" CHECK ("account_signatures"."signature_text" IS NULL OR char_length("account_signatures"."signature_text") BETWEEN 1 AND 10000),
	CONSTRAINT "account_signatures_error_code_chk" CHECK ("account_signatures"."last_error_code" IS NULL OR "account_signatures"."last_error_code" ~ '^[A-Za-z0-9_.:-]{1,80}$'),
	CONSTRAINT "account_signatures_fetched_chk" CHECK (("account_signatures"."state" IS NULL) = ("account_signatures"."fetched_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "account_signatures" ADD CONSTRAINT "account_signatures_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_signatures" ADD CONSTRAINT "account_signatures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;