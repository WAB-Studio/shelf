-- The rename in `0044` left the trail split: every row the audit trigger wrote before it still
-- carries `entity = 'debt_statements'`, a table no longer in the catalogue, so the audit screen
-- resolves no label for it and prints the raw name beside its labelled neighbours.
--
-- This deliberately rewrites history. It overrides the standing rule that `audit_log` is never
-- touched, and it makes a row dated 2026-08 assert a table name that only existed from 2026-09.
-- The user chose that trade with both costs stated: one readable trail over a faithful one. Read a
-- pre-2026-09 `account_statements` row as "the table now called that", never as the name in force
-- on the date beside it.
UPDATE "audit_log" SET "entity" = 'account_statements' WHERE "entity" = 'debt_statements';
