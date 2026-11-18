CREATE TABLE "finances"."loan_schedule_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"number" smallint NOT NULL,
	"due_on" date NOT NULL,
	"principal_cents" bigint NOT NULL,
	"interest_cents" bigint NOT NULL,
	"insurance_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"remaining_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_schedule_rows_number_unique" UNIQUE("account_id","number"),
	CONSTRAINT "loan_schedule_rows_due_unique" UNIQUE("account_id","due_on"),
	CONSTRAINT "loan_schedule_rows_number_valid" CHECK ("finances"."loan_schedule_rows"."number" between 1 and 600),
	CONSTRAINT "loan_schedule_rows_amounts_non_negative" CHECK ("finances"."loan_schedule_rows"."principal_cents" >= 0 and "finances"."loan_schedule_rows"."interest_cents" >= 0 and "finances"."loan_schedule_rows"."insurance_cents" >= 0 and "finances"."loan_schedule_rows"."remaining_cents" >= 0),
	CONSTRAINT "loan_schedule_rows_total_adds_up" CHECK ("finances"."loan_schedule_rows"."total_cents" = "finances"."loan_schedule_rows"."principal_cents" + "finances"."loan_schedule_rows"."interest_cents" + "finances"."loan_schedule_rows"."insurance_cents"),
	CONSTRAINT "loan_schedule_rows_total_positive" CHECK ("finances"."loan_schedule_rows"."total_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "finances"."loan_schedule_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finances"."loan_schedule_rows" ADD CONSTRAINT "loan_schedule_rows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "finances"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "loan_schedule_rows_select" ON "finances"."loan_schedule_rows" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.can_read_account("finances"."loan_schedule_rows"."account_id")));--> statement-breakpoint
CREATE POLICY "loan_schedule_rows_insert" ON "finances"."loan_schedule_rows" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_account("finances"."loan_schedule_rows"."account_id")));--> statement-breakpoint
CREATE POLICY "loan_schedule_rows_delete" ON "finances"."loan_schedule_rows" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_account("finances"."loan_schedule_rows"."account_id")));--> statement-breakpoint
-- RF-264, hand-written: drizzle-kit diffs neither a grant nor a trigger. All three API roles are revoked before
-- `authenticated` gets back what the policies gate. A schedule is replaced whole (delete, then insert), so no
-- column is ever updated and no UPDATE is granted.
REVOKE ALL ON TABLE "finances"."loan_schedule_rows" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "finances"."loan_schedule_rows" TO authenticated;--> statement-breakpoint
GRANT INSERT (account_id, number, due_on, principal_cents, interest_cents, insurance_cents, total_cents, remaining_cents) ON TABLE "finances"."loan_schedule_rows" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "finances"."loan_schedule_rows" TO authenticated;--> statement-breakpoint
-- A payment schedule belongs to an instalment loan: a liability of subtype loan (LS001). Security definer: the
-- account is read whole, whatever the caller's policies show of it.
CREATE OR REPLACE FUNCTION private.assert_loan_schedule_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
declare
  loan finances.accounts;
begin
  select * into loan from finances.accounts a where a.id = new.account_id;
  if loan.id is null or loan.kind <> 'liability' or loan.subtype <> 'loan' then
    raise exception 'a payment schedule belongs to a loan account' using errcode = 'LS001';
  end if;
  return new;
end;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_loan_schedule_account() FROM public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER loan_schedule_rows_assert_account BEFORE INSERT ON "finances"."loan_schedule_rows"
  FOR EACH ROW EXECUTE FUNCTION private.assert_loan_schedule_account();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."loan_schedule_rows"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
