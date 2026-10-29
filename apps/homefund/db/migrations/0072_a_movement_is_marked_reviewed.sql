CREATE TABLE "finances"."transaction_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"marked_by" uuid NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_reviews_transaction_rule_unique" UNIQUE("transaction_id","rule"),
	CONSTRAINT "transaction_reviews_rule" CHECK ("finances"."transaction_reviews"."rule" in ('above_usual', 'twin', 'from_words', 'reconciliation_gap'))
);
--> statement-breakpoint
ALTER TABLE "finances"."transaction_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD COLUMN "amount_from_words" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "finances"."transaction_reviews" ADD CONSTRAINT "transaction_reviews_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "finances"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."transaction_reviews" ADD CONSTRAINT "transaction_reviews_marked_by_app_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "finances"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_reviews_marked_by_idx" ON "finances"."transaction_reviews" USING btree ("marked_by");--> statement-breakpoint
CREATE POLICY "transaction_reviews_select" ON "finances"."transaction_reviews" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.can_read_transaction("finances"."transaction_reviews"."transaction_id")));--> statement-breakpoint
CREATE POLICY "transaction_reviews_insert" ON "finances"."transaction_reviews" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_transaction_row("finances"."transaction_reviews"."transaction_id")));--> statement-breakpoint
ALTER TABLE "finances"."transaction_reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Supabase grants anon/authenticated/service_role at CREATE TABLE; every one of the three is revoked
-- before `authenticated` is re-granted, column by column. No UPDATE, no DELETE: a mark is final.
REVOKE ALL ON TABLE "finances"."transaction_reviews" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "finances"."transaction_reviews" TO authenticated;--> statement-breakpoint
GRANT INSERT (transaction_id, rule) ON TABLE "finances"."transaction_reviews" TO authenticated;--> statement-breakpoint
-- Insert only: an edit never says the amount came from words.
GRANT INSERT (amount_from_words) ON TABLE "finances"."transactions" TO authenticated;--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.transaction_reviews_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
begin
  -- An owner-role write with no settled claim keeps the actor it named, as the movement triggers do.
  if (select auth.uid()) is not null then
    new.marked_by := (select auth.uid());
  end if;
  return new;
end;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.transaction_reviews_stamp() FROM public, anon, service_role;--> statement-breakpoint
CREATE TRIGGER transaction_reviews_stamp BEFORE INSERT ON "finances"."transaction_reviews"
  FOR EACH ROW EXECUTE FUNCTION private.transaction_reviews_stamp();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."transaction_reviews"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
