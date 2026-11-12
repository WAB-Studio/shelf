ALTER TABLE "finances"."ingest_deliveries" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_reject_reason_valid" CHECK ("finances"."ingest_deliveries"."reject_reason" is null or "finances"."ingest_deliveries"."reject_reason" in ('failed', 'statement', 'support', 'reminder', 'promotion', 'no_movement_signal'));--> statement-breakpoint
GRANT SELECT (reject_reason) ON TABLE "finances"."ingest_deliveries" TO authenticated;--> statement-breakpoint
GRANT INSERT (reject_reason) ON TABLE "finances"."ingest_deliveries" TO authenticated;
