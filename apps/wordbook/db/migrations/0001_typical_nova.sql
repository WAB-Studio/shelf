CREATE TABLE "reading"."word_photos" (
	"headword" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"object_path" text,
	"width" integer,
	"height" integer,
	"author" text,
	"licence" text,
	"licence_url" text,
	"source_url" text,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "word_photos_none_has_no_path" CHECK ("reading"."word_photos"."status" <> 'none' OR "reading"."word_photos"."object_path" IS NULL),
	CONSTRAINT "word_photos_found_has_attribution" CHECK ("reading"."word_photos"."status" <> 'found' OR ("reading"."word_photos"."object_path" IS NOT NULL AND "reading"."word_photos"."author" IS NOT NULL AND "reading"."word_photos"."licence" IS NOT NULL AND "reading"."word_photos"."source_url" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "reading"."word_texts" (
	"headword" text PRIMARY KEY NOT NULL,
	"definition" text,
	"example_en" text NOT NULL,
	"example_es" text NOT NULL,
	"model" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reading"."model_spend" (
	"day" date PRIMARY KEY NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"photos" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "model_spend_calls_non_negative" CHECK ("reading"."model_spend"."calls" >= 0),
	CONSTRAINT "model_spend_photos_non_negative" CHECK ("reading"."model_spend"."photos" >= 0)
);
--> statement-breakpoint
-- Not a reader's record: RLS on, zero policies. Only db/client.ts's owner
-- role touches these three, and Supabase auto-grants at CREATE TABLE
-- regardless of 0000's default-privilege revoke, so each still needs its own.
ALTER TABLE "reading"."word_photos" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reading"."word_texts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reading"."model_spend" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "reading"."word_photos" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON TABLE "reading"."word_texts" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
REVOKE ALL ON TABLE "reading"."model_spend" FROM "anon", "authenticated", "service_role";
