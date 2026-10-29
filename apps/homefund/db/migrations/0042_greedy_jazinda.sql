-- RF-133, RF-135: the mark "waiting for a person" needed and did not have. Every income and every
-- expense is one-sided by design (RF-17), so the shape of the row alone cannot say which ones are
-- actually waiting on a counterparty an ingest reader could not tell — measured against the live
-- database: 8 462 of 8 462 movements are one-sided, and the old `unreviewed` widening (Module 16,
-- first pass) surfaced all of them. This column is the fact itself, set by whoever knows it could
-- not name both sides, cleared by whoever names the second one.
ALTER TABLE "transactions" ADD COLUMN "awaiting_counterparty" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Small and bounded by construction: nothing sets this true yet (no ingest reader exists), so the
-- index starts empty and only ever indexes the rows a screen actually filters on.
CREATE INDEX "transactions_awaiting_counterparty_idx" ON "transactions" USING btree ("awaiting_counterparty") WHERE "transactions"."awaiting_counterparty" = true;--> statement-breakpoint
-- Column-scoped like every grant on this table (0001, mirrored by 0040 for `caused_by_transaction_id`).
-- SELECT is already table-wide from 0001 and covers a column added later; only the two writes the
-- model allows need naming here. No policy changes: `transactions_insert_writable` and
-- `transactions_update_writable` already gate the row by its own accounts.
GRANT INSERT (awaiting_counterparty), UPDATE (awaiting_counterparty) ON TABLE "transactions" TO authenticated;