ALTER TABLE "finances"."labels" ADD COLUMN "kind" text DEFAULT 'tag' NOT NULL;--> statement-breakpoint
ALTER TABLE "finances"."labels" ADD COLUMN "charge_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "finances"."labels" ADD CONSTRAINT "labels_kind_valid" CHECK ("finances"."labels"."kind" in ('tag', 'person'));--> statement-breakpoint
ALTER TABLE "finances"."labels" ADD CONSTRAINT "labels_charge_by_kind" CHECK ("finances"."labels"."charge_default" = false or "finances"."labels"."kind" = 'person');--> statement-breakpoint
-- RF-242, hand-written: drizzle-kit diffs no grant. A person is a label of its own kind (the same join, scope
-- and policies as a tag), so no table is created and none needs a REVOKE of its own: the table keeps the grants
-- `0001` gave it and its policies still gate every row. The two new columns are written by `authenticated` and by
-- no one else: the kind on insert alone, so a label never changes kind; the default to charge on insert and on edit.
REVOKE ALL (kind, charge_default) ON TABLE "finances"."labels" FROM public, anon, service_role;--> statement-breakpoint
GRANT INSERT (kind, charge_default), UPDATE (charge_default) ON TABLE "finances"."labels" TO authenticated;
