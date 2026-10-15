#!/usr/bin/env bash
# Stop hook — names the next module a session can actually take.
#
# A plan of 29 modules with no state is a plan that lives only in one session's
# head. On 2026-09-05 a wave landed, the report read complete, and the turn ended
# with nothing dispatched: the user had to ask what was happening. Nothing in the
# repo knew a module was pending, so nothing said so.
#
# A module carries its box in its header: `## [ ]` waiting, `## [~]` dispatched
# and in flight, `## [x]` landed. The hook reads those and the `Depende de:` line
# under each, and names the first waiting module whose dependencies are all
# ticked. Silent when nothing is takeable — every module in flight, blocked or
# done — because a session that cannot act on the reminder only pays for it.
# Silent too when no plan is open, or when the session is being told to close.
# Never blocks.

input=$(cat)

python3 - "$input" <<'PY'
import json, os, re, sys
from pathlib import Path

# `context-watch.sh` drops this the turn it tells the session to close. A session
# that is closing has been told to start nothing new, so naming the next module
# after that is noise on every remaining turn.
try:
    d = json.loads(sys.argv[1])
except Exception:
    d = {}
session = Path(str(d.get("transcript_path") or "")).stem
if session and (Path(os.environ.get("TMPDIR", "/tmp")) / f"claude-handoff-warned-{session}").exists():
    sys.exit(0)

root = Path(os.environ.get("CLAUDE_PROJECT_DIR", "."))
plans = sorted((root / "private").glob("plan-*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
if not plans:
    sys.exit(0)

plan = plans[0]
text = plan.read_text(encoding="utf-8", errors="replace")

header = re.compile(r"^## \[([ x~])\] ([A-Z]?\d+) [—·] (.+)$", re.M)
modules = [
    {"state": m.group(1), "number": m.group(2), "title": m.group(3).strip(), "at": m.end()}
    for m in header.finditer(text)
]
if not modules:
    sys.exit(0)

state = {m["number"]: m["state"] for m in modules}
bounds = [m["at"] for m in modules[1:]] + [len(text)]

def dependencies(module, end):
    body = text[module["at"]:end]
    line = re.search(r"\*\*Depende de:\*\*(.+)", body)
    return re.findall(r"\b[A-Z]?\d+\b", line.group(1).split(".")[0]) if line else []

waiting = [m for m in modules if m["state"] == " "]
flight = [m for m in modules if m["state"] == "~"]
done = [m for m in modules if m["state"] == "x"]
if not waiting:
    sys.exit(0)

# A dependency nobody has written yet cannot block: only a module the plan holds counts.
ready = [
    m
    for m, end in zip(modules, bounds)
    if m["state"] == " " and all(state.get(d, "x") == "x" for d in dependencies(m, end))
]
if not ready:
    sys.exit(0)

nxt = ready[0]
running = (
    f" Hay {len(flight)} en vuelo, marcado{'s' if len(flight) != 1 else ''} `## [~]`."
    if flight
    else ""
)
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "Stop",
        "additionalContext": (
            f"{len(done)} de {len(modules)} módulos de `{plan.relative_to(root)}` están hechos."
            f"{running} El primero que se puede tomar, con sus dependencias ya ticadas, es "
            f"**{nxt['number']} — {nxt['title']}**.\n\n"
            "No cierres el turno con un informe: tomalo, y marcá su `## [ ]` como `## [~]` al "
            "despacharlo y como `## [x]` en cuanto su rama aterrice. Si de verdad está bloqueado, "
            "decí en una línea por quién o por qué — un plan sin estado sólo existe mientras una "
            "sesión lo recuerde."
        ),
    }
}))
PY
