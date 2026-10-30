ALTER TABLE "finances"."transactions" ADD COLUMN "for_household" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "finances"."transactions" ADD CONSTRAINT "transactions_for_household_expense" CHECK (not "finances"."transactions"."for_household" or "finances"."transactions"."to_account_id" is null);--> statement-breakpoint
GRANT INSERT (for_household), UPDATE (for_household) ON TABLE "finances"."transactions" TO authenticated;
