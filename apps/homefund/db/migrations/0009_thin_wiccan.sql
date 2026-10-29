-- The durable marker of what an account is (RF-56): a bank account, physical cash, or a card.
-- Added nullable, backfilled for every existing row, then locked to NOT NULL — safe on a table
-- that already holds rows. A cash account is `subtype = 'efectivo'`; the group's `cash_mode` no
-- longer needs a running flag to name one.
ALTER TABLE "accounts" ADD COLUMN "subtype" text;--> statement-breakpoint
-- Seeded cash accounts, matched by the es/en names the writer stamps (GROUP_CASH_ACCOUNT_NAME /
-- PERSONAL_CASH_ACCOUNT_NAME). A row a user has since renamed (RF-63) falls through to the kind rules.
UPDATE "accounts" SET "subtype" = 'efectivo'
  WHERE "name" in ('Efectivo del grupo', 'Group cash', 'Mi efectivo', 'My cash');--> statement-breakpoint
-- Every remaining liability is a card; every remaining asset is a bank account.
UPDATE "accounts" SET "subtype" = 'tarjeta' WHERE "kind" = 'liability' AND "subtype" IS NULL;--> statement-breakpoint
UPDATE "accounts" SET "subtype" = 'bancaria' WHERE "kind" = 'asset' AND "subtype" IS NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_subtype_valid" CHECK ("accounts"."subtype" in ('bancaria', 'efectivo', 'tarjeta'));--> statement-breakpoint
-- Cash and bank hold value (asset); a card is money owed (liability). The backfill left zero rows
-- in violation, so the invariant is enforced, not merely documented.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_subtype_kind" CHECK (("accounts"."subtype" in ('efectivo', 'bancaria') and "accounts"."kind" = 'asset') or ("accounts"."subtype" = 'tarjeta' and "accounts"."kind" = 'liability'));--> statement-breakpoint
-- `bancaria` and `tarjeta` are fully fixed by the kind — a bank for an asset, a card for a liability
-- — so the owner-run trigger derives them, and only an explicit `efectivo` (a cash account, RF-56)
-- survives untouched. The caller may pass `subtype` (the column grant below) or leave it: an omitted
-- value lands on the 'bancaria' default and the trigger then follows the kind.
create or replace function private.set_account_subtype() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.subtype is distinct from 'efectivo' then
    new.subtype := case when new.kind = 'liability' then 'tarjeta' else 'bancaria' end;
  end if;
  return new;
end;
$$;
revoke all on function private.set_account_subtype() from public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER accounts_set_subtype BEFORE INSERT ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION private.set_account_subtype();--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "subtype" SET DEFAULT 'bancaria';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "subtype" SET NOT NULL;--> statement-breakpoint
-- Column-scoped writes so a member can pick a cash account and change it (RF-56): the seed passes
-- 'efectivo' at group creation, the account form offers the choice. Separate grants, narrower than
-- 0000's — RLS and the `can_write_*`/scope policies still bound which rows, the subtype↔kind CHECK
-- the value. The derive trigger stays the fallback for an insert that names no subtype.
GRANT INSERT (subtype) ON TABLE "accounts" TO authenticated;--> statement-breakpoint
GRANT UPDATE (subtype) ON TABLE "accounts" TO authenticated;
