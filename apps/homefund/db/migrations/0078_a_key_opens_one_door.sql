ALTER TABLE "finances"."webhook_credentials" ADD COLUMN "purpose" text DEFAULT 'ingest' NOT NULL;--> statement-breakpoint
ALTER TABLE "finances"."webhook_credentials" ADD CONSTRAINT "webhook_credentials_purpose" CHECK ("finances"."webhook_credentials"."purpose" in ('ingest', 'mcp'));--> statement-breakpoint
GRANT SELECT (purpose), INSERT (purpose) ON TABLE "finances"."webhook_credentials" TO authenticated;--> statement-breakpoint
-- The resolver answers one purpose: a key minted for the webhook never opens /mcp, nor the reverse.
DROP FUNCTION private.resolve_webhook_credential(text);--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.resolve_webhook_credential(p_token_hash text, p_purpose text)
 RETURNS TABLE(id uuid, owner_user_id uuid, default_account_id uuid, default_category_id uuid, throttled boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cred finances.webhook_credentials;
  v_reset boolean;
  v_throttled boolean;
begin
  select * into v_cred from finances.webhook_credentials c
    where c.token_hash = p_token_hash and c.purpose = p_purpose and c.revoked_at is null
    for update;
  if not found then return; end if;
  v_reset := v_cred.rate_window_started_at is null
             or (pg_catalog.now() - v_cred.rate_window_started_at) >= interval '1 minute';
  if v_reset then
    v_throttled := false;
    update finances.webhook_credentials c set last_used_at = pg_catalog.now(),
      rate_window_started_at = pg_catalog.now(), rate_count = 1 where c.id = v_cred.id;
  elsif v_cred.rate_count < v_cred.rate_limit_per_min then
    -- The request that reaches exactly the limit is still admitted.
    v_throttled := false;
    update finances.webhook_credentials c set last_used_at = pg_catalog.now(),
      rate_count = v_cred.rate_count + 1 where c.id = v_cred.id;
  else
    -- Over the limit: a valid token, but do not count it and do not admit it.
    v_throttled := true;
    update finances.webhook_credentials c set last_used_at = pg_catalog.now() where c.id = v_cred.id;
  end if;
  return query select v_cred.id, v_cred.owner_user_id, v_cred.default_account_id,
    v_cred.default_category_id, v_throttled;
end;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.resolve_webhook_credential(text, text) FROM public, anon, authenticated, service_role;
