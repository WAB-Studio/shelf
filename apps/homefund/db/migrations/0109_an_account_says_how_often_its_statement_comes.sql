ALTER TABLE "finances"."accounts" ADD COLUMN "statement_cadence" text;--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD COLUMN "statement_dismissed_through" date;--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_statement_cadence_valid" CHECK ("finances"."accounts"."statement_cadence" is null or "finances"."accounts"."statement_cadence" in ('monthly', 'quarterly'));--> statement-breakpoint
GRANT INSERT (statement_cadence, statement_dismissed_through), UPDATE (statement_cadence, statement_dismissed_through) ON TABLE "finances"."accounts" TO authenticated;
