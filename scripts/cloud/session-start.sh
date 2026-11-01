#!/usr/bin/env bash
# SessionStart hook for Claude Code cloud sessions. Idempotent; never fails the session.
#
# Sets git identity, installs when the lockfile moved, generates route types and writes
# each app's .env.local from the environment's variables. Exits at once outside the cloud.
[ "${CLAUDE_CODE_REMOTE:-}" = true ] || exit 0
set -u

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT" || exit 0
DONE=()
warn() { echo "cloud-start: warning: $*" >&2; }

git config user.name wilson 2>/dev/null && git config user.email cxrkeybwp2004@gmail.com 2>/dev/null \
  && DONE+=("git identity")

# A killed `npm ci` leaves node_modules half built; the stamp is written only after success, so the next start redoes it.
STAMP="$ROOT/node_modules/.lock-hash"
HASH="$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$HASH" ]; then
  if timeout 600 npm ci --no-audit --no-fund >/dev/null 2>&1; then
    echo "$HASH" > "$STAMP"
    DONE+=("npm ci")
  else
    rm -f "$STAMP"
    warn "npm ci failed or timed out; run it by hand."
  fi
fi

# No secret is written: `supabase-local.sh exec` overlays the local stack's values on whatever the file holds.
# The file exists only so tools that demand it (db:migrate) find one. wordbook's real file is the user's and
# AGENTS.md forbids touching it; a fresh VM has none, so a missing file is created, an existing one never changed.
port_of() { case $1 in homefund) echo 3000 ;; wordbook) echo 3100 ;; goallog) echo 3200 ;; timelog) echo 3300 ;; esac; }
for env_example in apps/*/.env.example; do
  [ -f "$env_example" ] || continue
  app_dir="$(dirname "$env_example")"; app="$(basename "$app_dir")"
  target="$app_dir/.env.local"
  [ -e "$target" ] && continue
  cp "$env_example" "$target" || continue
  port="$(port_of "$app")"
  [ -n "$port" ] && sed -i -E "s#^NEXT_PUBLIC_SITE_URL=.*#NEXT_PUBLIC_SITE_URL=http://localhost:$port#" "$target"
  DONE+=("$app .env.local")
done

# setup.sh is pasted into claude.ai and cannot read the repo; its pinned version must follow the script's.
want="$(sed -n 's/^SUPABASE_VERSION="\([^"]*\)".*/\1/p' scripts/supabase-local.sh)"
have="$(sed -n 's/^SUPABASE_VERSION="\([^"]*\)".*/\1/p' scripts/cloud/setup.sh)"
[ "$want" = "$have" ] || warn "setup.sh pins supabase $have, supabase-local.sh $want: paste setup.sh again."

# Gitignored route types the root typecheck needs. One app at a time, as CI does.
if [ -d node_modules ]; then
  for app in homefund wordbook goallog timelog; do
    [ -d "apps/$app" ] || continue
    [ -d "apps/$app/.next/types" ] && continue
    (cd "apps/$app" && timeout 120 npx next typegen >/dev/null 2>&1) && DONE+=("typegen $app") || warn "typegen failed for $app."
  done
fi

if [ ${#DONE[@]} -gt 0 ]; then
  echo "cloud-start: did $(IFS=,; echo "${DONE[*]}")."
else
  echo "cloud-start: nothing to do."
fi
exit 0
