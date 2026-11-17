CREATE TABLE "finances"."card_deferrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"authorization_number" text NOT NULL,
	"description" text NOT NULL,
	"currency" text NOT NULL,
	"original_amount_cents" bigint NOT NULL,
	"instalments" smallint NOT NULL,
	"current_instalment" smallint NOT NULL,
	"monthly_instalment_cents" bigint NOT NULL,
	"pending_balance_cents" bigint NOT NULL,
	"annual_rate" numeric NOT NULL,
	"statement_on" date NOT NULL,
	"created_by" uuid DEFAULT auth.uid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_deferrals_account_authorization_unique" UNIQUE("account_id","authorization_number"),
	CONSTRAINT "card_deferrals_authorization_length" CHECK (length(btrim("finances"."card_deferrals"."authorization_number")) between 1 and 40),
	CONSTRAINT "card_deferrals_description_length" CHECK (length(btrim("finances"."card_deferrals"."description")) between 1 and 200),
	CONSTRAINT "card_deferrals_currency_shape" CHECK ("finances"."card_deferrals"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "card_deferrals_original_positive" CHECK ("finances"."card_deferrals"."original_amount_cents" > 0),
	CONSTRAINT "card_deferrals_instalments_range" CHECK ("finances"."card_deferrals"."instalments" between 1 and 120),
	CONSTRAINT "card_deferrals_current_instalment_range" CHECK ("finances"."card_deferrals"."current_instalment" between 1 and "finances"."card_deferrals"."instalments"),
	CONSTRAINT "card_deferrals_monthly_non_negative" CHECK ("finances"."card_deferrals"."monthly_instalment_cents" >= 0),
	CONSTRAINT "card_deferrals_pending_non_negative" CHECK ("finances"."card_deferrals"."pending_balance_cents" >= 0),
	CONSTRAINT "card_deferrals_rate_range" CHECK ("finances"."card_deferrals"."annual_rate" >= 0 and "finances"."card_deferrals"."annual_rate" <= 2)
);
--> statement-breakpoint
ALTER TABLE "finances"."card_deferrals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finances"."card_deferrals" ADD CONSTRAINT "card_deferrals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "finances"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."card_deferrals" ADD CONSTRAINT "card_deferrals_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "finances"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "card_deferrals_select" ON "finances"."card_deferrals" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.can_read_account("finances"."card_deferrals"."account_id")));--> statement-breakpoint
CREATE POLICY "card_deferrals_insert" ON "finances"."card_deferrals" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_account("finances"."card_deferrals"."account_id")));--> statement-breakpoint
CREATE POLICY "card_deferrals_update" ON "finances"."card_deferrals" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select private.can_write_account("finances"."card_deferrals"."account_id"))) WITH CHECK ((select private.can_write_account("finances"."card_deferrals"."account_id")));--> statement-breakpoint
CREATE POLICY "card_deferrals_delete" ON "finances"."card_deferrals" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_account("finances"."card_deferrals"."account_id")));--> statement-breakpoint
ALTER TABLE "finances"."card_deferrals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- RF-258, hand-written: drizzle-kit diffs neither a grant nor a trigger. All three API roles are revoked
-- before `authenticated` gets back what the policies gate. The card and the bank's number are named once, on
-- insert; a later statement rewrites the figures and the day they were read.
REVOKE ALL ON TABLE "finances"."card_deferrals" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "finances"."card_deferrals" TO authenticated;--> statement-breakpoint
GRANT INSERT (account_id, authorization_number, description, currency, original_amount_cents, instalments, current_instalment, monthly_instalment_cents, pending_balance_cents, annual_rate, statement_on) ON TABLE "finances"."card_deferrals" TO authenticated;--> statement-breakpoint
GRANT UPDATE (description, currency, original_amount_cents, instalments, current_instalment, monthly_instalment_cents, pending_balance_cents, annual_rate, statement_on) ON TABLE "finances"."card_deferrals" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "finances"."card_deferrals" TO authenticated;--> statement-breakpoint
-- A deferral hangs off a liability: the bank defers what the card owes. Security definer: the account is read
-- whole, whatever the caller's policies show of it. A card the caller may not write is the policy's refusal.
CREATE OR REPLACE FUNCTION private.assert_card_deferral() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
begin
  if not exists (select 1 from finances.accounts a where a.id = new.account_id and a.kind = 'liability') then
    raise exception 'a card deferral belongs to a liability account' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_card_deferral() FROM public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER card_deferrals_assert_liability BEFORE INSERT ON "finances"."card_deferrals"
  FOR EACH ROW EXECUTE FUNCTION private.assert_card_deferral();--> statement-breakpoint
CREATE TRIGGER card_deferrals_set_timestamps BEFORE INSERT OR UPDATE ON "finances"."card_deferrals"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."card_deferrals"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
