-- Hand-written: drizzle-kit diffs neither a GRANT nor a function.
-- The upload's two questions, answered after the per-reader `:sync-quota` lock: the day's count (0007's, word for
-- word) and whether the sending device is retired. Each statement after the PERFORM takes a fresh snapshot, so a
-- retirement committed while this call waited is seen (docs/TRAPS.md, advisory lock and snapshot). SECURITY INVOKER,
-- as `sync_rows_today`: the policies on `devices`, `lookups` and `lookup_tombstones` still decide what is counted.
CREATE FUNCTION "reading"."sync_gate"(p_user uuid, p_device uuid) RETURNS TABLE (today bigint, retired boolean)
  LANGUAGE plpgsql VOLATILE
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
  today := sent + buried;
  retired := EXISTS (
    SELECT 1 FROM reading.devices d
    WHERE d.user_id = p_user AND d.device_id = p_device AND d.retired_at IS NOT NULL
  );
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
-- `reading` carries no default ACL from Supabase (docs/TRAPS.md); `authenticated` is revoked too before its one grant.
REVOKE ALL ON FUNCTION "reading"."sync_gate"(uuid, uuid) FROM PUBLIC, "anon", "authenticated", "service_role";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "reading"."sync_gate"(uuid, uuid) TO "authenticated";
