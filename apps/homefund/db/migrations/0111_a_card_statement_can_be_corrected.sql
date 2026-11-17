-- RF-284, hand-written: «last» is a function because a policy that reads its own table recurses. Security
-- definer, so it reads every statement of the account whatever the caller's policies show of it.
CREATE OR REPLACE FUNCTION private.is_last_statement(p_account_id uuid, p_cut_off date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  select not exists (
    select 1 from finances.account_statements s where s.account_id = p_account_id and s.cut_off_date > p_cut_off
  );
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.is_last_statement(uuid, date) FROM public, anon, service_role;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.is_last_statement(uuid, date) TO authenticated;--> statement-breakpoint
CREATE POLICY "account_statements_update" ON "finances"."account_statements" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.can_write_account("finances"."account_statements"."account_id")) and (select private.is_last_statement("finances"."account_statements"."account_id", "finances"."account_statements"."cut_off_date"))) WITH CHECK ((select private.can_write_account("finances"."account_statements"."account_id")));--> statement-breakpoint
CREATE POLICY "account_statements_delete" ON "finances"."account_statements" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_account("finances"."account_statements"."account_id")) and (select private.is_last_statement("finances"."account_statements"."account_id", "finances"."account_statements"."cut_off_date")));--> statement-breakpoint
-- RF-284, hand-written: drizzle-kit diffs no grant. The policies above admit only an account's last statement; these
-- are the column privileges they gate. The period, the cut-off and every printed figure may change; the account
-- and the source never.
GRANT UPDATE (period_start, cut_off_date, payment_due_date, opening_balance_cents, closing_balance_cents, credits_cents, debits_cents, minimum_payment_cents, interest_charged_cents, fees_charged_cents) ON TABLE "finances"."account_statements" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "finances"."account_statements" TO authenticated;
