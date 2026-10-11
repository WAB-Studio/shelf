#!/usr/bin/env bash
# Stop hook — tells the session to close its handoff once the window is large.
#
# The size is read, not guessed: every assistant turn records its usage in the
# transcript, and the last one's input + cache creation + cache read is the
# window as the API saw it. Measured 2026-09-05: that sum read 262 626 against
# the 262k the client displayed, while bytes/4 claimed 438k — the real ratio on
# this transcript was 7.03 bytes a token, and it drifts with how much of a turn
# is tool output. Only a transcript with no usage line falls back to bytes.
#
# Threshold: HANDOFF_TOKENS, default 500000. Fires once. Never blocks.

input=$(cat)

python3 - "$input" <<'PY'
import json, os, sys
from pathlib import Path

LIMIT = int(os.environ.get("HANDOFF_TOKENS", "500000"))

try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)

path = Path(d.get("transcript_path") or "")
session = d.get("session_id") or "unknown"
if not path.is_file():
    sys.exit(0)

# The tail holds the newest turns; the whole file is reread every turn otherwise.
with path.open("rb") as fh:
    size = fh.seek(0, os.SEEK_END)
    fh.seek(max(0, size - 512_000))
    lines = fh.read().splitlines()

tokens, measured = None, False
for line in reversed(lines):
    try:
        usage = (json.loads(line).get("message") or {}).get("usage") or {}
    except Exception:
        continue
    if "cache_read_input_tokens" not in usage:
        continue
    tokens = (
        usage.get("input_tokens", 0)
        + usage.get("cache_creation_input_tokens", 0)
        + usage.get("cache_read_input_tokens", 0)
    )
    measured = True
    break

if tokens is None:
    tokens = size // 7

if tokens < LIMIT:
    sys.exit(0)

marker = Path(os.environ.get("TMPDIR", "/tmp")) / f"claude-handoff-warned-{session}"
if marker.exists():
    sys.exit(0)
marker.touch()

k = tokens // 1000
how = "leídos del transcript" if measured else "estimados por tamaño"
print(json.dumps({
    "hookSpecificOutput": {
        # Required by the schema; the output is rejected whole without it.
        "hookEventName": "Stop",
        "systemMessage": f"Contexto {k}k tokens ({how}): no se despacha nada nuevo; se cierra cuando terminen los carriles.",
        "additionalContext": (
            f"The window is at {k}k tokens, {how}, past the {LIMIT // 1000}k mark the user set "
            "for draining a session. **Dispatch no new agent and start no new work. Never TaskStop a running "
            "agent**: let each finish, then merge or record what it returns. Stop only one that has made no "
            "progress for 30 minutes. When no agent runs, run the `handoff` skill to close: push every branch, "
            "verify no Claude attribution, write private/handoffs/, and tell the user the path."
            + ("" if measured else " The figure is an estimate; report it as approximate.")
        ),
    }
}))
PY

exit 0
