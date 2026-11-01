#!/usr/bin/env bash
# GitHub over REST. The cloud proxy refuses GraphQL, so `gh pr` and `gh issue` fail there.
#
#   scripts/gh-rest.sh pr-create <head> [--title t] [--body-file f]
#   scripts/gh-rest.sh pr-view <n> | pr-checks <n> | pr-list
#   scripts/gh-rest.sh pr-merge <n> --squash
#
# The base is always integracion; a PR whose base is main is the deploy and is never merged here.
set -euo pipefail

REPO="${GH_REPO:-WAB-Studio/shelf}"
BASE=integracion
api() { gh api "$@"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  pr-create)
    head="${1:?head branch}"; shift
    title="$head"; body=""
    while (($#)); do
      case $1 in
        --title) title="${2:?title}"; shift 2 ;;
        --body-file) body="$(cat "${2:?file}")"; shift 2 ;;
        --base|-B) echo "gh-rest: base is always $BASE; $1 is refused." >&2; exit 1 ;;
        *) echo "gh-rest: unknown option $1" >&2; exit 1 ;;
      esac
    done
    api "repos/$REPO/pulls" -f "title=$title" -f "head=$head" -f "base=$BASE" -f "body=$body" --jq '.html_url'
    ;;
  pr-view)
    n="${1:?number}"
    api "repos/$REPO/pulls/$n" --jq '"state=\(.state) merged=\(.merged) mergeable=\(.mergeable) base=\(.base.ref) head=\(.head.sha)"'
    ;;
  pr-checks)
    n="${1:?number}"
    sha="$(api "repos/$REPO/pulls/$n" --jq '.head.sha')"
    api "repos/$REPO/commits/$sha/check-runs" --paginate --jq '.check_runs[] | "\(.name) \(.status) \(.conclusion // "-")"'
    ;;
  pr-list)
    api "repos/$REPO/pulls?state=open&per_page=50" --jq '.[] | "#\(.number) \(.head.ref) -> \(.base.ref) \(.title)"'
    ;;
  pr-merge)
    n="${1:?number}"; shift
    [ "${1:-}" = "--squash" ] || { echo "gh-rest: pr-merge takes --squash." >&2; exit 1; }
    base="$(api "repos/$REPO/pulls/$n" --jq '.base.ref')"
    [ "$base" = "$BASE" ] || { echo "gh-rest: PR #$n targets $base; only integracion merges here. The merge into main is the deploy: the user does it." >&2; exit 1; }
    api -X PUT "repos/$REPO/pulls/$n/merge" -f merge_method=squash --jq '.message'
    ;;
  *) echo "usage: gh-rest.sh pr-create|pr-view|pr-checks|pr-list|pr-merge …" >&2; exit 1 ;;
esac
