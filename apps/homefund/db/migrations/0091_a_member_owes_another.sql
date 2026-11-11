CREATE TABLE "finances"."member_debts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"debtor_member_id" uuid NOT NULL,
	"creditor_member_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"occurred_on" date NOT NULL,
	"description" text,
	"created_by" uuid DEFAULT auth.uid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_debts_kind_valid" CHECK ("finances"."member_debts"."kind" in ('debt', 'payment')),
	CONSTRAINT "member_debts_amount_positive" CHECK ("finances"."member_debts"."amount_cents" > 0),
	CONSTRAINT "member_debts_currency_iso" CHECK ("finances"."member_debts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "member_debts_two_members" CHECK ("finances"."member_debts"."debtor_member_id" <> "finances"."member_debts"."creditor_member_id"),
	CONSTRAINT "member_debts_description_length" CHECK (length(btrim("finances"."member_debts"."description")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "finances"."member_debts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finances"."member_debts" ADD CONSTRAINT "member_debts_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "finances"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."member_debts" ADD CONSTRAINT "member_debts_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "finances"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."member_debts" ADD CONSTRAINT "member_debts_debtor_in_fund_fk" FOREIGN KEY ("debtor_member_id","group_id") REFERENCES "finances"."group_members"("id","group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."member_debts" ADD CONSTRAINT "member_debts_creditor_in_fund_fk" FOREIGN KEY ("creditor_member_id","group_id") REFERENCES "finances"."group_members"("id","group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_debts_group_id_idx" ON "finances"."member_debts" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "member_debts_debtor_member_id_idx" ON "finances"."member_debts" USING btree ("debtor_member_id");--> statement-breakpoint
CREATE INDEX "member_debts_creditor_member_id_idx" ON "finances"."member_debts" USING btree ("creditor_member_id");--> statement-breakpoint
CREATE INDEX "member_debts_created_by_idx" ON "finances"."member_debts" USING btree ("created_by");--> statement-breakpoint
CREATE POLICY "member_debts_select_member" ON "finances"."member_debts" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.is_group_member("finances"."member_debts"."group_id")));--> statement-breakpoint
CREATE POLICY "member_debts_insert_member" ON "finances"."member_debts" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.is_group_member("finances"."member_debts"."group_id")));--> statement-breakpoint
CREATE POLICY "member_debts_delete_member" ON "finances"."member_debts" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.is_group_member("finances"."member_debts"."group_id")));--> statement-breakpoint
ALTER TABLE "finances"."member_debts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- RF-183, hand-written: drizzle-kit diffs neither a grant nor a trigger. Supabase grants the three API roles at
-- CREATE TABLE; all are revoked before `authenticated` gets back what the policies above gate. No UPDATE: an
-- entry is corrected by removing it and writing it again. `created_by` is the column default's.
REVOKE ALL ON TABLE "finances"."member_debts" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT (id, group_id, kind, debtor_member_id, creditor_member_id, amount_cents, currency, occurred_on, description, created_by, created_at) ON TABLE "finances"."member_debts" TO authenticated;--> statement-breakpoint
GRANT INSERT (group_id, kind, debtor_member_id, creditor_member_id, amount_cents, currency, occurred_on, description) ON TABLE "finances"."member_debts" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "finances"."member_debts" TO authenticated;--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."member_debts"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
