#!/usr/bin/env bash
# Lists what differs between the local stack's schema and the remote database's.
# Read-only on both sides. Exit 0 identical, 1 differences, 2 a dump failed.
# NORMALISE=0 keeps owners and ACL lines in the dumps (for the red probe only).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="supabase_db_shelf"
SCHEMAS="finances goals reading harness private"
SCHEMA_LIST="'finances','goals','reading','harness','private'"
NORMALISE="${NORMALISE:-1}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

remote_url() {
  local f
  for f in "${SCHEMA_DIFF_ENV:-}" "$ROOT/apps/homefund/.env.local" "$ROOT/apps/goallog/.env.local" "$ROOT/apps/wordbook/.env.local"; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    local v
    v="$(grep '^MIGRATION_DATABASE_URL=' "$f" | head -1 | cut -d= -f2-)"
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  done
  return 1
}

docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$" || { echo "schema-diff: the stack is down" >&2; exit 2; }
REMOTE_URL="$(remote_url)" || { echo "schema-diff: no MIGRATION_DATABASE_URL found in an .env.local" >&2; exit 2; }
export REMOTE_URL

# $1 = local|remote; stdin = the command run inside the container.
run_psql() { # args: side, then psql args
  local side="$1"; shift
  if [ "$side" = local ]; then
    docker exec -i "$CONTAINER" psql -U postgres -d postgres -X "$@"
  else
    docker exec -i -e REMOTE_URL "$CONTAINER" sh -c 'exec psql "$REMOTE_URL" -X "$@"' sh "$@"
  fi
}

CATALOGUE=$(cat <<SQL
select 'policy|'||schemaname||'.'||tablename||'.'||policyname||'|'||cmd||' roles='||array_to_string(roles,',')||' using='||coalesce(qual,'')||' check='||coalesce(with_check,'')
  from pg_policies where schemaname in ($SCHEMA_LIST)
union all
select 'grant|'||table_schema||'.'||table_name||'|'||grantee||'='||string_agg(privilege_type,',' order by privilege_type)
  from information_schema.role_table_grants
  where table_schema in ($SCHEMA_LIST) and grantee in ('anon','authenticated','service_role')
  group by table_schema, table_name, grantee
union all
select 'function|'||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')|md5='||md5(regexp_replace(pg_get_functiondef(p.oid),'\s+',' ','g'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ($SCHEMA_LIST) and p.prokind in ('f','p')
    and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
union all
select 'seqgrant|'||n.nspname||'.'||c.relname||'|'||coalesce((select string_agg(a.grantee::regrole::text||':'||a.privilege_type, ',' order by a.grantee::regrole::text, a.privilege_type)
    from aclexplode(c.relacl) a where a.grantee::regrole::text in ('anon','authenticated','service_role')),'-')
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S' and n.nspname in ($SCHEMA_LIST)
union all
select 'trigger|'||c.relnamespace::regnamespace||'.'||c.relname||'.'||t.tgname||'|'||regexp_replace(pg_get_triggerdef(t.oid),'\s+',' ','g')
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  where not t.tgisinternal and c.relnamespace::regnamespace::text in ($SCHEMA_LIST)
union all
select 'extension|'||extname||'|' from pg_extension
union all
select 'cron|'||jobname||'|'||schedule||' '||command from cron.job
order by 1
SQL
)

dump_side() {
  local side="$1" out="$WORK/$1"
  local args=() s
  for s in $SCHEMAS; do args+=(--schema="$s"); done
  local flags=(--schema-only)
  [ "$NORMALISE" = 1 ] && flags+=(--no-owner --no-acl)
  if [ "$side" = local ]; then
    docker exec -i "$CONTAINER" pg_dump -U postgres -d postgres "${flags[@]}" "${args[@]}" > "$out.dump" 2>"$out.err" || return 1
  else
    docker exec -i -e REMOTE_URL "$CONTAINER" sh -c 'exec pg_dump "$REMOTE_URL" "$@"' sh "${flags[@]}" "${args[@]}" > "$out.dump" 2>"$out.err" || return 1
  fi
  # Drop per-dump noise: comments, session SETs, restrict tokens, blank lines.
  # Indentation too: a function body edited after it was applied differs only there.
  grep -v -e '^--' -e '^SET ' -e '^SELECT pg_catalog.set_config' -e '^\\restrict' -e '^\\unrestrict' -e '^$' "$out.dump" | sed 's/^[[:space:]]*//' > "$out.norm"
  echo "$CATALOGUE" | run_psql "$side" -At -F'|' > "$out.cat" 2>>"$out.err" || return 1
}

for side in local remote; do
  dump_side "$side" || { echo "schema-diff: dump failed on $side" >&2; sed 's/postgres[a-z]*:\/\/[^ ]*/<url>/g' "$WORK/$side.err" | head -5 >&2; exit 2; }
done

differs=0
echo "== catalogue (policy, grant, seqgrant, function, trigger, extension, cron) =="
for kind in only_remote only_local different; do :; done
awk -F'|' -v dir="$WORK" '
  FILENAME==dir"/remote.cat" { r[$1"|"$2]=$3; next }
  { l[$1"|"$2]=$3 }
  END {
    for (k in r) if (!(k in l)) print "only remote\t" k "\t" r[k]
    for (k in l) if (!(k in r)) print "only local\t" k "\t" l[k]
    for (k in r) if ((k in l) && r[k]!=l[k]) print "both but different\t" k "\n    remote: " r[k] "\n    local:  " l[k]
  }' "$WORK/remote.cat" "$WORK/local.cat" | sort > "$WORK/cat.diff"
if [ -s "$WORK/cat.diff" ]; then cat "$WORK/cat.diff"; differs=1; else echo "(none)"; fi

echo "== dump (pg_dump --schema-only, remote -> local) =="
if diff -u "$WORK/remote.norm" "$WORK/local.norm" > "$WORK/dump.diff"; then
  echo "(none)"
else
  differs=1
  echo "lines only in remote: $(grep -c '^-[^-]' "$WORK/dump.diff")  only in local: $(grep -c '^+[^+]' "$WORK/dump.diff")"
  grep '^[-+][^-+]' "$WORK/dump.diff" | head -"${DUMP_LINES:-80}"
fi
exit "$differs"
