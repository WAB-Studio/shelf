-- An aporte carried no date of its own: a virtual one earmarks no movement, so the list that has to
-- show a date per row (RF-119) had none for it. The default stamps it, and the column stays outside
-- the per-column INSERT and UPDATE grants of 0002 — the caller names it never, the database always.
-- `GRANT SELECT` on this table is table-wide, so the new column is readable without a grant here.
ALTER TABLE "goal_contributions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
