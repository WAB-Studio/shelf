#!/usr/bin/env bash
# Paste this whole file into the environment's "Setup script" field at claude.ai/code.
# Self-contained: it runs as root before Claude starts and reads no path of the repo.
# Cached about 7 days when it ends in under 5 minutes, so it only warms downloads.
# Exits 0 always: a failed warm-up must not stop the session.
SUPABASE_VERSION="2.119.0"   # keep equal to scripts/supabase-local.sh

# The CLI's npx download, so the first `supabase-local.sh start` does not pay for it.
npx --yes "supabase@${SUPABASE_VERSION}" --version >/dev/null 2>&1 || echo "setup: supabase CLI warm-up failed"

# Docker images of the stack (the ones `supabase start -x ...` runs: db, auth, kong, mailpit).
# Not pulled here: the pull is unmeasured and may exceed the 5-minute cache budget. The first
# `scripts/supabase-local.sh start` of a session pulls them.

exit 0
