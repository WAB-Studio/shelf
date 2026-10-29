ALTER TABLE "goals"."goals" ADD COLUMN "position" integer;--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ADD COLUMN "position" integer;--> statement-breakpoint
ALTER TABLE "goals"."commitments" ADD COLUMN "position" integer;--> statement-breakpoint
-- Backfill per person: creation time, then the first number in the name
-- («Cap. 2» after «Cap. 1» when one import statement stamped both), then the
-- name, then the id.
UPDATE "goals"."goals" t SET "position" = r.rn
FROM (
  SELECT id, row_number() OVER (
    PARTITION BY user_id
    ORDER BY created_at, substring(name from '\d+')::numeric NULLS LAST, name, id
  ) AS rn
  FROM "goals"."goals"
) r
WHERE t.id = r.id;
--> statement-breakpoint
ALTER TABLE "goals"."goals" ALTER COLUMN "position" SET NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "goals"."goals_fill_position"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.position IS NULL THEN
    NEW.position := (SELECT coalesce(max(p.position), 0) + 1 FROM goals.goals p WHERE p.user_id = NEW.user_id);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "goals_fill_position" BEFORE INSERT ON "goals"."goals"
FOR EACH ROW EXECUTE FUNCTION "goals"."goals_fill_position"();
--> statement-breakpoint
GRANT INSERT (position) ON TABLE "goals"."goals" TO "authenticated";
--> statement-breakpoint
UPDATE "goals"."one_offs" t SET "position" = r.rn
FROM (
  SELECT id, row_number() OVER (
    PARTITION BY user_id
    ORDER BY created_at, substring(name from '\d+')::numeric NULLS LAST, name, id
  ) AS rn
  FROM "goals"."one_offs"
) r
WHERE t.id = r.id;
--> statement-breakpoint
ALTER TABLE "goals"."one_offs" ALTER COLUMN "position" SET NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "goals"."one_offs_fill_position"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.position IS NULL THEN
    NEW.position := (SELECT coalesce(max(p.position), 0) + 1 FROM goals.one_offs p WHERE p.user_id = NEW.user_id);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "one_offs_fill_position" BEFORE INSERT ON "goals"."one_offs"
FOR EACH ROW EXECUTE FUNCTION "goals"."one_offs_fill_position"();
--> statement-breakpoint
GRANT INSERT (position) ON TABLE "goals"."one_offs" TO "authenticated";
--> statement-breakpoint
UPDATE "goals"."commitments" t SET "position" = r.rn
FROM (
  SELECT id, row_number() OVER (
    PARTITION BY user_id
    ORDER BY created_at, substring(name from '\d+')::numeric NULLS LAST, name, id
  ) AS rn
  FROM "goals"."commitments"
) r
WHERE t.id = r.id;
--> statement-breakpoint
ALTER TABLE "goals"."commitments" ALTER COLUMN "position" SET NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "goals"."commitments_fill_position"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.position IS NULL THEN
    NEW.position := (SELECT coalesce(max(p.position), 0) + 1 FROM goals.commitments p WHERE p.user_id = NEW.user_id);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "commitments_fill_position" BEFORE INSERT ON "goals"."commitments"
FOR EACH ROW EXECUTE FUNCTION "goals"."commitments_fill_position"();
--> statement-breakpoint
GRANT INSERT (position) ON TABLE "goals"."commitments" TO "authenticated";
