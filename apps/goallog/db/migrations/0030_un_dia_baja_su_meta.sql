ALTER TABLE "goals"."facts" ADD COLUMN "day_target" integer;--> statement-breakpoint
ALTER TABLE "goals"."facts" ADD CONSTRAINT "facts_day_target_positive" CHECK ("goals"."facts"."day_target" is null or "goals"."facts"."day_target" > 0);--> statement-breakpoint
GRANT INSERT (day_target) ON TABLE "goals"."facts" TO "authenticated";
