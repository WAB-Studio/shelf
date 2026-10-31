CREATE OR REPLACE FUNCTION private.contributor_in_fund(member_id uuid, to_account_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- No contributor is always fine; a named one must belong to the fund that owns the account the money entered.
  select member_id is null or exists (
    select 1
    from finances.group_members m
    join finances.accounts a on a.id = to_account_id
    where m.id = member_id and a.group_id is not null and m.group_id = a.group_id
  );
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.contributor_in_fund(uuid, uuid) FROM public, anon, service_role;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.contributor_in_fund(uuid, uuid) TO authenticated;--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD COLUMN "contributed_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD CONSTRAINT "transactions_contributed_by_member_id_group_members_id_fk" FOREIGN KEY ("contributed_by_member_id") REFERENCES "finances"."group_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD CONSTRAINT "transactions_contributor_income" CHECK ("finances"."transactions"."contributed_by_member_id" is null or "finances"."transactions"."from_account_id" is null);--> statement-breakpoint
ALTER POLICY "transactions_insert_writable" ON "finances"."transactions" TO authenticated WITH CHECK ((select private.can_write_transaction("finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id")) and (select private.contributor_in_fund("finances"."transactions"."contributed_by_member_id", "finances"."transactions"."to_account_id")));--> statement-breakpoint
ALTER POLICY "transactions_update_writable" ON "finances"."transactions" TO authenticated USING ((select private.can_write_transaction("finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id")) and "finances"."transactions"."reconciliation_id" is null) WITH CHECK ((select private.can_write_transaction("finances"."transactions"."from_account_id", "finances"."transactions"."to_account_id")) and (select private.contributor_in_fund("finances"."transactions"."contributed_by_member_id", "finances"."transactions"."to_account_id")));
--> statement-breakpoint
GRANT INSERT (contributed_by_member_id), UPDATE (contributed_by_member_id) ON TABLE "finances"."transactions" TO authenticated;
