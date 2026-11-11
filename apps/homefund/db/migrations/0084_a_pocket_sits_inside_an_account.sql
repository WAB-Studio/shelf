ALTER TABLE "finances"."accounts" ADD COLUMN "parent_account_id" uuid;--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_parent_account_id_accounts_id_fk" FOREIGN KEY ("parent_account_id") REFERENCES "finances"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_parent_account_id_idx" ON "finances"."accounts" USING btree ("parent_account_id");--> statement-breakpoint
ALTER TABLE "finances"."accounts" ADD CONSTRAINT "accounts_pocket_asset" CHECK ("finances"."accounts"."parent_account_id" is null or ("finances"."accounts"."kind" = 'asset' and "finances"."accounts"."parent_account_id" <> "finances"."accounts"."id"));--> statement-breakpoint
GRANT INSERT (parent_account_id), UPDATE (parent_account_id) ON TABLE "finances"."accounts" TO authenticated;--> statement-breakpoint
-- A pocket (RF-173) sits inside one live asset account of the same owner or group and the same currency, and
-- is never a parent itself (PK001). A parent that has live pockets is not archived and keeps
-- the scope and currency they were opened in (PK002). Security definer: the parent and the pockets may sit in
-- rows the caller's policies do not show. The foreign key is NO ACTION, checked at the end of the statement, so
-- a delete of a parent with its pockets together (a group's cascade, an identity's purge) passes and a delete of
-- the parent alone is a 23503. PK001 is every other refusal of the shape.
CREATE OR REPLACE FUNCTION private.assert_account_pocket() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
declare
  parent finances.accounts;
begin
  if tg_op = 'UPDATE' then
    if exists (select 1 from finances.accounts p where p.parent_account_id = new.id) then
      if new.parent_account_id is not null then
        raise exception 'an account with pockets cannot be a pocket' using errcode = 'PK001';
      end if;
      if (new.archived_at is not null and old.archived_at is null
          and exists (select 1 from finances.accounts p where p.parent_account_id = new.id and p.archived_at is null))
         or new.settlement_currency is distinct from old.settlement_currency
         or new.owner_user_id is distinct from old.owner_user_id
         or new.group_id is distinct from old.group_id then
        raise exception 'an account with pockets keeps its state, scope and currency' using errcode = 'PK002';
      end if;
    end if;
  end if;

  if new.parent_account_id is not null then
    select * into parent from finances.accounts a where a.id = new.parent_account_id;
    if not found
       or parent.kind <> 'asset'
       or parent.parent_account_id is not null
       or parent.owner_user_id is distinct from new.owner_user_id
       or parent.group_id is distinct from new.group_id
       or parent.settlement_currency <> new.settlement_currency
       or (parent.archived_at is not null and new.archived_at is null) then
      raise exception 'a pocket sits inside a live asset account of its own scope and currency' using errcode = 'PK001';
    end if;
  end if;
  return new;
end;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_account_pocket() FROM public, anon, authenticated, service_role;--> statement-breakpoint
CREATE TRIGGER accounts_pocket_holds BEFORE INSERT OR UPDATE ON "finances"."accounts"
  FOR EACH ROW EXECUTE FUNCTION private.assert_account_pocket();
