-- RF-178: a liability is a card or a loan. Both CHECKs name the old list, so they go first and come back over the new one.
ALTER TABLE "finances"."accounts" DROP CONSTRAINT "accounts_subtype_kind";--> statement-breakpoint
ALTER TABLE "finances"."accounts" DROP CONSTRAINT "accounts_subtype_valid";--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_subtype_valid" CHECK (subtype in ('bank','cash','card','loan'));--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_subtype_kind" CHECK ((subtype in ('cash','bank') and kind = 'asset') or (subtype in ('card','loan') and kind = 'liability'));--> statement-breakpoint
-- Hand-written: drizzle-kit diffs no function. The trigger `accounts_set_subtype` (BEFORE INSERT) is unchanged; an explicit
-- cash or loan survives, every other value follows the kind. A loan on an asset is kept so the CHECK refuses it.
CREATE OR REPLACE FUNCTION private.set_account_subtype()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.subtype in ('cash', 'efectivo') then
    new.subtype := 'cash';
  elsif new.subtype = 'loan' then
    new.subtype := 'loan';
  else
    new.subtype := case when new.kind = 'liability' then 'card' else 'bank' end;
  end if;
  return new;
end;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.set_account_subtype() FROM public, anon, authenticated, service_role;
