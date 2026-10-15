#!/usr/bin/env bash
# Run: scripts/hooks/test-guard-bash.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
export GUARD_GIT_NAME=wilson GUARD_GIT_EMAIL=cxrkeybwp2004@gmail.com GUARD_BRANCH=feature
FAILS=0

run() { python3 -c 'import json,sys;print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]},"cwd":"."}))' "$1" | python3 "$HERE/guard-bash.py" 2>/dev/null; }
blocks() { run "$1"; [ $? -eq 2 ] || { echo "FAIL (should block): $1"; FAILS=$((FAILS+1)); }; }
passes() { run "$1"; [ $? -eq 0 ] || { echo "FAIL (should pass): $1"; FAILS=$((FAILS+1)); }; }

blocks 'git stash'
blocks 'cd x && git stash pop'
blocks 'git -C ../l2 stash'
passes 'git stash-not'
passes 'git commit -m "no git stash here"'

blocks 'git commit -m x --author="Bob <b@x.y>"'
(GUARD_GIT_NAME=Bob; export GUARD_GIT_NAME; run 'git commit -m x'; [ $? -eq 2 ]) || { echo "FAIL: wrong config author"; FAILS=$((FAILS+1)); }
passes 'git commit -m "infra · hooks: algo"'
passes 'git commit --author="wilson <cxrkeybwp2004@gmail.com>" -m x'

blocks 'git commit -m "x

Co-Authored-By: Claude <n@a.com>"'
blocks 'git commit -m "x" -m "Claude-Session: abc"'
blocks "git commit -F - <<'EOF'
msg

Co-Authored-By: Someone
EOF"
blocks 'gh pr create --base integracion --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"'
passes 'gh pr create --base integracion --title t --body "ok"'

blocks 'gh pr create --title t'
blocks 'gh pr create --base main --title t'
blocks 'gh pr create -B main'
passes 'gh pr create -B integracion'
passes 'gh pr create --base main --head integracion'
(GUARD_BRANCH=integracion; export GUARD_BRANCH; run 'gh pr create --base main'; [ $? -eq 0 ]) || { echo "FAIL: integracion->main"; FAILS=$((FAILS+1)); }

blocks 'pkill -f next'
blocks 'pkill -9f next'
passes 'pkill node'
passes 'fuser -k 3000/tcp'

blocks 'gh pr merge 5 --squash && git branch -D foo'
blocks 'gh pr merge 5; git push origin --delete foo'
passes 'gh pr merge 5 --merge'
passes 'git branch -D foo'

blocks 'git push origin main'
blocks 'git push origin HEAD:main'
blocks 'git push origin HEAD:refs/heads/main'
passes 'git push origin infra-hooks'
passes 'git push origin origin/main:refs/heads/integracion'

[ $FAILS -eq 0 ] && echo "guard-bash: all green" || { echo "$FAILS failed"; exit 1; }
