-- RF-312, hand-written: drizzle-kit diffs no grant. The account a person picks on an Inbox card is kept on the
-- pending delivery, so it survives a reload; the table grants its columns one by one.
GRANT UPDATE (proposed_account_id, proposed_to_account_id) ON TABLE "finances"."ingest_deliveries" TO authenticated;
