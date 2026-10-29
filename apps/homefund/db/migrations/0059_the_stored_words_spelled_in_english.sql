-- RF-56: the stored subtype reads `bank`, `cash` or `card`. Both CHECKs name the old words, so they go first
-- and come back over the new ones; a row the UPDATE missed fails the re-added CHECK by its name.
ALTER TABLE "finances"."accounts" DROP CONSTRAINT "accounts_subtype_kind";--> statement-breakpoint
ALTER TABLE "finances"."accounts" DROP CONSTRAINT "accounts_subtype_valid";--> statement-breakpoint
-- Hand-written: drizzle-kit diffs no data. No trigger is disabled, so capture_audit writes one UPDATE row per
-- account (RF-45). The WHERE keeps a row already in the new words out of the CASE, which would null it.
UPDATE "finances"."accounts"
SET "subtype" = CASE "subtype" WHEN 'bancaria' THEN 'bank' WHEN 'efectivo' THEN 'cash' WHEN 'tarjeta' THEN 'card' END
WHERE "subtype" IN ('bancaria', 'efectivo', 'tarjeta');--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_subtype_valid" CHECK (subtype in ('bank','cash','card'));--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_subtype_kind" CHECK ((subtype in ('cash','bank') and kind = 'asset') or (subtype = 'card' and kind = 'liability'));--> statement-breakpoint
ALTER TABLE "finances"."accounts" ALTER COLUMN "subtype" SET DEFAULT 'bank';--> statement-breakpoint
-- Hand-written: drizzle-kit diffs no function. The trigger `accounts_set_subtype` (BEFORE INSERT) is unchanged;
-- only an explicit cash survives, every other value follows the kind.
CREATE OR REPLACE FUNCTION private.set_account_subtype()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- 'efectivo' is the deploy window's branch, removed later.
  if new.subtype in ('cash', 'efectivo') then
    new.subtype := 'cash';
  else
    new.subtype := case when new.kind = 'liability' then 'card' else 'bank' end;
  end if;
  return new;
end;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.set_account_subtype() FROM public, anon, authenticated, service_role;
