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

STAMP="$ROOT/node_modules/.lock-hash"
HASH="$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$HASH" ]; then
  if npm ci --no-audit --no-fund >/dev/null 2>&1; then
    echo "$HASH" > "$STAMP"
    DONE+=("npm ci")
  else
    warn "npm ci failed; run it by hand."
  fi
fi

# Write only keys the environment holds. A file that exists is the user's: wordbook's is never touched.
for env_example in apps/*/.env.example; do
  [ -f "$env_example" ] || continue
  app_dir="$(dirname "$env_example")"
  target="$app_dir/.env.local"
  [ -e "$target" ] && continue
  lines=""
  while IFS= read -r key; do
    [ -n "${!key:-}" ] && lines+="${key}=${!key}"$'\n'
  done < <(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$env_example")
  if [ -n "$lines" ]; then
    printf '%s' "$lines" > "$target" && chmod 600 "$target" && DONE+=("$(basename "$app_dir") .env.local")
  fi
done

# Gitignored route types the root typecheck needs. One app at a time, as CI does.
if [ -d node_modules ]; then
  for app in homefund wordbook goallog timelog; do
    [ -d "apps/$app" ] || continue
    [ -d "apps/$app/.next/types" ] && continue
    (cd "apps/$app" && npx next typegen >/dev/null 2>&1) && DONE+=("typegen $app") || warn "typegen failed for $app."
  done
fi

if [ ${#DONE[@]} -gt 0 ]; then
  echo "cloud-start: did $(IFS=,; echo "${DONE[*]}")."
else
  echo "cloud-start: nothing to do."
fi
exit 0
