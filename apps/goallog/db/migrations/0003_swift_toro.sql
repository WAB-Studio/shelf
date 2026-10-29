-- Measured 2026-09-27 (module 38): every `(commitment_id, day)` group with
-- more than one fact belongs to a harness identity — none to a real person,
-- who would have stopped this migration before it was written. Keeps each
-- group's latest `written_at`, the row the day already shows
-- (`lib/day/logged-fact.ts`'s own rule), and drops the rest, so the unique
-- index below has nothing left to refuse. A row with no sibling in its group
-- is always its own `max(written_at)` and is never touched by this DELETE.
DELETE FROM "goals"."facts" f
USING "auth"."users" u
WHERE f.user_id = u.id
  AND u.email LIKE 'harness%@example.invalid'
  AND f.commitment_id IS NOT NULL
  AND f.written_at < (
    SELECT max(f2.written_at)
    FROM "goals"."facts" f2
    WHERE f2.commitment_id = f.commitment_id
      AND f2.day = f.day
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "facts_commitment_day_unique" ON "goals"."facts" USING btree ("commitment_id","day") WHERE "goals"."facts"."commitment_id" is not null;