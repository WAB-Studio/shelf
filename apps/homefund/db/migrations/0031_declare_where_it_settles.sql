-- RF-121: an account declares the currency it settles in, and the group the one it reports in. The
-- check is the shape of ISO 4217, never a list of codes, so a new currency costs no migration; the
-- short list a person picks from is an interface question. `default 'COP'` leaves every row already
-- stored coherent with its amounts, so nothing is back-filled: `accounts.initial_balance_cents` is
-- read from here on as the minor unit of `settlement_currency`, and it was already in pesos.
ALTER TABLE "accounts" ADD COLUMN "settlement_currency" text DEFAULT 'COP' NOT NULL;--> statement-breakpoint
-- `groups.currency` has stood since 0000 with no shape at all. Named, not renamed: SPEC §2 documents
-- the column and a rename buys nothing.
ALTER TABLE "groups" ADD CONSTRAINT "groups_currency_iso" CHECK ("groups"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_settlement_currency_iso" CHECK ("accounts"."settlement_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
-- The grants the two columns need, and the whole of what this migration opens. `groups` has carried
-- `GRANT UPDATE (name, cash_mode)` since 0000, so without widening it a leader's currency change
-- answers `UPDATE 0` with no error whatever and reads exactly like a policy refusal.
GRANT INSERT (settlement_currency), UPDATE (settlement_currency) ON TABLE "accounts" TO authenticated;--> statement-breakpoint
GRANT UPDATE (currency) ON TABLE "groups" TO authenticated;
