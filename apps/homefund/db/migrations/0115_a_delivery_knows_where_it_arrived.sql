ALTER TABLE "finances"."ingest_deliveries" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD COLUMN "location_accuracy_m" integer;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD COLUMN "place" text;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_location_valid" CHECK (("finances"."ingest_deliveries"."latitude" is null) = ("finances"."ingest_deliveries"."longitude" is null)
        and ("finances"."ingest_deliveries"."latitude" is null or "finances"."ingest_deliveries"."latitude" between -90 and 90)
        and ("finances"."ingest_deliveries"."longitude" is null or "finances"."ingest_deliveries"."longitude" between -180 and 180)
        and ("finances"."ingest_deliveries"."location_accuracy_m" is null or "finances"."ingest_deliveries"."location_accuracy_m" >= 0)
        and length("finances"."ingest_deliveries"."place") <= 200);--> statement-breakpoint
-- RF-320, hand-written: drizzle-kit diffs no grant. The ingest writes the location with the row and fills the
-- place afterwards; the table grants its columns one by one.
GRANT SELECT (latitude, longitude, location_accuracy_m, place), INSERT (latitude, longitude, location_accuracy_m, place) ON TABLE "finances"."ingest_deliveries" TO authenticated;--> statement-breakpoint
GRANT UPDATE (place) ON TABLE "finances"."ingest_deliveries" TO authenticated;
