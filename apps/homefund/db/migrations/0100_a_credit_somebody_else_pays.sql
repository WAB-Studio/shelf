CREATE TABLE "finances"."third_party_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"liability_account_id" uuid NOT NULL,
	"receivable_account_id" uuid NOT NULL,
	"person_name" text NOT NULL,
	"installment_cents" bigint,
	"due_day" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "third_party_credits_person_name_length" CHECK (length(btrim("finances"."third_party_credits"."person_name")) between 1 and 80),
	CONSTRAINT "third_party_credits_installment_positive" CHECK ("finances"."third_party_credits"."installment_cents" is null or "finances"."third_party_credits"."installment_cents" > 0),
	CONSTRAINT "third_party_credits_due_day_valid" CHECK ("finances"."third_party_credits"."due_day" is null or "finances"."third_party_credits"."due_day" between 1 and 31),
	CONSTRAINT "third_party_credits_two_accounts" CHECK ("finances"."third_party_credits"."liability_account_id" <> "finances"."third_party_credits"."receivable_account_id")
);
--> statement-breakpoint
ALTER TABLE "finances"."third_party_credits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finances"."third_party_credits" ADD CONSTRAINT "third_party_credits_liability_account_id_accounts_id_fk" FOREIGN KEY ("liability_account_id") REFERENCES "finances"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."third_party_credits" ADD CONSTRAINT "third_party_credits_receivable_account_id_accounts_id_fk" FOREIGN KEY ("receivable_account_id") REFERENCES "finances"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "third_party_credits_liability_unique" ON "finances"."third_party_credits" USING btree ("liability_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "third_party_credits_receivable_unique" ON "finances"."third_party_credits" USING btree ("receivable_account_id");--> statement-breakpoint
CREATE POLICY "third_party_credits_select" ON "finances"."third_party_credits" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.can_read_account("finances"."third_party_credits"."liability_account_id")));--> statement-breakpoint
CREATE POLICY "third_party_credits_insert" ON "finances"."third_party_credits" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((select private.can_write_account("finances"."third_party_credits"."liability_account_id")) and (select private.can_write_account("finances"."third_party_credits"."receivable_account_id"))));--> statement-breakpoint
CREATE POLICY "third_party_credits_update" ON "finances"."third_party_credits" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.can_write_account("finances"."third_party_credits"."liability_account_id"))) WITH CHECK ((select private.can_write_account("finances"."third_party_credits"."liability_account_id")));--> statement-breakpoint
CREATE POLICY "third_party_credits_delete" ON "finances"."third_party_credits" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_account("finances"."third_party_credits"."liability_account_id")));--> statement-breakpoint
ALTER TABLE "finances"."third_party_credits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- RF-211, hand-written: drizzle-kit diffs neither a grant nor a trigger. All three API roles are revoked
-- before `authenticated` gets back what the policies gate. The two accounts are named once, on insert; an edit
-- moves only who pays and what the lender asks.
REVOKE ALL ON TABLE "finances"."third_party_credits" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "finances"."third_party_credits" TO authenticated;--> statement-breakpoint
GRANT INSERT (liability_account_id, receivable_account_id, person_name, installment_cents, due_day) ON TABLE "finances"."third_party_credits" TO authenticated;--> statement-breakpoint
GRANT UPDATE (person_name, installment_cents, due_day) ON TABLE "finances"."third_party_credits" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "finances"."third_party_credits" TO authenticated;--> statement-breakpoint
-- A credit paid by another person links a liability to an asset of its own scope and currency, so what the
-- payer still owes and what the credit still owes are read in one currency (TP001). Security definer: the
-- two accounts are read whole, whatever the caller's policies show of them.
CREATE OR REPLACE FUNCTION private.assert_third_party_credit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
declare
  liability finances.accounts;
  receivable finances.accounts;
begin
  select * into liability from finances.accounts a where a.id = new.liability_account_id;
  select * into receivable from finances.accounts a where a.id = new.receivable_account_id;
  if liability.id is null
     or receivable.id is null
     or liability.kind <> 'liability'
     or receivable.kind <> 'asset'
     or liability.owner_user_id is distinct from receivable.owner_user_id
     or liability.group_id is distinct from receivable.group_id
     or liability.settlement_currency <> receivable.settlement_currency then
    raise exception 'a credit someone else pays links a liability to an asset of its own scope and currency' using errcode = 'TP001';
  end if;
  return new;
end;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_third_party_credit() FROM public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER third_party_credits_assert_accounts BEFORE INSERT ON "finances"."third_party_credits"
  FOR EACH ROW EXECUTE FUNCTION private.assert_third_party_credit();--> statement-breakpoint
CREATE TRIGGER third_party_credits_set_timestamps BEFORE INSERT OR UPDATE ON "finances"."third_party_credits"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."third_party_credits"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
