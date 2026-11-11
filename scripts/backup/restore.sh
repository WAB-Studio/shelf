#!/usr/bin/env bash
# Loads a copy of backup.sh into a database that already has Supabase's auth schema. Our schemas are dropped and
# rebuilt from the copy (--clean), so rows written since the copy are lost: point it at a scratch database, the local
# stack or a new project. It refuses production unless --production is given.
# Usage: scripts/backup/restore.sh <copy dir | copy.tar.gz.age> <postgres-url> [--key file] [--production]
#   --key: the age private key that opens a .age copy (default private/LLAVE-COPIAS-age.txt)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

src="${1:?usage: restore.sh <copy dir | copy.tar.gz.age> <postgres-url> [--key file] [--production]}"
url="${2:?usage: restore.sh <copy dir | copy.tar.gz.age> <postgres-url> [--key file] [--production]}"
shift 2
key="$MAIN/private/LLAVE-COPIAS-age.txt"
production=0
while [ $# -gt 0 ]; do
  case "$1" in
    --key) key="${2:?--key needs a file}"; shift 2 ;;
    --production) production=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Production is the database of MIGRATION_DATABASE_URL, or any Supabase-hosted one.
host_of() { sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#' <<< "$1"; }
target_host="$(host_of "$url")"
prod_url="$(env_value MIGRATION_DATABASE_URL || true)"
if [ "$production" = 0 ]; then
  if [[ "$target_host" == *supabase.co || "$target_host" == *supabase.com || ( -n "$prod_url" && "$target_host" == "$(host_of "$prod_url")" ) ]]; then
    echo "refusing: $target_host looks like production; pass --production to restore there" >&2
    exit 1
  fi
fi

work=""
if [[ "$src" == *.age ]]; then
  work="$(mktemp -d "$ROOT/private/restore.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  age -d -i "$key" "$src" | tar -xzf - -C "$work"
  src="$(find "$work" -mindepth 1 -maxdepth 1 -type d | head -1)"
fi
[ -f "$src/schemas.dump" ] && [ -f "$src/auth.sql" ] || { echo "$src is not a copy of backup.sh" >&2; exit 1; }

bin="$(pg_bin_for "$url")"
# Users first: every foreign key of ours points at them.
"$bin/psql" "$url" -qX -v ON_ERROR_STOP=1 -f "$src/auth.sql" > /dev/null
"$bin/pg_restore" --dbname "$url" --clean --if-exists --no-owner --no-privileges --exit-on-error "$src/schemas.dump"
echo "restored $(basename "$src") into $target_host"
