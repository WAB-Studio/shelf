ALTER TABLE "reading"."lookups" ADD COLUMN "definition" text;--> statement-breakpoint
ALTER TABLE "reading"."lookups" ADD COLUMN "example_en" text;--> statement-breakpoint
ALTER TABLE "reading"."lookups" ADD COLUMN "example_es" text;--> statement-breakpoint
ALTER TABLE "reading"."lookups" ADD CONSTRAINT "lookups_definition_length" CHECK (length("reading"."lookups"."definition") <= 500);--> statement-breakpoint
ALTER TABLE "reading"."lookups" ADD CONSTRAINT "lookups_example_en_length" CHECK (length("reading"."lookups"."example_en") <= 500);--> statement-breakpoint
ALTER TABLE "reading"."lookups" ADD CONSTRAINT "lookups_example_es_length" CHECK (length("reading"."lookups"."example_es") <= 500);