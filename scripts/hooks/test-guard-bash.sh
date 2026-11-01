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
blocks 'git push origin +main'
blocks 'git push origin +HEAD:main'
blocks 'git push origin HEAD:refs/heads/main'
passes 'git push origin infra-hooks'
passes 'git push origin origin/main:refs/heads/integracion'

# --- false negatives: forbidden commands that used to slip through ---
T=$(mktemp); trap 'rm -f "$T"' EXIT
printf 'x\n\nCo-Authored-By: Claude <n@a.com>\n' > "$T"
blocks "git commit -F $T"
blocks "git commit --file=$T"
blocks "gh pr create --base integracion --body-file $T"
blocks "printf 'x\n\nCo-Authored-By: Claude' | git commit -F -"
blocks "cat > /tmp/guard-msg <<'EOF'
x

Claude-Session: https://claude.ai/code/session_1
EOF
git commit -F /tmp/guard-msg"
blocks 'git commit -m "$(cat <<'"'EOF'"'
msg

Co-Authored-By: Claude Sonnet <noreply@anthropic.com>
EOF
)"'
blocks 'gh pr create --base integracion --body "x

https://claude.ai/code/session_0176"'
blocks 'GIT_AUTHOR_EMAIL=x@y.z git commit -m x'
blocks 'GIT_COMMITTER_EMAIL=x@y.z git commit -m x'
blocks 'GIT_AUTHOR_EMAIL=x@y.z git commit -m "x" -m "Co-Authored-By: Claude"'
blocks 'GH_TOKEN=x gh pr merge 5 && git branch -D foo'
blocks 'git -c user.email=x@y.z commit -m x'
blocks 'git commit --author "Bob <b@x.y>" -m x'
blocks 'bash -c "git stash"'
blocks "sh -c 'git push origin main'"
blocks 'bash -lc "cd x && git stash"'
blocks 'eval "git stash"'
blocks 'echo $(git stash)'
blocks 'echo "$(git stash)"'
blocks 'echo `git stash`'
blocks '(git stash)'
blocks '{ git stash; }'
blocks 'sudo git stash'
blocks 'env FOO=1 git stash'
blocks 'command git stash'
blocks 'time git stash'
blocks 'xargs -n1 git stash'
blocks 'npm run dev & git stash'
blocks 'git --work-tree x stash'
blocks 'git --git-dir=.git stash pop'
blocks 'git config alias.st stash'
blocks 'echo "don'"'"'t" ; git stash ; echo '"'x'"
blocks 'if true; then git stash; fi'
blocks 'gh pr merge 5 --squash --delete-branch'
blocks 'gh pr merge 5 -d'
blocks 'gh pr merge 5 && gh api -X DELETE repos/o/r/git/refs/heads/x'
blocks 'gh pr merge 5 && git worktree remove ../x'
blocks 'gh -R o/r pr merge 5; git push origin --delete foo'
blocks 'gh pr edit 5 --base main'
blocks 'gh pr create --base "main" --title t'
blocks 'kill $(pgrep -f "next dev")'
blocks 'pkill --full next'
blocks 'git push --all'
blocks 'git push origin :main'
blocks 'git push -u origin +refs/heads/main'
(GUARD_BRANCH=main; export GUARD_BRANCH; run 'git push origin HEAD'; [ $? -eq 2 ]) || { echo "FAIL (should block): push HEAD from main"; FAILS=$((FAILS+1)); }
(GUARD_BRANCH=main; export GUARD_BRANCH; run 'git push'; [ $? -eq 2 ]) || { echo "FAIL (should block): bare push from main"; FAILS=$((FAILS+1)); }

# --- false positives: legitimate commands that used to be blocked ---
passes 'gh pr create --base "integracion" --title t'
passes 'gh pr create --base=integracion --title t'
passes "gh pr create --base 'integracion' --title t"
passes 'gh pr create --base "main" --head "integracion"'
passes 'git commit -m "hooks: refuse Co-Authored-By trailers"'
passes 'gh pr comment 5 --body "no Co-Authored-By here please"'
passes 'git stash list'
passes 'git stash show'
passes 'git push origin HEAD'
passes 'git push'
passes 'git commit --amend --no-edit'
passes "cat > f <<'EOF'
git stash
git push origin main
pkill -f next
EOF"
passes 'echo "git stash"; echo '"'git push origin main'"
passes 'grep -r "pkill -f" docs'
passes 'git commit -m x -m "mentions gh pr merge --delete-branch and git stash"'
passes 'gh pr create --base integracion --body "$(cat <<'"'EOF'"'
never git push origin main
EOF
)"'
passes 'git commit -m "$(cat <<'"'EOF'"'
infra · hooks: algo

