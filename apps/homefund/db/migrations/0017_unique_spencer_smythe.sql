-- `account_balances` sums the movements on each side of every account, and the predicate names
-- the account alone. The scope-leading composites of 0001 are prefixed by group_id/owner_user_id,
-- so neither serves it and the view scanned `transactions` twice per account. Partial: a null side
-- is the other kind of movement and never matches an account id.
CREATE INDEX "transactions_from_account_id_idx" ON "transactions" USING btree ("from_account_id") WHERE from_account_id is not null;--> statement-breakpoint
CREATE INDEX "transactions_to_account_id_idx" ON "transactions" USING btree ("to_account_id") WHERE to_account_id is not null;
