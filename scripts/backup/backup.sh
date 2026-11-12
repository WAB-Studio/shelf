#!/usr/bin/env bash
# A logical copy of the Shelf database, which Supabase Free does not keep: pg_dump of the schemas of the four apps plus
# the rows of auth.users and auth.identities, and rows.txt with the row count of each table. Read-only: pg_dump and
# SELECTs; nothing is written to the source. The copy is not one instant: the counts are taken right after the dump.
# Source: $MIGRATION_DATABASE_URL, else its line in apps/homefund/.env.local.
# Usage: scripts/backup/backup.sh   (prints the directory of the copy, private/backups/<UTC time>/)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

url="$(env_value MIGRATION_DATABASE_URL)" || { echo "MIGRATION_DATABASE_URL is not set" >&2; exit 1; }
bin="$(pg_bin_for "$url")"
root="${BACKUP_ROOT:-$ROOT/private/backups}"
dir="$root/$(date -u +%Y-%m-%dT%H%M%SZ)"
mkdir -p "$dir"

schema_args=()
for s in "${BACKUP_SCHEMAS[@]}"; do schema_args+=(-n "$s"); done
auth_args=()
for t in "${BACKUP_AUTH_TABLES[@]}"; do auth_args+=(-t "$t"); done

"$bin/pg_dump" "$url" --format=custom --no-owner --no-privileges "${schema_args[@]}" -f "$dir/schemas.dump"
# Plain inserts that skip rows already there: the target of a restore has its own auth.users.
"$bin/pg_dump" "$url" --data-only --column-inserts --on-conflict-do-nothing --no-owner --no-privileges "${auth_args[@]}" -f "$dir/auth.sql"

schema_list="$(printf "'%s'," "${BACKUP_SCHEMAS[@]}" | sed 's/,$//')"
auth_list="$(printf "'%s'," "${BACKUP_AUTH_TABLES[@]}" | sed 's/,$//')"
counts_sql="$("$bin/psql" "$url" -qAtX -c "
  select string_agg(format('select %L as t, count(*) as n from %I.%I', table_schema || '.' || table_name, table_schema, table_name),
                    ' union all ' order by table_schema, table_name)
  from information_schema.tables
  where table_type = 'BASE TABLE'
    and (table_schema in ($schema_list) or table_schema || '.' || table_name in ($auth_list))")"
"$bin/psql" "$url" -qAtX -F ' ' -c "select t, n from ($counts_sql) c order by t" > "$dir/rows.txt"

{
  echo "taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "server=$("$bin/psql" "$url" -qAtX -c 'show server_version')"
  echo "pg_dump=$("$bin/pg_dump" --version)"
  echo "schemas=${BACKUP_SCHEMAS[*]}"
  echo "commit=$(git -C "$ROOT" rev-parse --short HEAD)"
} > "$dir/meta.txt"
echo "$dir"
