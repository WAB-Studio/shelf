---
name: handoff
description: Opens or closes a session against private/handoffs/. Use when the user says "iniciemos" (read the last handoff and pick the work back up) or "cerremos handoff" (write the next session's handoff before shutting down).
---

# Handoff

The one document that survives a session. `private/handoffs/HANDOFF-<YYYY-MM-DD>-<HHMM>.md`, America/Bogotá.

## Opening — "iniciemos"

1. Read the newest file in `private/handoffs/`.
2. Read `git log --oneline -8`, `git branch -vv`, `git worktree list`, `git status --short`.
3. Check the dev server on :3000. Start it if it is down.
4. Compare what the handoff says against what the repo shows. Say every difference out loud.
5. Take the first item of its `Lo que sigue` and start. Ask nothing the handoff already answers.

## Closing — "cerremos handoff", or on the window's own warning

The `context-watch.sh` hook says when the window passes 500k tokens. From then on dispatch nothing
new, let every running agent finish, and close when none runs. Never ask the user whether to keep going
or close: the hook says when.

1. **Wait for every subagent still running.** Never `TaskStop` one, except one with no progress in
   30 minutes: say in the file what it was doing and what it had proved.
   «cerremos handoff» from the user closes at once: stop what runs, the same way.
2. Commit and push every branch that carries work. Leave no tree dirty. Copy every lane's `private/` and
   `apps/*/private/` into the main checkout before dropping it.
3. Run `git log <base>..HEAD --format='%h %an <%ae>%n%(trailers)'` on each. No Claude attribution.
4. Write the file.
5. Put what outlives the session in the file that owns it, never in memory outside the repo:
   a rule where `AGENTS.md` § Writing says, its measurement in `docs/agentes/historia.md`, a trap in
   `docs/TRAPS.md`, a tick in `docs/SPEC.md`, a judge's row in `docs/agentes/rendimiento-jueces.tsv`.
6. Count the trains in `docs/agentes/rendimiento-jueces.tsv` since its last review. At 5, or when the model
   changed, put the pruning review first in `Lo que sigue`.
7. Tell the user the path.

## What the file carries

- **§1 Lo primero que hay que saber** — the branches, their tips, what is merged, what is running, what is open.
- **§2..§n** — one section per piece of work, with the numbers that were measured.
- **Lo que sigue** — numbered, in order, first item ready to start.
- **Pendiente** — what a judge found after the slice's list was fixed, and every mutator survivor.
- **Reglas duras** — what cost blood and will cost it again.
- **Lecciones** — what the next session should do differently.

## How it is written

- Say what was verified and how. Say plainly what was not.
- Give the number, not the adjective. «145/0/9 en 11,6 m», never «la suite pasó bien».
- Name the file and the line. `accounts-screen.tsx:502`, not «la pantalla de cuentas».
- Carry every decision the user took, and mark which ones are closed.
- Carry the questions still waiting on the user, in their own line.
- Write it in the user's language.
