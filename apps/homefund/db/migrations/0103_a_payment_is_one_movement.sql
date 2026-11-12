ALTER TABLE "finances"."ingest_deliveries" DROP CONSTRAINT "ingest_deliveries_reject_reason_valid";--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD COLUMN "receipt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD COLUMN "duplicate_of_id" uuid;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_duplicate_of_id_ingest_deliveries_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "finances"."ingest_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_deliveries_duplicate_of_id_idx" ON "finances"."ingest_deliveries" USING btree ("duplicate_of_id") WHERE "finances"."ingest_deliveries"."duplicate_of_id" is not null;--> statement-breakpoint
CREATE INDEX "ingest_deliveries_owner_amount_idx" ON "finances"."ingest_deliveries" USING btree ("owner_user_id","proposed_amount_cents") WHERE "finances"."ingest_deliveries"."proposed_amount_cents" is not null;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_duplicate_of_only_when_duplicate" CHECK ("finances"."ingest_deliveries"."duplicate_of_id" is null or "finances"."ingest_deliveries"."reject_reason" = 'duplicate');--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_reject_reason_valid" CHECK ("finances"."ingest_deliveries"."reject_reason" is null or "finances"."ingest_deliveries"."reject_reason" in ('failed', 'statement', 'support', 'reminder', 'promotion', 'bill', 'duplicate', 'no_movement_signal'));--> statement-breakpoint
-- Hand-written: drizzle-kit diffs no grant. A repeat is inserted with its flag and its link; an original still
-- waiting is marked as repeated or given the business a receipt names, so those columns become updatable.
GRANT SELECT (receipt, duplicate_of_id), INSERT (receipt, duplicate_of_id) ON TABLE "finances"."ingest_deliveries" TO authenticated;--> statement-breakpoint
GRANT UPDATE (duplicate_of_id, reject_reason, proposed_description, merchant_key, merchant_label) ON TABLE "finances"."ingest_deliveries" TO authenticated;
