CREATE TABLE "reading"."lookup_tombstones" (
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"local_id" integer NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lookup_tombstones_user_id_device_id_local_id_pk" PRIMARY KEY("user_id","device_id","local_id"),
	CONSTRAINT "lookup_tombstones_local_id_positive" CHECK ("reading"."lookup_tombstones"."local_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "reading"."lookup_tombstones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reading"."lookup_tombstones" ADD CONSTRAINT "lookup_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lookup_tombstones_user_id_deleted_at_idx" ON "reading"."lookup_tombstones" USING btree ("user_id","deleted_at","device_id","local_id");--> statement-breakpoint
CREATE POLICY "lookup_tombstones_select_self" ON "reading"."lookup_tombstones" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "reading"."lookup_tombstones"."user_id");--> statement-breakpoint
CREATE POLICY "lookup_tombstones_insert_self" ON "reading"."lookup_tombstones" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "reading"."lookup_tombstones"."user_id");--> statement-breakpoint
ALTER POLICY "lookups_insert_self" ON "reading"."lookups" TO authenticated WITH CHECK ((select auth.uid()) = "reading"."lookups"."user_id" and not exists (
        select 1 from reading.devices d
        where d.user_id = "reading"."lookups"."user_id" and d.device_id = "reading"."lookups"."device_id" and d.retired_at is not null
      ) and not exists (
        select 1 from reading.lookup_tombstones t
        where t.user_id = "reading"."lookups"."user_id" and t.device_id = "reading"."lookups"."device_id" and t.local_id = "reading"."lookups"."local_id"
      ));--> statement-breakpoint
-- Hand-written from here: drizzle-kit diffs neither a GRANT nor a function.
-- `reading` carries no default ACL from Supabase (docs/TRAPS.md); revoked all the same.
REVOKE ALL ON TABLE "reading"."lookup_tombstones" FROM "anon", "authenticated", "service_role";
--> statement-breakpoint
GRANT SELECT ON TABLE "reading"."lookup_tombstones" TO "authenticated";
--> statement-breakpoint
-- `deleted_at` is left out: it is the server's clock and the download cursor, never a client's parameter.
GRANT INSERT (user_id, device_id, local_id, received_at) ON TABLE "reading"."lookup_tombstones" TO "authenticated";
--> statement-breakpoint
-- 0004's count plus the marks of rows received today, so deleting a row never refunds the day's cap. A mark whose
-- row is still there is counted once. Same signature, lock, volatility and invoker rights as 0004.
CREATE OR REPLACE FUNCTION "reading"."sync_rows_today"(p_user uuid) RETURNS bigint LANGUAGE plpgsql VOLATILE
  SET search_path = '' AS $$
DECLARE
  day_start timestamptz := date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc';
  sent bigint;
  buried bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text || ':sync-quota', 0));
  SELECT count(*) INTO sent FROM reading.lookups
    WHERE user_id = p_user AND received_at >= day_start;
  SELECT count(*) INTO buried FROM reading.lookup_tombstones t
    WHERE t.user_id = p_user AND t.received_at >= day_start
      AND NOT EXISTS (
        SELECT 1 FROM reading.lookups l
        WHERE l.user_id = t.user_id AND l.device_id = t.device_id AND l.local_id = t.local_id
      );
  RETURN sent + buried;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "reading"."sync_rows_today"(uuid) FROM PUBLIC, "anon", "service_role";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "reading"."sync_rows_today"(uuid) TO "authenticated";
