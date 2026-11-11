CREATE OR REPLACE FUNCTION private.maker_in_fund(member_id uuid, from_account_id uuid, to_account_id uuid, for_household boolean)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- Nobody is always fine; a named member must belong to the fund the movement sits in: the fund of a
  -- fund account it touches, or, for a household bill paid from a personal card, the payer's own fund.
  select member_id is null or exists (
    select 1
    from finances.group_members m
    where m.id = member_id
      and (
        m.group_id in (select a.group_id from finances.accounts a where a.id in (from_account_id, to_account_id) and a.group_id is not null)
        or (for_household and m.group_id = (
          select private.owner_group_id(a.owner_user_id) from finances.accounts a where a.id = from_account_id
        ))
      )
  );
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.maker_in_fund(uuid, uuid, uuid, boolean) FROM public, anon, service_role;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.maker_in_fund(uuid, uuid, uuid, boolean) TO authenticated;--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD COLUMN "made_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD CONSTRAINT "transactions_made_by_member_id_group_members_id_fk" FOREIGN KEY ("made_by_member_id") REFERENCES "finances"."group_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER POLICY "transactions_insert_writable" ON "finances"."transactions" TO authenticated WITH CHECK ((select private.can_write_transaction("finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id")) and (select private.contributor_in_fund("finances"."transactions"."contributed_by_member_id", "finances"."transactions"."to_account_id")) and (select private.maker_in_fund("finances"."transactions"."made_by_member_id", "finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id", "finances"."transactions"."for_household")));--> statement-breakpoint
ALTER POLICY "transactions_update_writable" ON "finances"."transactions" TO authenticated USING ((select private.can_write_transaction("finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id")) and "finances"."transactions"."reconciliation_id" is null) WITH CHECK ((select private.can_write_transaction("finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id")) and (select private.contributor_in_fund("finances"."transactions"."contributed_by_member_id", "finances"."transactions"."to_account_id")) and (select private.maker_in_fund("finances"."transactions"."made_by_member_id", "finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id", "finances"."transactions"."for_household")));--> statement-breakpoint
GRANT INSERT (made_by_member_id), UPDATE (made_by_member_id) ON TABLE "finances"."transactions" TO authenticated;
