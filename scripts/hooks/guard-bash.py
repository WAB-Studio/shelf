#!/usr/bin/env python3
"""PreToolUse hook for Bash: refuses the commands AGENTS.md forbids.

Reads the hook JSON on stdin. Exit 2 with one line on stderr blocks the call;
exit 0 lets it pass. Test: scripts/hooks/test-guard-bash.sh
"""
import json
import os
import re
import subprocess
import sys

AUTHOR = "wilson <cxrkeybwp2004@gmail.com>"
TRAILERS = re.compile(
    r"co-authored-by|claude-session|generated with \[?claude code", re.I
)


def strip_quoted(cmd):
    """Drop heredoc bodies and quoted strings so prose never reads as a command."""
    cmd = re.sub(
        r"<<-?\s*(['\"]?)(\w+)\1.*?\n.*?\n\s*\2\b", " ", cmd, flags=re.S
    )
    cmd = re.sub(r"'[^']*'", "''", cmd)
    cmd = re.sub(r'"(?:\\.|[^"\\])*"', '""', cmd)
    return cmd


def option(tokens, long, short=None):
    for i, t in enumerate(tokens):
        if t.startswith(long + "="):
            return t.split("=", 1)[1]
        if t == long or (short and t == short):
            return tokens[i + 1] if i + 1 < len(tokens) else ""
    return None


def git_identity(cwd):
    name = os.environ.get("GUARD_GIT_NAME")
    email = os.environ.get("GUARD_GIT_EMAIL")
    if name is not None and email is not None:
        return f"{name} <{email}>"

    def cfg(key):
        r = subprocess.run(
            ["git", "-C", cwd or ".", "config", key], capture_output=True, text=True
        )
        return r.stdout.strip()

    return f"{cfg('user.name')} <{cfg('user.email')}>"


def current_branch(cwd):
    b = os.environ.get("GUARD_BRANCH")
    if b is not None:
        return b
    r = subprocess.run(
        ["git", "-C", cwd or ".", "branch", "--show-current"],
        capture_output=True,
        text=True,
    )
    return r.stdout.strip()


def check(cmd, cwd):
    bare = strip_quoted(cmd)
    segments = [s.split() for s in re.split(r"&&|\|\||;|\||\n", bare)]
    segments = [s for s in segments if s]

    for seg in segments:
        # Drop leading env assignments and `cd`-less wrappers.
        while seg and re.match(r"^\w+=", seg[0]):
            seg = seg[1:]
        if not seg:
            continue
        head = seg[0]
        rest = seg[1:]

        if head == "pkill" and any(
            a == "--full" or re.match(r"^-[A-Za-z0-9]*f[A-Za-z0-9]*$", a) for a in rest
        ):
            return "pkill -f matches your own shell: free a port with fuser -k <port>/tcp."

        if head != "git":
            continue
        # Skip git's global options (-C dir, -c k=v).
        i = 0
        while i < len(rest) and rest[i].startswith("-"):
            i += 2 if rest[i] in ("-C", "-c") else 1
        sub = rest[i] if i < len(rest) else ""
        args = rest[i + 1 :]

        if sub == "stash":
            return "git stash is forbidden: every worktree shares one refs/stash. Use git diff > private/x.patch."
        if sub == "push":
            for a in args:
                if a.startswith("-"):
                    continue
                dst = a.split(":")[-1].lstrip("+")
                if dst in ("main", "refs/heads/main"):
                    return "git push to main is refused by the ruleset: open a PR from integracion."

    for seg in segments:
        if seg[:3] == ["gh", "pr", "merge"] or (
            seg[:2] == ["gh", "pr"] and "merge" in seg[:3]
        ):
            for s2 in segments:
                if (
                    s2[:2] == ["git", "branch"]
                    and any(a in ("-d", "-D", "--delete") for a in s2)
                ) or (
                    s2[:2] == ["git", "push"]
                    and any(a == "--delete" or a == "-d" or a.startswith(":") for a in s2)
                ):
                    return "Read gh pr view --json state = MERGED first; never chain a branch delete after gh pr merge."
            break

    is_commit = any(
        s[:2] == ["git", "commit"] or (len(s) > 3 and s[0] == "git" and "commit" in s[:5])
        for s in segments
    )
    is_pr = any(s[:2] == ["gh", "pr"] and len(s) > 2 and s[2] in ("create", "edit", "comment", "merge") for s in segments)

    if (is_commit or is_pr) and TRAILERS.search(cmd):
        return "No Claude trailer: no Co-Authored-By, Claude-Session or Generated-with footer."

    if is_commit:
        m = re.search(r"--author[= ]\s*(?:\"([^\"]*)\"|'([^']*)'|(\S+))", cmd)
        author = (m.group(1) or m.group(2) or m.group(3)) if m else git_identity(cwd)
        if author != AUTHOR:
            return f"Commit as {AUTHOR}; the author here is {author!r}."

    for seg in segments:
        if seg[:3] == ["gh", "pr", "create"]:
            args = seg[3:]
            base = option(args, "--base", "-B")
            head = option(args, "--head", "-H") or current_branch(cwd)
            head = head.split(":")[-1]
            if base == "main" and head == "integracion":
                continue
            if base != "integracion":
                return f"Point every PR at integracion (base is {base or 'unset, so main'}); only integracion -> main may target main."
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    cmd = (data.get("tool_input") or {}).get("command", "")
    reason = check(cmd, data.get("cwd", ""))
    if reason:
        print(reason, file=sys.stderr)
        return 2
    return 0


sys.exit(main())
