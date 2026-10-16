-- RF-121: a person declares the currency they settle in, and a budget, a goal or a planned payment
-- of their own that names no account falls back to it — the one question an account and a fund
-- could not answer, since a person may have neither. The check is the shape of ISO 4217, never a
-- list of codes, as in 0031: the column takes any code and the short list a person picks from is an
-- interface question. `default 'COP'` leaves every row already stored reading as what it always was,
-- so nothing is back-filled and no existing budget or goal changes the figure it derives.
ALTER TABLE "app_users" ADD COLUMN "settlement_currency" text DEFAULT 'COP' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_settlement_currency_iso" CHECK ("app_users"."settlement_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
-- The grant, and the whole of what this migration opens. 0019 revoked INSERT and UPDATE table-wide
-- and re-granted them column by column — `insert (id, locale), update (locale)` — so a column added
-- after it is readable and not writable: SELECT is still a table grant and covers it on its own,
-- while an UPDATE naming it answers `UPDATE 0` with no error whatever, which reads exactly like a
-- policy refusal. The same gap 0033 closed on `groups.currency`.
GRANT INSERT (settlement_currency), UPDATE (settlement_currency) ON TABLE "app_users" TO authenticated;
