ALTER TABLE "finances"."transactions" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD CONSTRAINT "transactions_created_via_valid" CHECK ("finances"."transactions"."created_via" is null or "finances"."transactions"."created_via" in ('web', 'mcp', 'inbox', 'import'));--> statement-breakpoint
-- RF-253, hand-written: drizzle-kit diffs no grant. The column is written once at insert and no grant updates it, so how a
-- movement was made cannot be edited afterwards. No backfill: what predates it reads null.
GRANT INSERT (created_via) ON TABLE "finances"."transactions" TO authenticated;
