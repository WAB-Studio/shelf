-- RF-84 calls a statement an immutable historical snapshot, yet 0003 gave it a DELETE policy and a
-- table-level DELETE grant, so whoever could write the account could erase its history. Both go. The
-- foreign key's `on delete cascade` runs outside row security and outside the grant, so a statement
-- still leaves with the account it belongs to and by no other route. The SELECT grant and the
-- column-form INSERT grant are untouched.
DROP POLICY "debt_statements_delete" ON "debt_statements" CASCADE;--> statement-breakpoint
revoke delete on table public.debt_statements from anon, authenticated, service_role;
