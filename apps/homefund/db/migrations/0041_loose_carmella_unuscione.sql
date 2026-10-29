-- RF-133, RF-135: mirrors `ingest_merchants` (migration 0012) field for field, with three deviations,
-- each earned by what this pattern learns against, not assumed:
--   1. `category` becomes `account` (`candidate_account_id`/`trusted_account_id` -> `accounts`,
--      `on delete set null` unchanged) — a counterparty completion names an account leg, not a category.
--   2. `side` ('from' | 'to') joins the unique key alongside `owner_user_id` and `pattern_key`. A
--      description span can fill either leg of a movement in different rows (a payroll credit's
--      counterparty and a bill's counterparty may share text); folding both into one row would let an
--      agreement on one side silently confirm or poison the other, so the same span teaches two
--      independent memories, one per side.
--   3. `pattern_key`/`pattern_label` replace `merchant_key`/`merchant_label`: the value comes from
--      `counterpartyPatternKey` (`lib/ingest/counterparty-pattern.ts`), a normalised span of a bank
--      statement row's description — a different source and a different pure function than the SMS
--      fingerprint `ingest_merchants` learns from (`lib/ingest/fingerprint.ts`, left untouched).
-- Everything else — the three-state machine, the streak bound, the length checks, the SELECT/DELETE-only
-- grant, the security-definer sole writer — is the unmodified `ingest_merchants` shape.
CREATE TABLE "ingest_counterparties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"pattern_key" text NOT NULL,
	"pattern_label" text NOT NULL,
	"side" text NOT NULL,
	"state" text DEFAULT 'learning' NOT NULL,
	"candidate_account_id" uuid,
	"streak" smallint DEFAULT 0 NOT NULL,
	"trusted_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_counterparties_state_valid" CHECK ("ingest_counterparties"."state" in ('learning', 'trusted', 'ambiguous')),
	CONSTRAINT "ingest_counterparties_side_valid" CHECK ("ingest_counterparties"."side" in ('from', 'to')),
	CONSTRAINT "ingest_counterparties_trusted_account_matches_state" CHECK (("ingest_counterparties"."state" = 'trusted') = ("ingest_counterparties"."trusted_account_id" is not null)),
	CONSTRAINT "ingest_counterparties_streak_range" CHECK ("ingest_counterparties"."streak" between 0 and 2),
	CONSTRAINT "ingest_counterparties_pattern_key_length" CHECK (length("ingest_counterparties"."pattern_key") between 1 and 120),
	CONSTRAINT "ingest_counterparties_pattern_label_length" CHECK (length("ingest_counterparties"."pattern_label") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "ingest_counterparties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingest_counterparties" ADD CONSTRAINT "ingest_counterparties_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_counterparties" ADD CONSTRAINT "ingest_counterparties_candidate_account_id_accounts_id_fk" FOREIGN KEY ("candidate_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_counterparties" ADD CONSTRAINT "ingest_counterparties_trusted_account_id_accounts_id_fk" FOREIGN KEY ("trusted_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_counterparties_owner_pattern_side_unique" ON "ingest_counterparties" USING btree ("owner_user_id","pattern_key","side");--> statement-breakpoint
CREATE POLICY "ingest_counterparties_select" ON "ingest_counterparties" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("ingest_counterparties"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "ingest_counterparties_delete" ON "ingest_counterparties" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("ingest_counterparties"."owner_user_id" = (select auth.uid()));--> statement-breakpoint
-- The one function a session calls directly: a person's own completion feeds it, and it writes rows
-- the person may read and delete but never insert or update. Mirrors `private.remember_ingest_merchant`
-- (migration 0012) with `category_id` widened to `account_id` and `side` joining the locked key, because
-- the same pattern can fill either leg of a movement in different rows and must never let one side's
-- agreement rescue the other's disagreement.
create or replace function private.remember_counterparty(p_key text, p_label text, p_side text, p_account_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := (select auth.uid());
  v_row public.ingest_counterparties;
begin
  if v_owner is null then
    raise exception 'remember_counterparty requires an authenticated session';
  end if;

  select * into v_row from public.ingest_counterparties c
    where c.owner_user_id = v_owner and c.pattern_key = p_key and c.side = p_side
    for update;

  if not found then
    insert into public.ingest_counterparties
      (owner_user_id, pattern_key, pattern_label, side, state, candidate_account_id, streak)
    values (v_owner, p_key, p_label, p_side, 'learning', p_account_id, 1);
    return;
  end if;

  -- Ambiguity is sticky: no later agreement undoes it, only the person forgetting the pattern.
  if v_row.state = 'ambiguous' then return; end if;

  if v_row.state = 'trusted' then
    if v_row.trusted_account_id = p_account_id then return; end if;
    update public.ingest_counterparties
      set state = 'ambiguous', trusted_account_id = null,
          candidate_account_id = p_account_id, streak = 0
      where id = v_row.id;
    return;
  end if;

  if v_row.candidate_account_id = p_account_id then
    update public.ingest_counterparties
      set state = 'trusted', trusted_account_id = p_account_id, streak = 2
      where id = v_row.id;
  else
    -- The run broke, so the new account starts its own; nothing is pinned on one completion.
    update public.ingest_counterparties
      set candidate_account_id = p_account_id, streak = 1
      where id = v_row.id;
  end if;
end;
$$;
revoke all on function private.remember_counterparty(text, text, text, uuid) from public, anon, service_role;--> statement-breakpoint
grant execute on function private.remember_counterparty(text, text, text, uuid) to authenticated;--> statement-breakpoint
ALTER TABLE "ingest_counterparties" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "ingest_counterparties" FROM anon, authenticated, service_role;--> statement-breakpoint
GRANT SELECT (id, owner_user_id, pattern_key, pattern_label, side, state, candidate_account_id, streak, trusted_account_id, created_at, updated_at) ON TABLE "ingest_counterparties" TO authenticated;--> statement-breakpoint
-- No INSERT and no UPDATE: `private.remember_counterparty` is the only writer. Forgetting stays the
-- person's, and it is the only way out of `ambiguous` (RF-135).
GRANT DELETE ON TABLE "ingest_counterparties" TO authenticated;--> statement-breakpoint
CREATE TRIGGER ingest_counterparties_set_timestamps BEFORE INSERT OR UPDATE ON "ingest_counterparties"
  FOR EACH ROW EXECUTE FUNCTION private.set_row_timestamps();--> statement-breakpoint
CREATE TRIGGER capture_audit AFTER INSERT OR UPDATE OR DELETE ON "ingest_counterparties"
  FOR EACH ROW EXECUTE FUNCTION private.capture_audit();
