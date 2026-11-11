# Shared by backup.sh and restore.sh; sourced, never run.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The main checkout: a lane has no .env.local or private key of its own.
MAIN="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")"

# Schemas of the four apps (HomeFund finances, GoalLog goals, WordBook reading, TimeLog timelog), the test harness and
# the drizzle migration history and `private`, whose functions our triggers and policies call. public holds nothing of ours; auth, storage, vault and cron are Supabase's.
BACKUP_SCHEMAS=(finances goals reading timelog harness drizzle private)
# The users and their sign-in identities: every foreign key of ours ends in auth.users. Rows only; Supabase owns the table.
BACKUP_AUTH_TABLES=(auth.users auth.identities)

# A client unpacked under private/tools/pg<major> (no root to apt install) brings its own libpq.
for lib in "$ROOT"/private/tools/pg*/root/usr/lib/x86_64-linux-gnu; do
  [ -d "$lib" ] && export LD_LIBRARY_PATH="$lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
done

# The value of $1 from the environment, else from apps/homefund/.env.local (this lane's, else the main checkout's).
# Read with grep, never sourced: the file is not ours to execute.
env_value() {
  local name="$1" file value
  [ -n "${!name:-}" ] && { printf '%s' "${!name}"; return 0; }
  for file in "$ROOT/apps/homefund/.env.local" "$MAIN/apps/homefund/.env.local"; do
    [ -f "$file" ] || continue
    value="$(grep -m1 "^${name}=" "$file" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")"
    [ -n "$value" ] && { printf '%s' "$value"; return 0; }
  done
  return 1
}

# A pg_dump / pg_restore / psql directory whose major version is the server's $2 (URL $1): a dump from an older client
# fails, and one from a newer client may not load. PG_BIN overrides the search.
pg_bin_for() {
  local url="$1" major dir
  major="$(psql "$url" -qAtX -c "show server_version_num" | cut -c1-2)"
  [ -n "$major" ] || { echo "cannot read the server version" >&2; return 1; }
  for dir in "${PG_BIN:-}" "/usr/lib/postgresql/$major/bin" "$ROOT/private/tools/pg$major/root/usr/lib/postgresql/$major/bin" "$(dirname "$(command -v pg_dump)")"; do
    [ -n "$dir" ] && [ -x "$dir/pg_dump" ] || continue
    [ "$("$dir/pg_dump" --version | sed -E 's/.* ([0-9]+)[.].*/\1/')" = "$major" ] && { printf '%s' "$dir"; return 0; }
  done
  echo "no pg_dump $major found (the server is PostgreSQL $major): install postgresql-client-$major or set PG_BIN" >&2
  return 1
}
