-- A rule's category guard has to tell a deleted category (the form was open when it went: a stale
-- pick, `referenceGone`) from one that exists but the caller cannot see (another person's:
-- `scopeViolation`). Row security hides both alike, so the answer needs a read past it. The function
-- returns a boolean and nothing else, and takes the id only: it names no owner, scope or kind.
create or replace function private.category_exists(p_category uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from finances.categories c where c.id = p_category);
$$;--> statement-breakpoint
revoke all on function private.category_exists(uuid) from public, anon, authenticated, service_role;--> statement-breakpoint
grant execute on function private.category_exists(uuid) to authenticated;
