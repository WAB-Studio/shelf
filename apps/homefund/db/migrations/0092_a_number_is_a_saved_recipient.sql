CREATE TABLE "finances"."recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"account_id" uuid,
	"category_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipients_identifier_digits" CHECK ("finances"."recipients"."identifier" ~ '^[0-9]{4,20}$'),
	CONSTRAINT "recipients_name_length" CHECK (length(btrim("finances"."recipients"."name")) between 1 and 80),
	CONSTRAINT "recipients_kind_valid" CHECK ("finances"."recipients"."kind" in ('own_account', 'person', 'payee')),
	CONSTRAINT "recipients_account_by_kind" CHECK ("finances"."recipients"."account_id" is null or "finances"."recipients"."kind" in ('own_account', 'person')),
	CONSTRAINT "recipients_category_by_kind" CHECK ("finances"."recipients"."category_id" is null or "finances"."recipients"."kind" = 'payee')
);
--> statement-breakpoint
ALTER TABLE "finances"."recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" DROP CONSTRAINT "ingest_deliveries_proposed_direction_valid";--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" DROP CONSTRAINT "ingest_deliveries_category_source_valid";--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD COLUMN "proposed_to_account_id" uuid;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD COLUMN "extracted_identifier" text;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD COLUMN "recipient_id" uuid;--> statement-breakpoint
ALTER TABLE "finances"."recipients" ADD CONSTRAINT "recipients_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "finances"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."recipients" ADD CONSTRAINT "recipients_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "finances"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."recipients" ADD CONSTRAINT "recipients_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "finances"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recipients_owner_identifier_unique" ON "finances"."recipients" USING btree ("owner_user_id","identifier");--> statement-breakpoint
CREATE INDEX "recipients_account_id_idx" ON "finances"."recipients" USING btree ("account_id") WHERE "finances"."recipients"."account_id" is not null;--> statement-breakpoint
CREATE INDEX "recipients_category_id_idx" ON "finances"."recipients" USING btree ("category_id") WHERE "finances"."recipients"."category_id" is not null;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_proposed_to_account_id_accounts_id_fk" FOREIGN KEY ("proposed_to_account_id") REFERENCES "finances"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_recipient_id_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "finances"."recipients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_deliveries_proposed_to_account_id_idx" ON "finances"."ingest_deliveries" USING btree ("proposed_to_account_id") WHERE "finances"."ingest_deliveries"."proposed_to_account_id" is not null;--> statement-breakpoint
CREATE INDEX "ingest_deliveries_recipient_id_idx" ON "finances"."ingest_deliveries" USING btree ("recipient_id") WHERE "finances"."ingest_deliveries"."recipient_id" is not null;--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_extracted_identifier_digits" CHECK ("finances"."ingest_deliveries"."extracted_identifier" is null or "finances"."ingest_deliveries"."extracted_identifier" ~ '^[0-9]{4,20}$');--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_proposed_direction_valid" CHECK ("finances"."ingest_deliveries"."proposed_direction" is null or "finances"."ingest_deliveries"."proposed_direction" in ('income', 'expense', 'transfer'));--> statement-breakpoint
ALTER TABLE "finances"."ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_category_source_valid" CHECK ("finances"."ingest_deliveries"."category_source" is null or "finances"."ingest_deliveries"."category_source" in ('merchant', 'interpreter', 'credential_default', 'recipient'));--> statement-breakpoint
CREATE POLICY "recipients_select" ON "finances"."recipients" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("finances"."recipients"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "recipients_insert" ON "finances"."recipients" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("finances"."recipients"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "recipients_update" ON "finances"."recipients" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("finances"."recipients"."owner_user_id" = (select auth.uid())) WITH CHECK ("finances"."recipients"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "recipients_delete" ON "finances"."recipients" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("finances"."recipients"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
ALTER TABLE "finances"."recipients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- RF-189, hand-written: drizzle-kit diffs neither a grant nor a trigger. All three API roles are revoked
-- before `authenticated` gets back what the policies gate; the owner is named by the caller and the policy
-- pins it to `auth.uid()`. The three new delivery columns are written by ingest alone, on insert.
REVOKE ALL ON TABLE "finances"."recipients" FROM public, anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT ON TABLE "finances"."recipients" TO authenticated;--> statement-breakpoint
GRANT INSERT (owner_user_id, identifier, name, kind, account_id, category_id) ON TABLE "finances"."recipients" TO authenticated;--> statement-breakpoint
GRANT UPDATE (identifier, name, kind, account_id, category_id) ON TABLE "finances"."recipients" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "finances"."recipients" TO authenticated;--> statement-breakpoint
GRANT SELECT (proposed_to_account_id, extracted_identifier, recipient_id) ON TABLE "finances"."ingest_deliveries" TO authenticated;--> statement-breakpoint
GRANT INSERT (proposed_to_account_id, extracted_identifier, recipient_id) ON TABLE "finances"."ingest_deliveries" TO authenticated;--> statement-breakpoint
CREATE TRIGGER recipients_set_timestamps BEFORE INSERT OR UPDATE ON "finances"."recipients"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."recipients"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
