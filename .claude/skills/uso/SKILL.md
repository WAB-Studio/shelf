---
name: uso
description: Reads .claude/usage-log.tsv and says where the sessions went — which tools, which commands, which suites, which files — and proposes the skills or scripts worth building for what repeats. Use when asked what the agents spend their time on, or to look for new skills.
---

# Uso

The `log-usage.sh` hook writes one line per tool call: date, tool, detail. Read it and say where
the time went. Propose. Never build without the user's word.

## The log

```
tail -2000 .claude/usage-log.tsv
```

Columns are tab-separated: ISO date, tool name, detail — the command for `Bash`, the path for a
file tool, the pattern for a search, the agent type for a dispatch.

## What to answer

1. **Tool split.** One count per tool. Say what share is `Bash`, what share is reading files.
2. **The shapes.** Normalise every `Bash` command to its form: drop paths, hashes, ids, dates,
   `SELECT` bodies, lane numbers. `npm run check:e2e > <log>` and `npm run check:e2e` are one shape.
   Count the shapes and show the top fifteen with their counts.
3. **The suites.** Count the runs of `check:e2e`, `check:queries`, `check:http`, `db:check-rls`,
   `typecheck`, `lint`. Multiply by each suite's run time from its latest CI run or saved log, name
   where each number came from, and say what the session spent on verification.
4. **The waste.** Name the shapes repeated in a burst: the same suite run more than twice, a file
   read more than three times, the same grep re-run. Each one is either a script or a mistake.
5. **The candidates.** For a shape that repeats and has no skill in `.claude/skills/` and no script
   in `scripts/`, propose one: a name, one line of what it does, its arguments.
6. **What is unused.** Name a skill or script the log never shows.

## Rules

- Give the count. Never «se usa mucho».
- Propose. Build nothing without the user saying which.
- Say when the log is too short to conclude anything.
