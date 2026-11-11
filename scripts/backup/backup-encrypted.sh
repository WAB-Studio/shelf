#!/usr/bin/env bash
# The copy kept outside Supabase: backup.sh, packed and encrypted with age for the recipient in recipient.txt, into a
# clone of the private repository WAB-Studio/shelf-copias, on its `copias` branch. Only the private key of that
# recipient (private/LLAVE-COPIAS-age.txt, kept off this machine too) opens a copy.
# The branch is rebuilt as one commit holding the copies of the last 35 days, so an older copy leaves the history too.
# Pushed with the git credentials of whoever runs it.
# Usage: scripts/backup/backup-encrypted.sh /path/to/clone-of-shelf-copias
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${1:?usage: backup-encrypted.sh /path/to/clone-of-shelf-copias}"
branch="copias"
keep_days=35

git -C "$repo" rev-parse --git-dir > /dev/null
[ -f "$here/recipient.txt" ] || { echo "recipient.txt is missing" >&2; exit 1; }
# Start from the published branch so the copies already there are kept and pruned.
if git -C "$repo" fetch -q origin "$branch" 2> /dev/null; then git -C "$repo" checkout -q -B "$branch" FETCH_HEAD; fi

dir="$("$here/backup.sh" | tail -1)"
name="$(basename "$dir")"
tar -C "$(dirname "$dir")" -czf - "$name" | age -R "$here/recipient.txt" -o "$repo/$name.tar.gz.age"
rm -rf "$dir"

# Names are UTC times, so they sort as dates.
oldest="$(date -u -d "$keep_days days ago" +%Y-%m-%dT%H%M%SZ)"
for f in "$repo"/*.tar.gz.age; do
  [[ "$(basename "$f" .tar.gz.age)" < "$oldest" ]] && rm "$f"
done

git -C "$repo" branch -q -D next 2> /dev/null || true
git -C "$repo" checkout -q --orphan next
git -C "$repo" add -A .
git -C "$repo" commit -qm "Copia $name"
git -C "$repo" branch -M "$branch"
git -C "$repo" push -q --force origin "$branch"
echo "$repo/$name.tar.gz.age"
