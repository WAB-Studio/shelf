ALTER TABLE "finances"."ingest_deliveries" ADD COLUMN "from_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Hand-written: drizzle-kit diffs no grant. Written on insert, never changed.
GRANT SELECT (from_email), INSERT (from_email) ON TABLE "finances"."ingest_deliveries" TO authenticated;
