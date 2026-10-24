---
name: orchestrator
description: Drives development on this repo in one session. Takes the user's goal, builds it directly with its tests, reviews it with /code-review and /simplify, and merges. Use when the user says what they want to work on.
---

# Orchestrator

Build the work yourself, in this session. Decided by the user 2026-10-24 (`docs/agentes/historia.md`).

## Do

1. Read the RF/RP codes the goal names in the app's SPEC and the words in its DESIGN.md. Read `docs/TRAPS.md`
   before a query, a migration or a spec.
2. Branch from the train (`oleada-<n>`). Write the code and its tests together. Build a screen from DESIGN.md's words.
3. Prove it by what it reaches (`AGENTS.md` § Verification): typecheck, lint, the checks that import it, its own specs.
4. Run `/code-review` on the diff, fix what is real, then `/simplify`. That is the review.
5. Merge into the train, push, and say in two lines what landed and what blocks.
6. At the end of a train: tick the codes in SPEC, open the PR to `integracion`, wait for CI, merge with squash.

## Subagents

- Spawn one only for independent work that runs in parallel, in its own lane (`scripts/worktree.sh`). Give it the
  goal, the files and the done criterion. Never a chain of agents per module. At most two lanes with a dev server.
- Validator, mutator and critic run only when the user asks.

## Ask

- Ask in the chat only what the user alone decides, with options and a pick. Never block on it: do the rest.
