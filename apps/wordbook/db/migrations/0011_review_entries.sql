CREATE TABLE "reading"."review_entries" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"at" bigint NOT NULL,
	"gone" boolean DEFAULT false NOT NULL,
	"card" jsonb,
	"sense" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_entries_user_id_key_pk" PRIMARY KEY("user_id","key"),
	CONSTRAINT "review_entries_key_length" CHECK (length("reading"."review_entries"."key") between 1 and 500),
	CONSTRAINT "review_entries_at_non_negative" CHECK ("reading"."review_entries"."at" >= 0),
	CONSTRAINT "review_entries_gone_is_bare" CHECK (not "reading"."review_entries"."gone" or ("reading"."review_entries"."card" is null and "reading"."review_entries"."sense" is null)),
	CONSTRAINT "review_entries_card_shape" CHECK (jsonb_typeof("reading"."review_entries"."card") = 'object' and length("reading"."review_entries"."card"::text) <= 1000),
	CONSTRAINT "review_entries_sense_shape" CHECK (jsonb_typeof("reading"."review_entries"."sense") = 'object' and length("reading"."review_entries"."sense"::text) <= 6000)
);
--> statement-breakpoint
ALTER TABLE "reading"."review_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reading"."review_entries" ADD CONSTRAINT "review_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_entries_user_id_updated_at_idx" ON "reading"."review_entries" USING btree ("user_id","updated_at","key");--> statement-breakpoint
CREATE POLICY "review_entries_select_self" ON "reading"."review_entries" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "reading"."review_entries"."user_id");--> statement-breakpoint
CREATE POLICY "review_entries_insert_self" ON "reading"."review_entries" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "reading"."review_entries"."user_id");--> statement-breakpoint
CREATE POLICY "review_entries_update_self" ON "reading"."review_entries" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "reading"."review_entries"."user_id") WITH CHECK ((select auth.uid()) = "reading"."review_entries"."user_id");--> statement-breakpoint
CREATE POLICY "review_entries_delete_self" ON "reading"."review_entries" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid()) = "reading"."review_entries"."user_id");
--> statement-breakpoint
-- Hand-written from here: drizzle-kit diffs neither a GRANT nor a function.
-- `reading` carries no default ACL from Supabase (docs/TRAPS.md); revoked all the same.
REVOKE ALL ON TABLE "reading"."review_entries" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
ALTER TABLE "reading"."review_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE "reading"."review_entries" TO "authenticated";
--> statement-breakpoint
-- `updated_at` is left out of both: the trigger below stamps it, so no client moves the download cursor.
GRANT INSERT (user_id, key, at, gone, card, sense) ON TABLE "reading"."review_entries" TO "authenticated";
--> statement-breakpoint
GRANT UPDATE (at, gone, card, sense) ON TABLE "reading"."review_entries" TO "authenticated";
--> statement-breakpoint
CREATE FUNCTION "reading"."review_entries_stamp"() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "reading"."review_entries_stamp"() FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
CREATE TRIGGER "review_entries_stamp" BEFORE INSERT OR UPDATE ON "reading"."review_entries"
  FOR EACH ROW EXECUTE FUNCTION "reading"."review_entries_stamp"();