Sin trailer.
EOF
)"'
passes 'echo a 2>&1 | cat; ls &>/dev/null'
passes 'git log --oneline -5 && git status'
# Outside any repo, with no global git identity: only a real commit has an author to check.
outside() {
  python3 -c 'import json,sys;print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]},"cwd":"/tmp"}))' "$1" |
    (cd /tmp && env -u GUARD_GIT_NAME -u GUARD_GIT_EMAIL HOME=/nonexistent GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null python3 "$HERE/guard-bash.py" 2>/dev/null)
}
for c in 'git log --grep commit -n 3' 'git cat-file commit HEAD' "git -C $HERE/../.. commit -m x"; do
  outside "$c"; [ $? -eq 0 ] || { echo "FAIL (should pass outside a repo): $c"; FAILS=$((FAILS+1)); }
done

# --- gh api: PRs by REST ---
blocks 'gh api repos/WAB-Studio/shelf/pulls -f title=t -f head=x -f base=main'
blocks 'gh api repos/WAB-Studio/shelf/pulls -X POST -f title=t -f head=x'
blocks 'gh api repos/WAB-Studio/shelf/pulls -f base=integracion -f head=x -f body="Claude-Session: abc"'
passes 'gh api repos/WAB-Studio/shelf/pulls -f title=t -f head=x -f base=integracion'
passes 'gh api repos/WAB-Studio/shelf/pulls -f head=integracion -f base=main'
passes 'gh api repos/WAB-Studio/shelf/pulls/5'
blocks 'gh api -X PUT repos/WAB-Studio/shelf/pulls/5/merge -f merge_method=squash'
blocks 'gh api repos/WAB-Studio/shelf/pulls/5/merge --method PUT'
blocks 'gh api -XPATCH repos/WAB-Studio/shelf/pulls/5 -f base=main'
passes 'gh api -X PATCH repos/WAB-Studio/shelf/pulls/5 -f base=integracion'
passes 'gh api -X PATCH repos/WAB-Studio/shelf/pulls/5 -f title=t'
TMPD=$(mktemp -d)
printf '{"title":"t","head":"x","base":"main"}' > "$TMPD/main.json"
printf '{"title":"t","head":"x","base":"integracion","body":"Co-Authored-By: C"}' > "$TMPD/trailer.json"
printf '{"title":"t","head":"x","base":"integracion"}' > "$TMPD/ok.json"
printf 'ok body' > "$TMPD/ok.md"
printf 'x\n\nClaude-Session: abc' > "$TMPD/bad.md"
blocks "gh api repos/WAB-Studio/shelf/pulls --input $TMPD/main.json"
blocks "gh api repos/WAB-Studio/shelf/pulls --input $TMPD/trailer.json"
blocks "gh api repos/WAB-Studio/shelf/pulls --input $TMPD/missing.json"
passes "gh api repos/WAB-Studio/shelf/pulls --input $TMPD/ok.json"
blocks "gh api repos/WAB-Studio/shelf/pulls -f base=integracion -f head=x -F body=@$TMPD/bad.md"
passes "gh api repos/WAB-Studio/shelf/pulls -f base=integracion -f head=x -F body=@$TMPD/ok.md"
blocks "gh api repos/WAB-Studio/shelf/pulls -f base=integracion -f head=x -F body=@$TMPD/missing.md"
# gh-rest.sh refuses a trailer before any network call
GHR="$HERE/../gh-rest.sh"
# A refusal is exit 1 with gh-rest's own message; any other failure (not executable, gh missing) is no proof.
refused() { local err; err="$("$GHR" "$@" 2>&1 >/dev/null)"; [ $? -eq 1 ] && [[ $err == gh-rest:* ]]; }
refused pr-create x --title t --body-file "$TMPD/bad.md" || { echo "FAIL: gh-rest trailer"; FAILS=$((FAILS+1)); }
refused pr-create x --base main || { echo "FAIL: gh-rest base"; FAILS=$((FAILS+1)); }
rm -rf "$TMPD"
passes 'scripts/gh-rest.sh pr-create nube --title t'

[ $FAILS -eq 0 ] && echo "guard-bash: all green" || { echo "$FAILS failed"; exit 1; }
