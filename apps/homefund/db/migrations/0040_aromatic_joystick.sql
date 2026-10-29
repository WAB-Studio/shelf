-- RF-132: a movement may name the movement that caused it — a transfer's own tax or fee. One hop
-- only, self-referencing; `on delete cascade` takes the caused charge with the transfer that made it.
ALTER TABLE "transactions" ADD COLUMN "caused_by_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_caused_by_transaction_id_transactions_id_fk" FOREIGN KEY ("caused_by_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_caused_by_idx" ON "transactions" USING btree ("caused_by_transaction_id") WHERE "transactions"."caused_by_transaction_id" is not null;--> statement-breakpoint
-- A movement is never its own cause.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_caused_by_not_self" CHECK ("transactions"."caused_by_transaction_id" is null or "transactions"."caused_by_transaction_id" <> "transactions"."id");--> statement-breakpoint
-- Column-scoped like every grant on this table. SELECT is already table-wide (0001) and covers a
-- column added later; only the two writes the model allows need naming. No policy changes: the
-- existing `transactions_insert_writable`/`transactions_update_writable` bodies already gate the row
-- by its own accounts, cause or no cause. A foreign key always bypasses row security on the row it
-- references (Postgres's own rule, not a choice made here), so naming a cause the caller cannot
-- read still succeeds at the constraint; what still refuses the caller is `transactions_select_member`
-- the moment they try to read that row back, and `transactions_insert_writable` the moment their own
-- write touches an account that is not theirs.
GRANT INSERT (caused_by_transaction_id), UPDATE (caused_by_transaction_id) ON TABLE "transactions" TO authenticated;