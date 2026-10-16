CREATE TABLE "ingest_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"credential_id" uuid,
	"external_ref" text NOT NULL,
	"raw_text" text NOT NULL,
	"shape_hash" text NOT NULL,
	"merchant_key" text,
	"merchant_label" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"transaction_id" uuid,
	"proposed_amount_cents" bigint,
	"proposed_account_id" uuid,
	"proposed_category_id" uuid,
	"category_source" text,
	"proposed_direction" text,
	"proposed_occurred_at" date,
	"proposed_description" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_deliveries_status_valid" CHECK ("ingest_deliveries"."status" in ('pending', 'accepted', 'rejected')),
	CONSTRAINT "ingest_deliveries_resolved_at_matches_status" CHECK (("ingest_deliveries"."status" = 'pending') = ("ingest_deliveries"."resolved_at" is null)),
	CONSTRAINT "ingest_deliveries_transaction_only_when_accepted" CHECK ("ingest_deliveries"."transaction_id" is null or "ingest_deliveries"."status" = 'accepted'),
	CONSTRAINT "ingest_deliveries_raw_text_length" CHECK (length("ingest_deliveries"."raw_text") between 1 and 500),
	CONSTRAINT "ingest_deliveries_shape_hash_length" CHECK (length("ingest_deliveries"."shape_hash") = 64),
	CONSTRAINT "ingest_deliveries_external_ref_length" CHECK (length("ingest_deliveries"."external_ref") between 1 and 200),
	CONSTRAINT "ingest_deliveries_merchant_key_length" CHECK (length("ingest_deliveries"."merchant_key") <= 120),
	CONSTRAINT "ingest_deliveries_merchant_label_length" CHECK (length("ingest_deliveries"."merchant_label") <= 120),
	CONSTRAINT "ingest_deliveries_proposed_description_length" CHECK (length("ingest_deliveries"."proposed_description") <= 200),
	CONSTRAINT "ingest_deliveries_proposed_amount_positive" CHECK ("ingest_deliveries"."proposed_amount_cents" is null or "ingest_deliveries"."proposed_amount_cents" > 0),
	CONSTRAINT "ingest_deliveries_proposed_direction_valid" CHECK ("ingest_deliveries"."proposed_direction" is null or "ingest_deliveries"."proposed_direction" in ('income', 'expense')),
	CONSTRAINT "ingest_deliveries_category_source_valid" CHECK ("ingest_deliveries"."category_source" is null or "ingest_deliveries"."category_source" in ('merchant', 'interpreter', 'credential_default')),
	CONSTRAINT "ingest_deliveries_category_source_present" CHECK ("ingest_deliveries"."proposed_category_id" is null or "ingest_deliveries"."category_source" is not null)
);
--> statement-breakpoint
ALTER TABLE "ingest_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ingest_shapes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"shape_hash" text NOT NULL,
	"decision" text NOT NULL,
	"sample_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_shapes_decision_valid" CHECK ("ingest_shapes"."decision" in ('approved', 'rejected')),
	CONSTRAINT "ingest_shapes_shape_hash_length" CHECK (length("ingest_shapes"."shape_hash") = 64),
	CONSTRAINT "ingest_shapes_sample_text_length" CHECK (length("ingest_shapes"."sample_text") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "ingest_shapes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ingest_merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"merchant_key" text NOT NULL,
	"merchant_label" text NOT NULL,
	"state" text DEFAULT 'learning' NOT NULL,
	"candidate_category_id" uuid,
	"streak" smallint DEFAULT 0 NOT NULL,
	"trusted_category_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_merchants_state_valid" CHECK ("ingest_merchants"."state" in ('learning', 'trusted', 'ambiguous')),
	CONSTRAINT "ingest_merchants_trusted_category_matches_state" CHECK (("ingest_merchants"."state" = 'trusted') = ("ingest_merchants"."trusted_category_id" is not null)),
	CONSTRAINT "ingest_merchants_streak_range" CHECK ("ingest_merchants"."streak" between 0 and 2),
	CONSTRAINT "ingest_merchants_merchant_key_length" CHECK (length("ingest_merchants"."merchant_key") between 1 and 120),
	CONSTRAINT "ingest_merchants_merchant_label_length" CHECK (length("ingest_merchants"."merchant_label") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "ingest_merchants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_credential_id_webhook_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."webhook_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_proposed_account_id_accounts_id_fk" FOREIGN KEY ("proposed_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_deliveries" ADD CONSTRAINT "ingest_deliveries_proposed_category_id_categories_id_fk" FOREIGN KEY ("proposed_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_shapes" ADD CONSTRAINT "ingest_shapes_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_merchants" ADD CONSTRAINT "ingest_merchants_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_merchants" ADD CONSTRAINT "ingest_merchants_candidate_category_id_categories_id_fk" FOREIGN KEY ("candidate_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_merchants" ADD CONSTRAINT "ingest_merchants_trusted_category_id_categories_id_fk" FOREIGN KEY ("trusted_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_deliveries_owner_external_ref_unique" ON "ingest_deliveries" USING btree ("owner_user_id","external_ref");--> statement-breakpoint
CREATE INDEX "ingest_deliveries_owner_status_idx" ON "ingest_deliveries" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "ingest_deliveries_owner_shape_hash_idx" ON "ingest_deliveries" USING btree ("owner_user_id","shape_hash");--> statement-breakpoint
CREATE INDEX "ingest_deliveries_owner_merchant_key_idx" ON "ingest_deliveries" USING btree ("owner_user_id","merchant_key") WHERE "ingest_deliveries"."merchant_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_shapes_owner_shape_hash_unique" ON "ingest_shapes" USING btree ("owner_user_id","shape_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_merchants_owner_merchant_key_unique" ON "ingest_merchants" USING btree ("owner_user_id","merchant_key");--> statement-breakpoint
CREATE POLICY "ingest_deliveries_select" ON "ingest_deliveries" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("ingest_deliveries"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "ingest_deliveries_insert" ON "ingest_deliveries" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("ingest_deliveries"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "ingest_deliveries_update" ON "ingest_deliveries" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("ingest_deliveries"."owner_user_id" = (select auth.uid())) WITH CHECK ("ingest_deliveries"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "ingest_shapes_select" ON "ingest_shapes" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("ingest_shapes"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "ingest_shapes_insert" ON "ingest_shapes" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("ingest_shapes"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "ingest_shapes_update" ON "ingest_shapes" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("ingest_shapes"."owner_user_id" = (select auth.uid())) WITH CHECK ("ingest_shapes"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "ingest_shapes_delete" ON "ingest_shapes" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("ingest_shapes"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "ingest_merchants_select" ON "ingest_merchants" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("ingest_merchants"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "ingest_merchants_delete" ON "ingest_merchants" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("ingest_merchants"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
-- The database decides land-versus-silence, never the caller (RF-92): the owner is stamped from the
-- session, and the shape memory under that owner settles the status. A shape the person silenced arrives
-- already rejected; an approved shape, or one never seen, waits for review. `status` and `resolved_at`
-- are outside the INSERT grant, so no caller can bypass this by naming them.
create or replace function private.set_ingest_delivery_state() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_decision text;
begin
  new.owner_user_id := (select auth.uid());
  select s.decision into v_decision from public.ingest_shapes s
    where s.owner_user_id = new.owner_user_id and s.shape_hash = new.shape_hash;
  if v_decision = 'rejected' then
    new.status := 'rejected';
    new.resolved_at := pg_catalog.now();
  else
    new.status := 'pending';
    new.resolved_at := null;
  end if;
  return new;
end;
$$;
revoke all on function private.set_ingest_delivery_state() from public, anon, authenticated, service_role;--> statement-breakpoint
-- Owner is stamped from auth.uid() on insert; a shape decision always belongs to whoever made it.
create or replace function private.set_ingest_shape_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.owner_user_id := (select auth.uid());
  return new;
end;
$$;
revoke all on function private.set_ingest_shape_owner() from public, anon, authenticated, service_role;--> statement-breakpoint
-- The only writer of `ingest_merchants` (RF-94), so the trust rule cannot be forged from a client: two
-- consecutive approvals under one category make a merchant trusted, a different category breaks the run,
-- and a category that contradicts a trusted one makes the merchant ambiguous forever. The owner is
-- resolved here, never read from an argument, so no caller reaches another user's row. The locked read
-- serializes two approvals of the same merchant so a streak never double-counts.
create or replace function private.remember_ingest_merchant(p_key text, p_label text, p_category_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := (select auth.uid());
  v_row public.ingest_merchants;
begin
  if v_owner is null then
    raise exception 'remember_ingest_merchant requires an authenticated session';
  end if;

  select * into v_row from public.ingest_merchants m
    where m.owner_user_id = v_owner and m.merchant_key = p_key
    for update;

  if not found then
    insert into public.ingest_merchants
      (owner_user_id, merchant_key, merchant_label, state, candidate_category_id, streak)
    values (v_owner, p_key, p_label, 'learning', p_category_id, 1);
    return;
  end if;

  -- Ambiguity is sticky: no later consistency undoes it, only the person forgetting the merchant.
  if v_row.state = 'ambiguous' then return; end if;

  if v_row.state = 'trusted' then
    if v_row.trusted_category_id = p_category_id then return; end if;
    update public.ingest_merchants
      set state = 'ambiguous', trusted_category_id = null,
          candidate_category_id = p_category_id, streak = 0
      where id = v_row.id;
    return;
  end if;

  if v_row.candidate_category_id = p_category_id then
    update public.ingest_merchants
      set state = 'trusted', trusted_category_id = p_category_id, streak = 2
      where id = v_row.id;
  else
    -- The run broke, so the new category starts its own; nothing is pinned on one approval.
    update public.ingest_merchants
      set candidate_category_id = p_category_id, streak = 1
      where id = v_row.id;
  end if;
end;
$$;
revoke all on function private.remember_ingest_merchant(text, text, uuid) from public, anon, service_role;--> statement-breakpoint
-- The one function a session calls directly: the person's own approval feeds it, and it writes rows the
-- person may read and delete but never insert or update.
grant execute on function private.remember_ingest_merchant(text, text, uuid) to authenticated;--> statement-breakpoint
ALTER TABLE "ingest_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingest_shapes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingest_merchants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "ingest_deliveries" FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON TABLE "ingest_shapes" FROM anon, authenticated, service_role;--> statement-breakpoint
REVOKE ALL ON TABLE "ingest_merchants" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT (id, owner_user_id, credential_id, external_ref, raw_text, shape_hash, merchant_key, merchant_label, status, transaction_id, proposed_amount_cents, proposed_account_id, proposed_category_id, category_source, proposed_direction, proposed_occurred_at, proposed_description, resolved_at, created_at, updated_at) ON TABLE "ingest_deliveries" TO authenticated;--> statement-breakpoint
-- `owner_user_id`, `status` and `resolved_at` are deliberately absent: a caller can neither forge an
-- owner nor insert a delivery that is already resolved.
GRANT INSERT (credential_id, external_ref, raw_text, shape_hash, merchant_key, merchant_label, proposed_amount_cents, proposed_account_id, proposed_category_id, category_source, proposed_direction, proposed_occurred_at, proposed_description) ON TABLE "ingest_deliveries" TO authenticated;--> statement-breakpoint
-- Reviewing a delivery moves only its decision; the message and the proposal stay as they arrived.
GRANT UPDATE (status, resolved_at, transaction_id) ON TABLE "ingest_deliveries" TO authenticated;--> statement-breakpoint
-- No DELETE: a delivery is history, and dropping one would reopen its idempotency key.
GRANT SELECT (id, owner_user_id, shape_hash, decision, sample_text, created_at, updated_at) ON TABLE "ingest_shapes" TO authenticated;--> statement-breakpoint
GRANT INSERT (shape_hash, decision, sample_text) ON TABLE "ingest_shapes" TO authenticated;--> statement-breakpoint
GRANT UPDATE (decision) ON TABLE "ingest_shapes" TO authenticated;--> statement-breakpoint
GRANT DELETE ON TABLE "ingest_shapes" TO authenticated;--> statement-breakpoint
GRANT SELECT (id, owner_user_id, merchant_key, merchant_label, state, candidate_category_id, streak, trusted_category_id, created_at, updated_at) ON TABLE "ingest_merchants" TO authenticated;--> statement-breakpoint
-- No INSERT and no UPDATE: `private.remember_ingest_merchant` is the only writer. Forgetting stays the
-- person's, and it is the only way out of `ambiguous` (RF-94).
GRANT DELETE ON TABLE "ingest_merchants" TO authenticated;--> statement-breakpoint
CREATE TRIGGER ingest_deliveries_set_timestamps BEFORE INSERT OR UPDATE ON "ingest_deliveries"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER set_ingest_delivery_state BEFORE INSERT ON "ingest_deliveries"
  FOR EACH ROW EXECUTE FUNCTION private.set_ingest_delivery_state();--> statement-breakpoint
CREATE TRIGGER ingest_shapes_set_timestamps BEFORE INSERT OR UPDATE ON "ingest_shapes"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER set_ingest_shape_owner BEFORE INSERT ON "ingest_shapes"
  FOR EACH ROW EXECUTE FUNCTION private.set_ingest_shape_owner();--> statement-breakpoint
CREATE TRIGGER ingest_merchants_set_timestamps BEFORE INSERT OR UPDATE ON "ingest_merchants"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "ingest_deliveries"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "ingest_shapes"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "ingest_merchants"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();--> statement-breakpoint
-- The projection widens by `id` so a delivery can name the credential it arrived through; the throttle,
-- the row lock and the revoked-token behaviour are unchanged. A `returns table` cannot be widened in
-- place, hence the drop.
drop function if exists private.resolve_webhook_credential(text);--> statement-breakpoint
create function private.resolve_webhook_credential(p_token_hash text)
returns table(id uuid, owner_user_id uuid, default_account_id uuid, default_category_id uuid, throttled boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_cred public.webhook_credentials;
  v_reset boolean;
  v_throttled boolean;
begin
  select * into v_cred from public.webhook_credentials c
    where c.token_hash = p_token_hash and c.revoked_at is null
    for update;
  if not found then return; end if;
  v_reset := v_cred.rate_window_started_at is null
             or (pg_catalog.now() - v_cred.rate_window_started_at) >= interval '1 minute';
  if v_reset then
    v_throttled := false;
    update public.webhook_credentials set last_used_at = pg_catalog.now(),
      rate_window_started_at = pg_catalog.now(), rate_count = 1 where id = v_cred.id;
  elsif v_cred.rate_count < v_cred.rate_limit_per_min then
    -- The request that reaches exactly the limit is still admitted.
    v_throttled := false;
    update public.webhook_credentials set last_used_at = pg_catalog.now(),
      rate_count = v_cred.rate_count + 1 where id = v_cred.id;
  else
    -- Over the limit: a valid token, but do not count it and do not admit it.
    v_throttled := true;
    update public.webhook_credentials set last_used_at = pg_catalog.now() where id = v_cred.id;
  end if;
  return query select v_cred.id, v_cred.owner_user_id, v_cred.default_account_id,
    v_cred.default_category_id, v_throttled;
end;
$$;
revoke all on function private.resolve_webhook_credential(text) from public, anon, authenticated, service_role;
