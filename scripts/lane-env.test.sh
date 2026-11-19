#!/usr/bin/env bash
# Run: scripts/lane-env.test.sh   (scratch files live in the lane's private/)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SUT=${LANE_ENV_SUT:-$HERE/lane-env.sh}
WORKTREE=${LANE_ENV_WORKTREE:-$HERE/worktree.sh}
TMP=$(mktemp -d "$HERE/../private/lane-env-XXXXXX")
trap 'rm -rf "$TMP"' EXIT
FAILS=0
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }

printf 'A=1\nNEXT_PUBLIC_SITE_URL=http://localhost:3200\nB=http://localhost:3200\n' >"$TMP/local"
printf 'A=1\nNEXT_PUBLIC_SITE_URL=http://localhost:3202\nB=http://localhost:3200\n' >"$TMP/local.want"
"$SUT" "$TMP/local" 3202
cmp -s "$TMP/local" "$TMP/local.want" || fail "localhost rewritten, other lines untouched"

cp "$TMP/local" "$TMP/twice"
"$SUT" "$TMP/twice" 3202
cmp -s "$TMP/local" "$TMP/twice" || fail "idempotent"

printf 'A=1\nNEXT_PUBLIC_SITE_URL=https://wordbook.example.app\n' >"$TMP/host"
cp "$TMP/host" "$TMP/host.want"
"$SUT" "$TMP/host" 3202
cmp -s "$TMP/host" "$TMP/host.want" || fail "real host untouched"

printf 'NEXT_PUBLIC_SITE_URL=http://example.com\n' >"$TMP/plainhost"
cp "$TMP/plainhost" "$TMP/plainhost.want"
"$SUT" "$TMP/plainhost" 3202
cmp -s "$TMP/plainhost" "$TMP/plainhost.want" || fail "real http host untouched"

printf 'A=1\nB=2\n' >"$TMP/none"
cp "$TMP/none" "$TMP/none.want"
"$SUT" "$TMP/none" 3202
cmp -s "$TMP/none" "$TMP/none.want" || fail "no line, no change"

# worktree.sh calls it after the .env.local copy, with the computed port.
copy=$(grep -n 'cp "apps/\$APP_NAME/.env.local"' "$WORKTREE" | head -1 | cut -d: -f1)
call=$(grep -n 'lane-env.sh.*"\$PORT"' "$WORKTREE" | head -1 | cut -d: -f1)
[[ -n $copy && -n $call && $call -gt $copy ]] || fail "worktree.sh wires lane-env.sh after the copy with \$PORT"

((FAILS == 0)) && echo "lane-env: all passed" || { echo "lane-env: $FAILS failed"; exit 1; }
