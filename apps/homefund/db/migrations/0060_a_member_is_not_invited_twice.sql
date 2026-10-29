-- RF-151: an archived invitation stops holding its address, so the leader can invite it again; two live ones still clash.
-- No row changes: every address the old index admitted, the narrower one admits too.
DROP INDEX "finances"."group_members_group_invite_email_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_group_invite_email_unique" ON "finances"."group_members" USING btree ("group_id",lower("invite_email")) WHERE "finances"."group_members"."invite_email" is not null and "finances"."group_members"."archived_at" is null;--> statement-breakpoint
-- Hand-written: drizzle-kit diffs no function. RF-150: a definer, because the leader holds no grant on
-- `auth.users`. It reads only the caller's own fund, and only when the caller leads it; anyone else learns false.
-- A pending row has no `user_id`, so the join to `auth.users` alone keeps invitations out.
CREATE FUNCTION private.invite_email_is_member(p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = ''
AS $function$
  select exists (
    select 1
    from finances.group_members l
    join finances.group_members m on m.group_id = l.group_id
    join auth.users u on u.id = m.user_id
    where l.user_id = auth.uid()
      and l.role = 'leader'
      and l.archived_at is null
      and m.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(u.email)) = pg_catalog.lower(pg_catalog.btrim(p_email))
  );
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.invite_email_is_member(text) FROM PUBLIC, "anon", "authenticated", "service_role";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.invite_email_is_member(text) TO "authenticated";
