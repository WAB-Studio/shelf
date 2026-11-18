ALTER TABLE "finances"."labels" ADD COLUMN "already_owed_cents" bigint;--> statement-breakpoint
ALTER TABLE "finances"."labels" ADD COLUMN "already_owed_currency" text;--> statement-breakpoint
ALTER TABLE "finances"."labels" ADD COLUMN "already_owed_since" date;--> statement-breakpoint
ALTER TABLE "finances"."labels" ADD CONSTRAINT "labels_already_owed_whole" CHECK (("finances"."labels"."already_owed_cents" is null and "finances"."labels"."already_owed_currency" is null and "finances"."labels"."already_owed_since" is null)
        or ("finances"."labels"."already_owed_cents" > 0 and "finances"."labels"."already_owed_currency" ~ '^[A-Z]{3}$' and "finances"."labels"."already_owed_since" is not null));--> statement-breakpoint
ALTER TABLE "finances"."labels" ADD CONSTRAINT "labels_already_owed_charged" CHECK ("finances"."labels"."already_owed_cents" is null or ("finances"."labels"."kind" = 'person' and "finances"."labels"."charge_default"));--> statement-breakpoint
-- RF-319, hand-written: drizzle-kit diffs no grant. What a person already owed rides the label row, so no table is
-- created and the table keeps the grants `0001` gave it; its policies still gate every row. The three columns are
-- written by `authenticated` and by no one else, on insert and on edit like «se le cobra» (RF-242).
REVOKE ALL (already_owed_cents, already_owed_currency, already_owed_since) ON TABLE "finances"."labels" FROM public, anon, service_role;--> statement-breakpoint
GRANT INSERT (already_owed_cents, already_owed_currency, already_owed_since), UPDATE (already_owed_cents, already_owed_currency, already_owed_since) ON TABLE "finances"."labels" TO authenticated;
