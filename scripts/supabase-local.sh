#!/usr/bin/env bash
# Local Supabase stack for the suites. `exec` overlays local values on the process
# environment, which wins over every .env.local; no file is written or modified.
set -euo pipefail

SUPABASE_VERSION="2.119.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXCLUDED="studio,postgres-meta,postgrest,realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor"
DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
API_URL="http://127.0.0.1:54321"

cli() { (cd "$ROOT" && npx --yes "supabase@${SUPABASE_VERSION}" "$@"); }

is_up() { docker ps --format '{{.Names}}' | grep -q '^supabase_db_universo$'; }

# Reads one KEY="value" line out of `status -o env` text on stdin.
status_value() { sed -n "s/^$1=\"\(.*\)\"\$/\1/p" | head -1; }

print_env() {
  local status key secret
  # One status call for both keys: each costs an npx round.
  status="$(cli status -o env 2>/dev/null)"
  key="$(status_value PUBLISHABLE_KEY <<<"$status")"
  secret="$(status_value SECRET_KEY <<<"$status")"
  [ -n "$key" ] || { echo "supabase-local: no publishable key from the stack" >&2; return 1; }
  [ -n "$secret" ] || { echo "supabase-local: no secret key from the stack" >&2; return 1; }
  cat <<EOF
export DATABASE_URL='${DB_URL}'
export MIGRATION_DATABASE_URL='${DB_URL}'
export NEXT_PUBLIC_SUPABASE_URL='${API_URL}'
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='${key}'
export SUPABASE_SECRET_KEY='${secret}'
export OPENAI_API_KEY=
export GEMINI_API_KEY=
export SUPABASE_STORAGE_S3_ENDPOINT=
export SUPABASE_STORAGE_S3_REGION=
export SUPABASE_STORAGE_S3_ACCESS_KEY_ID=
export SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY=
export SUPABASE_STORAGE_BUCKET=
EOF
}

require_up() {
  is_up || { echo "supabase-local: the stack is down; run: scripts/supabase-local.sh start" >&2; exit 1; }
}

cmd_migrate() {
  require_up
  local apps=("$@")
  [ ${#apps[@]} -gt 0 ] || apps=(homefund wordbook goallog)
  local app
  for app in "${apps[@]}"; do
    # drizzle-kit directly: db:migrate also demands the app's .env.local, which a fresh lane may lack.
    if ! (cd "$ROOT/apps/$app" && env_lines="$(print_env)" && eval "$env_lines" && node ../../node_modules/drizzle-kit/bin.cjs migrate); then
      echo "supabase-local: migrate failed for ${app}" >&2
      exit 1
    fi
  done
}

cmd_start() {
  # Already up: apply nothing; `migrate` is the explicit way to catch up.
  if is_up; then
    echo "supabase-local: stack already up" >&2
    return 0
  fi
  if [ ! -f "$ROOT/supabase/signing_keys.json" ]; then
    # The CLI appends to an existing file only.
    echo '[]' > "$ROOT/supabase/signing_keys.json"
    cli gen signing-key --algorithm ES256 --append >/dev/null
  fi
  cli start -x "$EXCLUDED"
  cmd_migrate
}

case "${1:-}" in
  start) cmd_start ;;
  migrate) shift; cmd_migrate "$@" ;;
  env) require_up; print_env ;;
  exec)
    shift
    [ $# -gt 0 ] || { echo "usage: supabase-local.sh exec <cmd…>" >&2; exit 1; }
    require_up
    # A failed print_env must stop here: an empty env falls back to .env.local, the remote project.
    env_lines="$(print_env)" || exit 1
    eval "$env_lines"
    echo "supabase-local: API 127.0.0.1:54321, DB 127.0.0.1:54322" >&2
    exec "$@"
    ;;
  status) cli status ;;
  stop) cli stop ;;
  *) echo "usage: supabase-local.sh start|migrate [app…]|env|exec <cmd…>|status|stop" >&2; exit 1 ;;
esac
