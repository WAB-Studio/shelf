#!/usr/bin/env python3
"""PreToolUse hook for Bash: refuses the commands AGENTS.md forbids.

Reads the hook JSON on stdin. Exit 2 with one line on stderr blocks the call;
exit 0 lets it pass. Test: scripts/hooks/test-guard-bash.sh

The command is parsed into simple commands (quotes removed, heredoc bodies kept
apart, `$(...)`, backticks, subshells and `bash -c` unwrapped), so prose that
mentions a forbidden word never blocks and a wrapped command never hides.

Not covered: an alias defined in a file, a script that runs git itself, a
message file written by another process, `gh api` calls that open PRs.
"""
import json
import os
import re
import subprocess
import sys

AUTHOR = "wilson <cxrkeybwp2004@gmail.com>"
TRAILER_LINE = re.compile(r"^\s*(co-authored-by|claude-session)\s*:", re.I | re.M)
TRAILER_ANY = re.compile(r"generated with \[?claude code|claude\.ai/code/session", re.I)
TRAILER_MSG = "No Claude trailer: no Co-Authored-By, Claude-Session or Generated-with footer."

WRAPPERS = {"sudo", "env", "command", "time", "nice", "nohup", "exec", "builtin", "xargs", "timeout", "stdbuf", "doas"}
WRAPPER_VALUE_OPTS = {"-u", "-C", "-S", "-n", "-s", "-k", "-p", "-g", "-i", "-I", "-L", "-P", "-d", "-E"}
CONTROL_WORDS = {"{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "case", "esac", "for"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
GIT_VALUE_OPTS = {"--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"}
PUSH_VALUE_OPTS = {"--repo", "-o", "--push-option", "--receive-pack", "--exec"}
ASSIGN = re.compile(r"^[A-Za-z_]\w*=")
FULL_FLAG = re.compile(r"^-[A-Za-z0-9]*f[A-Za-z0-9]*$")


class Cmd:
    def __init__(self, tokens, heredocs):
        self.tokens = tokens
        self.heredocs = heredocs


def scan(s, i, sub, out):
    """Split `s` from `i` into simple commands appended to `out`. In a `$(`, stops
    after the matching `)` and returns the index there."""
    n = len(s)
    tokens, heredocs, pending = [], [], []
    word = None

    def end_word():
        nonlocal word
        if word is not None:
            tokens.append(word)
            word = None

    def end_cmd():
        nonlocal tokens, heredocs
        end_word()
        if tokens or heredocs:
            out.append(Cmd(tokens, heredocs))
        tokens, heredocs = [], []

    def add(text):
        nonlocal word
        word = (word or "") + text

    while i < n:
        c = s[i]
        if c == "\\":
            if i + 1 < n and s[i + 1] == "\n":
                i += 2
                continue
            add(s[i + 1] if i + 1 < n else "")
            i += 2
        elif c == "'":
            j = s.find("'", i + 1)
            j = n if j < 0 else j
            add(s[i + 1 : j])
            i = j + 1
        elif c == '"':
            i += 1
            add("")
            while i < n and s[i] != '"':
                if s[i] == "\\" and i + 1 < n:
                    add(s[i + 1] if s[i + 1] in '"\\$`' else s[i : i + 2])
                    i += 2
                elif s[i] == "$" and s[i + 1 : i + 2] == "(":
                    start = i
                    i = scan(s, i + 2, True, out)
                    add(s[start:i])
                elif s[i] == "`":
                    j = s.find("`", i + 1)
                    j = n if j < 0 else j
                    scan(s[i + 1 : j], 0, False, out)
                    add(s[i : j + 1])
                    i = j + 1
                else:
                    add(s[i])
                    i += 1
            i += 1
        elif c == "$" and s[i + 1 : i + 2] == "(":
            start = i
            i = scan(s, i + 2, True, out)
            add(s[start:i])
        elif c == "`":
            j = s.find("`", i + 1)
            j = n if j < 0 else j
            scan(s[i + 1 : j], 0, False, out)
            add(s[i : j + 1])
            i = j + 1
        elif c in " \t":
            end_word()
            i += 1
        elif c == "\n":
            end_word()
            i += 1
            for delim, strip in pending:
                body = []
                while i < n:
                    j = s.find("\n", i)
                    j = n if j < 0 else j
                    line = s[i:j]
                    i = j + 1
                    if (line.lstrip("\t") if strip else line).strip() == delim:
                        break
                    body.append(line)
                heredocs.append("\n".join(body))
            pending = []
            end_cmd()
        elif c == ";":
            end_cmd()
            i += 1
        elif c == "|":
            end_cmd()
            i += 2 if s[i + 1 : i + 2] == "|" else 1
        elif c == "&":
            if s[i + 1 : i + 2] == "&":
                end_cmd()
                i += 2
            elif (i > 0 and s[i - 1] in "<>") or s[i + 1 : i + 2] == ">":
                add("&")
                i += 1
            else:
                end_cmd()
                i += 1
        elif c == "(":
            end_cmd()
            i += 1
        elif c == ")":
            end_cmd()
            i += 1
            if sub:
                return i
        elif c == "<" and s[i : i + 2] == "<<" and s[i : i + 3] != "<<<":
            j = i + 2
            strip = s[j : j + 1] == "-"
            j += 1 if strip else 0
            while j < n and s[j] in " \t":
                j += 1
            delim = ""
            while j < n and s[j] not in " \t\n;|&()<>":
                if s[j] in "'\"":
                    k = s.find(s[j], j + 1)
                    k = n if k < 0 else k
                    delim += s[j + 1 : k]
                    j = k + 1
                else:
                    delim += s[j]
                    j += 1
            pending.append((delim, strip))
            end_word()
            i = j
        elif c == "#" and word is None:
            while i < n and s[i] != "\n":
                i += 1
        else:
            add(c)
            i += 1
    end_cmd()
    return i


def option(tokens, long, short=None):
    for i, t in enumerate(tokens):
        if t.startswith(long + "="):
            return t.split("=", 1)[1]
        if t == long or (short and t == short):
            return tokens[i + 1] if i + 1 < len(tokens) else ""
    return None


def option_all(tokens, longs, shorts=()):
    vals = []
    for i, t in enumerate(tokens):
        for l in longs:
            if t.startswith(l + "="):
                vals.append(t.split("=", 1)[1])
        if (t in longs or t in shorts) and i + 1 < len(tokens):
            vals.append(tokens[i + 1])
    return vals


def run_git(cwd, *args):
    r = subprocess.run(["git", "-C", cwd or ".", *args], capture_output=True, text=True)
    return r.stdout.strip()


def identity(cwd, overrides, env):
    """name, email the next commit would carry."""
    name = env.get("GIT_AUTHOR_NAME") or overrides.get("user.name")
    email = env.get("GIT_AUTHOR_EMAIL") or overrides.get("user.email")
    gname, gemail = os.environ.get("GUARD_GIT_NAME"), os.environ.get("GUARD_GIT_EMAIL")
    if gname is not None and gemail is not None:
        return name or gname, email or gemail
    return name or run_git(cwd, "config", "user.name"), email or run_git(cwd, "config", "user.email")


def current_branch(cwd):
    b = os.environ.get("GUARD_BRANCH")
    if b is not None:
        return b
    return run_git(cwd, "branch", "--show-current")


class Parsed:
    """One normalised command: what runs, with its env, cwd and heredocs."""

    def __init__(self, head, rest, env, cwd, heredocs):
        self.head, self.rest, self.env, self.cwd, self.heredocs = head, rest, env, cwd, heredocs


def normalise(cmds, cwd, depth=0):
    parsed = []
    for c in cmds:
        tokens = list(c.tokens)
        env = {}
        while tokens:
            t = tokens[0]
            if ASSIGN.match(t):
                k, v = t.split("=", 1)
                env[k] = v
                tokens.pop(0)
            elif t in CONTROL_WORDS:
                tokens.pop(0)
            elif t in WRAPPERS:
                w = tokens.pop(0)
                while tokens and (
                    tokens[0].startswith("-")
                    or ASSIGN.match(tokens[0])
                    or (w == "timeout" and re.match(r"^\d", tokens[0]))
                ):
                    o = tokens.pop(0)
                    if ASSIGN.match(o):
                        env[o.split("=", 1)[0]] = o.split("=", 1)[1]
                    elif o in WRAPPER_VALUE_OPTS and tokens:
                        tokens.pop(0)
            else:
                break
        if not tokens:
            continue
        head = os.path.basename(tokens[0])
        rest = tokens[1:]
        if head == "cd":
            if rest:
                cwd = os.path.normpath(os.path.join(cwd or ".", os.path.expanduser(rest[0])))
            continue
        scripts = []
        if head in SHELLS:
            for k, a in enumerate(rest):
                if a.startswith("-") and not a.startswith("--") and "c" in a and k + 1 < len(rest):
                    scripts.append(rest[k + 1])
                    break
        elif head == "eval":
            scripts.append(" ".join(rest))
        if scripts and depth < 5:
            for sc in scripts:
                inner = []
                scan(sc, 0, False, inner)
                parsed += normalise(inner, cwd, depth + 1)
            continue
        parsed.append(Parsed(head, rest, env, cwd, c.heredocs))
    return parsed


def git_parts(p):
    """Git's global options folded away: subcommand, its args, the cwd it runs in, `-c` overrides."""
    rest, i = p.rest, 0
    overrides, cwd = {}, p.cwd
    while i < len(rest) and rest[i].startswith("-"):
        o = rest[i]
        if o == "-C" and i + 1 < len(rest):
            cwd = os.path.normpath(os.path.join(cwd or ".", rest[i + 1]))
            i += 2
        elif o == "-c" and i + 1 < len(rest):
            k, _, v = rest[i + 1].partition("=")
            overrides[k.lower()] = v
            i += 2
        elif o in GIT_VALUE_OPTS:
            i += 2
        else:
            i += 1
    sub = rest[i] if i < len(rest) else ""
    return sub, rest[i + 1 :], cwd, overrides


def gh_args(p):
    """`gh`'s words with the global -R/--repo dropped."""
    rest, out, i = p.rest, [], 0
    while i < len(rest):
        if rest[i] in ("-R", "--repo"):
            i += 2
        elif rest[i].startswith("--repo="):
            i += 1
        else:
            out.append(rest[i])
            i += 1
    return out


def is_delete(p):
    if p.head == "git":
        sub, args, _, _ = git_parts(p)
        if sub == "branch" and any(re.match(r"^-[a-zA-Z]*[dD]", a) or a == "--delete" for a in args):
            return True
        if sub == "push" and any(a in ("-d", "--delete") or a.startswith(":") for a in args):
            return True
        if sub == "worktree" and args[:1] == ["remove"]:
            return True
    if p.head == "gh":
        a = gh_args(p)
        if a[:1] == ["api"]:
            m = option(a, "--method", "-X")
            return bool(m and m.upper() == "DELETE") or "-XDELETE" in a
    return False


def message_text(args, cwd, heredocs, all_bodies, raw):
    """Everything a commit or a PR could carry as its message."""
    text = "\n".join(args) + "\n" + "\n".join(heredocs)
    files = option_all(args, ["--file", "--body-file"], ["-F"])
    if files:
        text += "\n" + "\n".join(all_bodies)
    for f in files:
        if f == "-":
            text += "\n" + raw.replace("\\n", "\n")
            continue
        path = f if os.path.isabs(f) else os.path.join(cwd or ".", f)
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                text += "\n" + fh.read()
        except OSError:
            pass
    return text


def has_trailer(text):
    return bool(TRAILER_LINE.search(text) or TRAILER_ANY.search(text))


def check(cmd, cwd):
    cmds = []
    scan(cmd, 0, False, cmds)
    parsed = normalise(cmds, cwd or ".")
    all_bodies = [b for c in cmds for b in c.heredocs]

    gh_merge = False
    for p in parsed:
        if p.head in ("pkill", "pgrep") and any(a == "--full" or FULL_FLAG.match(a) for a in p.rest):
            return f"{p.head} -f matches your own shell: free a port with fuser -k <port>/tcp."

        if p.head == "gh":
            a = gh_args(p)
            if a[:2] == ["pr", "merge"]:
                gh_merge = True
                if any(x in ("-d", "--delete-branch") for x in a):
                    return "Never delete a branch with gh pr merge: read gh pr view --json state = MERGED first."

        if p.head != "git":
            continue
        sub, args, gcwd, _ = git_parts(p)
        if sub == "stash" and (not args or args[0] not in ("list", "show")):
            return "git stash is forbidden: every worktree shares one refs/stash. Use git diff > private/x.patch."
        if sub == "config" and any(a.startswith("alias.") for a in args):
            return "A git alias hides the command it runs from the guard: call the command itself."
        if sub == "push":
            if any(a in ("--all", "--mirror") for a in args):
                return "git push --all/--mirror reaches main: push the branch by name."
            pos, i = [], 0
            while i < len(args):
                if args[i] in PUSH_VALUE_OPTS:
                    i += 2
                    continue
                if not args[i].startswith("-"):
                    pos.append(args[i])
                i += 1
            refspecs = pos[1:]
            on_main = current_branch(gcwd) == "main"
            if not refspecs and on_main:
                return "git push from main is refused by the ruleset: open a PR from integracion."
            for r in refspecs:
                dst = r.split(":")[-1].lstrip("+")
                if dst in ("main", "refs/heads/main") or (dst in ("HEAD", "@") and on_main):
                    return "git push to main is refused by the ruleset: open a PR from integracion."

    if gh_merge and any(is_delete(p) for p in parsed):
        return "Read gh pr view --json state = MERGED first; never chain a branch delete after gh pr merge."

    for p in parsed:
        if p.head == "git":
            sub, args, gcwd, overrides = git_parts(p)
            if sub != "commit":
                continue
            if has_trailer(message_text(args, gcwd, p.heredocs, all_bodies, cmd)):
                return TRAILER_MSG
            author = option(args, "--author")
            if author is None:
                name, email = identity(gcwd, overrides, p.env)
                if not name and not email:
                    continue
                author = f"{name} <{email}>"
            if author != AUTHOR:
                return f"Commit as {AUTHOR}; the author here is {author!r}."
            ce, cn = p.env.get("GIT_COMMITTER_EMAIL"), p.env.get("GIT_COMMITTER_NAME")
            if (ce and ce != "cxrkeybwp2004@gmail.com") or (cn and cn != "wilson"):
                return f"Commit as {AUTHOR}; the committer here is {cn or ''} <{ce or ''}>."
        elif p.head == "gh":
            a = gh_args(p)
            if a[:1] != ["pr"] or len(a) < 2 or a[1] not in ("create", "edit", "comment", "merge", "review"):
                continue
            if has_trailer(message_text(a[2:], p.cwd, p.heredocs, all_bodies, cmd)):
                return TRAILER_MSG
            if a[1] in ("create", "edit"):
                base = option(a[2:], "--base", "-B")
                head = (option(a[2:], "--head", "-H") or current_branch(p.cwd)).split(":")[-1]
                if a[1] == "edit" and base is None:
                    continue
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
    try:
        reason = check(cmd, data.get("cwd", ""))
    except Exception as e:
        print(f"guard-bash: internal error, call allowed ({e!r})", file=sys.stderr)
        return 0
    if reason:
        print(reason, file=sys.stderr)
        return 2
    return 0


sys.exit(main())
