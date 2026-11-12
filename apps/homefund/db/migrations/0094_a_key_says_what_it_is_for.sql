ALTER TABLE "finances"."webhook_credentials" ADD COLUMN "kind" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "finances"."webhook_credentials" ADD CONSTRAINT "webhook_credentials_kind_valid" CHECK ("finances"."webhook_credentials"."kind" in ('android', 'iphone', 'bank_emails', 'other'));--> statement-breakpoint
-- Hand-written: drizzle-kit diffs no grant, and the column grants name every column the API may touch.
GRANT SELECT (kind), INSERT (kind) ON TABLE "finances"."webhook_credentials" TO authenticated;
