CREATE TABLE "finances"."deferrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"instalments" smallint NOT NULL,
	"created_by" uuid DEFAULT auth.uid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deferrals_transaction_unique" UNIQUE("transaction_id"),
	CONSTRAINT "deferrals_instalments_range" CHECK ("finances"."deferrals"."instalments" between 2 and 72)
);
--> statement-breakpoint
ALTER TABLE "finances"."deferrals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finances"."deferrals" ADD CONSTRAINT "deferrals_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "finances"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."deferrals" ADD CONSTRAINT "deferrals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "finances"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."deferrals" ADD CONSTRAINT "deferrals_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "finances"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deferrals_account_id_idx" ON "finances"."deferrals" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "deferrals_created_by_idx" ON "finances"."deferrals" USING btree ("created_by");--> statement-breakpoint
CREATE POLICY "deferrals_select" ON "finances"."deferrals" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select private.can_read_account("finances"."deferrals"."account_id")));--> statement-breakpoint
CREATE POLICY "deferrals_insert" ON "finances"."deferrals" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select private.can_write_account("finances"."deferrals"."account_id")));--> statement-breakpoint
CREATE POLICY "deferrals_delete" ON "finances"."deferrals" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select private.can_write_account("finances"."deferrals"."account_id")));--> statement-breakpoint
ALTER TABLE "finances"."deferrals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Supabase grants anon/authenticated/service_role at CREATE TABLE; every one of the three is revoked
-- before `authenticated` is re-granted, column by column. `created_by` is the column default's.
REVOKE ALL ON TABLE "finances"."deferrals" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT (id, transaction_id, account_id, instalments, created_by, created_at) ON TABLE "finances"."deferrals" TO authenticated;--> statement-breakpoint
GRANT INSERT (transaction_id, account_id, instalments) ON TABLE "finances"."deferrals" TO authenticated;--> statement-breakpoint
-- No UPDATE: a change of count is a delete and a new insert.
GRANT DELETE ON TABLE "finances"."deferrals" TO authenticated;--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."deferrals"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
