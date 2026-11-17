ALTER TABLE "finances"."accounts" DROP CONSTRAINT "accounts_subtype_valid";--> statement-breakpoint
ALTER TABLE "finances"."accounts" DROP CONSTRAINT "accounts_subtype_kind";--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_subtype_valid" CHECK ("finances"."accounts"."subtype" in ('bank', 'cash', 'card', 'loan', 'receivable'));--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_subtype_kind" CHECK (("finances"."accounts"."subtype" in ('cash', 'bank', 'receivable') and "finances"."accounts"."kind" = 'asset') or ("finances"."accounts"."subtype" in ('card', 'loan') and "finances"."accounts"."kind" = 'liability'));--> statement-breakpoint
-- Hand-written: drizzle-kit diffs no function. The trigger `accounts_set_subtype` (BEFORE INSERT) is unchanged; an explicit
-- cash, loan or receivable survives, every other value follows the kind. A receivable on a liability is kept so the CHECK refuses it.
CREATE OR REPLACE FUNCTION private.set_account_subtype()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.subtype in ('cash', 'efectivo') then
    new.subtype := 'cash';
  elsif new.subtype in ('loan', 'receivable') then
    null;
  else
    new.subtype := case when new.kind = 'liability' then 'card' else 'bank' end;
  end if;
  return new;
end;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.set_account_subtype() FROM public, anon, authenticated, service_role;
