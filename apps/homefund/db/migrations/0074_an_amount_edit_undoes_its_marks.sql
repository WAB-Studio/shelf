-- RF-165: a changed amount is a movement to look at again. «Está bien» on «Muy por encima de lo usual» and «Dos iguales»
-- goes with it, as the one on «read from words» already did (RF-164); a twin's pair needs both marks, so it waits again too.
CREATE OR REPLACE FUNCTION private.transactions_amount_typed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
begin
  if new.amount_cents is distinct from old.amount_cents then
    new.amount_from_words := false;
    delete from finances.transaction_reviews
    where transaction_id = new.id and rule in ('above_usual', 'twin', 'from_words');
  end if;
  return new;
end;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.transactions_amount_typed() FROM public, anon, service_role;
