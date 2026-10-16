ALTER TABLE "accounts" ADD COLUMN "last_four" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_last_four_digits" CHECK ("accounts"."last_four" is null or "accounts"."last_four" ~ '^[0-9]{4}$');--> statement-breakpoint
GRANT INSERT (last_four), UPDATE (last_four) ON TABLE "accounts" TO authenticated;
