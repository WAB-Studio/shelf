-- Q8 a: deleting the account or category a learned rule trusts keeps the rule and forgets its target.
-- Hand-written: the snapshot chain forks at 0052-0054, so drizzle-kit cannot generate from it.
ALTER TABLE "finances"."ingest_counterparties" DROP CONSTRAINT "ingest_counterparties_trusted_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "finances"."ingest_merchants" DROP CONSTRAINT "ingest_merchants_trusted_category_id_categories_id_fk";--> statement-breakpoint
ALTER TABLE "finances"."ingest_counterparties" ADD CONSTRAINT "ingest_counterparties_trusted_account_id_accounts_id_fk" FOREIGN KEY ("trusted_account_id") REFERENCES "finances"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finances"."ingest_merchants" ADD CONSTRAINT "ingest_merchants_trusted_category_id_categories_id_fk" FOREIGN KEY ("trusted_category_id") REFERENCES "finances"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The foreign key nulls the trusted column and leaves `state` behind; this puts the row back to
-- learning in the same UPDATE. A `remember_*` call that nulls the column also sets `ambiguous`, which stays.
CREATE FUNCTION "private"."forget_counterparty_target"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
begin
  if old.trusted_account_id is not null and new.trusted_account_id is null and new.state = 'trusted' then
    new.state := 'learning';
    new.streak := 0;
    new.candidate_account_id := null;
  end if;
  return new;
end;
$$;--> statement-breakpoint
CREATE FUNCTION "private"."forget_merchant_target"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
begin
  if old.trusted_category_id is not null and new.trusted_category_id is null and new.state = 'trusted' then
    new.state := 'learning';
    new.streak := 0;
    new.candidate_category_id := null;
  end if;
  return new;
end;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "private"."forget_counterparty_target"() FROM PUBLIC, anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON FUNCTION "private"."forget_merchant_target"() FROM PUBLIC, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER "ingest_counterparties_forget_target" BEFORE UPDATE ON "finances"."ingest_counterparties" FOR EACH ROW EXECUTE FUNCTION "private"."forget_counterparty_target"();--> statement-breakpoint
CREATE TRIGGER "ingest_merchants_forget_target" BEFORE UPDATE ON "finances"."ingest_merchants" FOR EACH ROW EXECUTE FUNCTION "private"."forget_merchant_target"();
