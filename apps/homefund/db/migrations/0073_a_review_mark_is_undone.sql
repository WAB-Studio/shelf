-- One movement settles one payment (oleada-7 M11b, Q551): settle inserts its own movement, so no row pairs two payments
-- with one. Measured nowhere but here, so the index refuses to build in words if a database already holds a pair.
DO $$
DECLARE
  pairs integer;
BEGIN
  SELECT count(*) INTO pairs FROM (
    SELECT settled_transaction_id FROM finances.planned_payments
    WHERE settled_transaction_id IS NOT NULL
    GROUP BY settled_transaction_id HAVING count(*) > 1
  ) shared;
  IF pairs > 0 THEN
    RAISE EXCEPTION 'planned_payments: % movement(s) settle more than one payment; pair them by hand before 0073', pairs;
  END IF;
END
$$;--> statement-breakpoint
DROP INDEX "finances"."planned_payments_settled_transaction_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "planned_payments_settled_transaction_id_unique" ON "finances"."planned_payments" USING btree ("settled_transaction_id");--> statement-breakpoint
-- «Deshacer» under «Revisados» (RF-163): whoever may write the movement drops its mark.
CREATE POLICY "transaction_reviews_delete" ON "finances"."transaction_reviews" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_transaction_row("finances"."transaction_reviews"."transaction_id")));--> statement-breakpoint
GRANT DELETE ON TABLE "finances"."transaction_reviews" TO authenticated;--> statement-breakpoint
-- RF-164: an edit that changes the amount makes it the person's own, so it no longer reads as one read from words. The
-- column keeps its insert-only grant; the trigger is what clears it.
CREATE OR REPLACE FUNCTION private.transactions_amount_typed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
begin
  if new.amount_cents is distinct from old.amount_cents then
    new.amount_from_words := false;
  end if;
  return new;
end;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.transactions_amount_typed() FROM public, anon, service_role;--> statement-breakpoint
CREATE TRIGGER transactions_amount_typed BEFORE UPDATE OF amount_cents ON "finances"."transactions"
  FOR EACH ROW EXECUTE FUNCTION private.transactions_amount_typed();
