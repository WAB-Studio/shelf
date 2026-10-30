CREATE TABLE "finances"."reminder_mails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"planned_payment_id" uuid NOT NULL,
	"remind_on" date NOT NULL,
	"mailed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finances"."reminder_mails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finances"."reminder_mails" ADD CONSTRAINT "reminder_mails_planned_payment_id_planned_payments_id_fk" FOREIGN KEY ("planned_payment_id") REFERENCES "finances"."planned_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_mails_payment_date_unique" ON "finances"."reminder_mails" USING btree ("planned_payment_id","remind_on");--> statement-breakpoint
-- `finances` is a schema Supabase did not make, so no grant arrives at CREATE TABLE; revoked all the same. No policy:
-- only the server's pool reads and writes it (RF-141).
REVOKE ALL ON TABLE "finances"."reminder_mails" FROM "anon", "authenticated", "service_role";--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "finances"."reminder_mails"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
