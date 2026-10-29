-- RF-154: signing in no longer joins a fund. An invitation carries a state: 'pending' until the invited
-- person accepts, 'accepted' once they hold the membership, 'declined' (and archived) when they refuse.
-- No role may write the column; the trigger below sets a row's state from the columns the app writes
-- today, and acceptance and decline are server functions of their own.
-- Hand-written: the snapshot chain forks at 0052-0054, so drizzle-kit cannot generate from it.
ALTER TABLE "finances"."group_members" ADD COLUMN "invite_state" text DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
-- A row that still waits on an address (no user, an email) is pending, archived or not; every other row
-- (a member with a login, a person recorded without one) keeps reading as it does today.
UPDATE "finances"."group_members" SET "invite_state" = 'pending' WHERE "user_id" IS NULL AND "invite_email" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "finances"."group_members" ADD CONSTRAINT "group_members_invite_state_valid" CHECK ("finances"."group_members"."invite_state" in ('pending', 'accepted', 'declined'));--> statement-breakpoint
ALTER TABLE "finances"."group_members" ADD CONSTRAINT "group_members_pending_unclaimed" CHECK ("finances"."group_members"."invite_state" <> 'pending' or ("finances"."group_members"."user_id" is null and "finances"."group_members"."invite_email" is not null));--> statement-breakpoint
ALTER TABLE "finances"."group_members" ADD CONSTRAINT "group_members_accepted_has_no_invite" CHECK ("finances"."group_members"."invite_state" <> 'accepted' or "finances"."group_members"."invite_email" is null);--> statement-breakpoint
ALTER TABLE "finances"."group_members" ADD CONSTRAINT "group_members_declined_archived" CHECK ("finances"."group_members"."invite_state" <> 'declined' or "finances"."group_members"."archived_at" is not null);--> statement-breakpoint
CREATE FUNCTION "private"."set_invite_state"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
begin
  if new.user_id is null and new.invite_email is not null
     and (tg_op = 'INSERT' or (old.invite_email is null and old.invite_state = 'accepted')) then
    new.invite_state := 'pending';
  end if;
  return new;
end;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "private"."set_invite_state"() FROM public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER "group_members_set_invite_state" BEFORE INSERT OR UPDATE OF "invite_email" ON "finances"."group_members" FOR EACH ROW EXECUTE FUNCTION "private"."set_invite_state"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.claim_group_invite()
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select null::uuid;
$function$;
