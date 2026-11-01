#!/usr/bin/env bash
# One parallel track: a worktree, its own lane, its own port.
#
#   scripts/worktree.sh 2 mi-rama [base] [--app homefund]
#
# Lane N lands beside this checkout as <checkout>-lN on its app's port base plus
# N-1, with its own Playwright artefacts. A lane's app decides whether it has a
# database at all, so the environment file and the pair of harness identities are
# facts in the table below and not steps every lane runs: an app without a
# database opens a lane with the remote Postgres unreachable. The apps that do
# have one share one local Supabase stack (scripts/supabase-local.sh), so run at
# most three of their suites at a time. The remote project is reached only for
# the RNF-09 timing; every printed command goes through the wrapper.
set -euo pipefail

# The base-URL variable is the one the app's playwright.config.ts reads; it keeps
# its old name, so it is a column and never derived from the app's name.
# app       port base  .env.local  harness identities  base-URL variable
APPS=(
  "homefund 3000       yes         yes                 HARNESS_BASE_URL"
  "wordbook 3100       yes         no                  VOYAGER_BASE_URL"
  "goallog  3200       yes         no                  PULSAR_BASE_URL"
)

if [[ ${CLAUDE_CODE_REMOTE:-} == true ]]; then
  echo "worktree.sh: a cloud session is already its own lane (1); open another cloud session instead." >&2
  exit 1
fi

APP_NAME=homefund
ARGS=()
while (($#)); do
  case $1 in
    --app) APP_NAME=${2:?app name after --app}; shift 2 ;;
    --app=*) APP_NAME=${1#--app=}; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

LANE=${ARGS[0]:?lane number, 2 or higher}
BRANCH=${ARGS[1]:?branch name}
BASE=${ARGS[2]:-integracion}

PORT_BASE=
for row in "${APPS[@]}"; do
  read -r name port_base copies_env has_harness base_url_var <<<"$row"
  if [[ $name == "$APP_NAME" ]]; then
    PORT_BASE=$port_base
    COPIES_ENV=$copies_env
    HAS_HARNESS=$has_harness
    BASE_URL_VAR=$base_url_var
  fi
done
if [[ -z $PORT_BASE ]]; then
  { printf 'worktree.sh: no app named %s. This monorepo has:' "$APP_NAME"
    for row in "${APPS[@]}"; do printf ' %s' "${row%% *}"; done
    printf '\n'
  } >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
# Derived from the checkout's own name, so renaming the repo never strands a lane.
DIR=$(dirname "$ROOT")/$(basename "$ROOT")-l$LANE
APP=$DIR/apps/$APP_NAME
PORT=$((PORT_BASE + LANE - 1))

cd "$ROOT"

# Read the base rather than this checkout: an app may exist only on the branch
# the lane will serve. Both checks run before anything is created, so a base or
# an app that is not there leaves no half-made lane behind.
if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  echo "worktree.sh: no base named $BASE." >&2
  exit 1
fi
if ! git rev-parse --verify --quiet "$BASE:apps/$APP_NAME" >/dev/null 2>&1; then
  echo "worktree.sh: $BASE has no apps/$APP_NAME." >&2
  exit 1
fi

git worktree add -b "$BRANCH" "$DIR" "$BASE"

# Hardlinks, not a symlink: Turbopack refuses a node_modules that points out of
# the filesystem root, and a copy would cost 909 MB a lane. Workspaces hoist to
# the monorepo root, so this one tree covers every app.
cp -al node_modules "$DIR/node_modules"
if [[ $COPIES_ENV == yes ]]; then
  cp "apps/$APP_NAME/.env.local" "$APP/.env.local"
  # The app reads one origin for its screen, MCP metadata, issuer and sign-in link.
  "$DIR/scripts/lane-env.sh" "$APP/.env.local" "$PORT"
fi
# Gitignored and per checkout: the CLI's `status` fails without it, and the stack
# in Docker was started with this file's keys.
if [[ -f supabase/signing_keys.json ]]; then
  cp supabase/signing_keys.json "$DIR/supabase/signing_keys.json"
fi
# `private/` is gitignored, so the worktree is born without the plans a dispatch
# names. Reports stay behind: the lane writes its own and it is copied out.
mkdir -p "$DIR/private/planes" "$DIR/private/reportes"
cp private/planes/*.md "$DIR/private/planes/"

# Idempotent: a stack already up is left running.
"$DIR/scripts/supabase-local.sh" start

# Once per worktree, and never with that worktree's dev server up: typegen and
# `next dev` race over .next/dev/types. `.next/types` is gitignored, so the root
# typecheck of every Next app needs it, not only the lane's own.
for row in "${APPS[@]}"; do
  read -r name _ <<<"$row"
  [[ -d $DIR/apps/$name ]] && (cd "$DIR/apps/$name" && npx next typegen >/dev/null)
done

# The lane's two identities and their token rows, on the local stack. Idempotent:
# a lane already bootstrapped just lands a fresh session.
if [[ $HAS_HARNESS == yes ]]; then
  (cd "$APP" && HARNESS_LANE="$LANE" "$DIR/scripts/supabase-local.sh" exec npm run harness:token)
fi

W=$DIR/scripts/supabase-local.sh

case $APP_NAME in
  homefund)
    COMMANDS="  cd $APP
  PORT=$PORT $W exec npm run dev
  HARNESS_LANE=$LANE $BASE_URL_VAR=http://localhost:$PORT $W exec npm run check:e2e" ;;
  # Voyager's suite counts effects, and `next dev` runs them twice under
  # StrictMode, so `dev` hands back 13 red specs that a build passes. Its
  # config says so at the top; printing `dev` here next to the suite line is
  # what made two lanes believe it. Build, serve, and rebuild after every edit
  # — `start` serves the build, not the tree. The build is local-only: it
  # inlines the stack's public values, so it never serves the remote project.
  wordbook)
    COMMANDS="  cd $DIR
  $W exec npm run build -w apps/$APP_NAME   # local-only build
  PORT=$PORT $W exec npm run start -w apps/$APP_NAME
  $BASE_URL_VAR=http://localhost:$PORT $W exec npm run check:e2e -w apps/$APP_NAME" ;;
  # An app with no harness has no lane to name, so its suite takes the port alone.
  *)
    COMMANDS="  cd $DIR
  $W exec npm run build -w apps/$APP_NAME   # local-only build
  PORT=$PORT $W exec npm run start -w apps/$APP_NAME
  $BASE_URL_VAR=http://localhost:$PORT $W exec npm run check:e2e -w apps/$APP_NAME" ;;
esac

cat <<EOF

Lane $LANE ready at $DIR on branch $BRANCH.

$COMMANDS

Drop it when the branch lands:

  git worktree remove $DIR --force
EOF
