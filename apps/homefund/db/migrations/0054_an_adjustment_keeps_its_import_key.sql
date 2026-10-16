ALTER TABLE "finances"."account_reconciliations" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "finances"."account_reconciliations" ADD CONSTRAINT "account_reconciliations_external_ref_length" CHECK (length("finances"."account_reconciliations"."external_ref") <= 200);--> statement-breakpoint
-- The column joins the per-column INSERT grant; nothing else about the table's grants moves.
GRANT INSERT (external_ref) ON TABLE "finances"."account_reconciliations" TO authenticated;--> statement-breakpoint
-- The booked movement carries the reconciliation's key, so an exported adjustment re-imported into
-- another scope is recognised on a second import. A null key leaves the movement's own id to stand in.
CREATE OR REPLACE FUNCTION private.book_reconciliation_adjustment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_account finances.accounts;
  v_gap bigint;
begin
  select * into v_account from finances.accounts where id = new.account_id;
  v_gap := new.counted_balance_cents - private.account_settlement_balance_on(new.account_id, new.reconciled_on);
  if v_gap = 0 then
    return null;
  end if;
  insert into finances.transactions
    (owner_user_id, group_id, from_account_id, to_account_id, amount_cents, currency,
     occurred_at, description, reconciliation_id, external_ref, created_by)
  values
    (v_account.owner_user_id, v_account.group_id,
     case when v_gap < 0 then new.account_id end,
     case when v_gap > 0 then new.account_id end,
     abs(v_gap), v_account.settlement_currency,
     new.reconciled_on, null, new.id, new.external_ref, new.created_by);
  return null;
end;
$function$;
