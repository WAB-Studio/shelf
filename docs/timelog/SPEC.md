# TimeLog — specification

> Section 1 is the contract. What is not in it does not get built. How each requirement is met is
> decided at implementation time.

Decided by the user 2026-10-28 (P5): «1. A 2. TimeLog 3. A», over ActivityWatch, with the uploader
forked from `ActivityWatch/aw-client` and adapted («de ese repo lo mejoramos y tales a nuestras
necesidades»).

---

## 1. Specification

### Context

A person wants to know where the computer's hours go. ActivityWatch already records it on the PC,
minute by minute, and never leaves the machine. TimeLog keeps a daily summary of it where the other
apps and Claude can read it: which app, how long, on which day.

Since 2026-10-30 the same upload also carries the **site-day** (seconds per website hostname), the
**page-day** and **window-day** (per page and per window title), the **Claude Code day** and its sessions, with
the same rule: seconds per day, classified on the PC, with private windows and an exclusion list left behind.

The unit is the **app-day**: the seconds one app was in front while the person was at the
computer, on one civil day in Bogotá, from one device. Nothing finer is ever sent or stored.

Interface language: Spanish or English, the person's choice (RT-12). A person reads only their own log.

### Functional requirements

- [x] **RT-02** An upload replaces that device's day whole: sending the same day twice leaves one copy,
  and a later upload of a day already sent corrects it.
- [x] **RT-03** An upload names its person by a key, never by a session. A key is shown once, kept as
  its hash, named by the person, and can be revoked; a revoked key uploads and reads nothing.
- [x] **RT-04** «Hoy» lists today's apps, longest first, with each one's time and the day's total. A
  day with no upload says so and says when the last upload arrived.
- [x] **RT-05** «Semana» shows Monday to Sunday: each day's total, and the week's apps, longest first.
  ‹ › step a week at a time back to the first upload and forward to this week.
- [x] **RT-06** «Llaves» creates a key, names it, shows it once with the command that uses it, lists
  the keys with their last use, and revokes one.
- [x] **RT-07** The MCP server answers with the same key: a day's apps, a week's days and apps, and a
  range of days' totals. It writes nothing. (P5, 3a)
- [x] **RT-08** A person signs in by email, the way GoalLog does. Only an allowed address may.
- [x] **RT-09** The uploader is `timelog-sync`, adapted from `aw-client`: `aw-client timelog --url
  <TimeLog> --key <key> [--days N]` sends the last N days (default 2) and can run on a schedule.
- [x] **RT-10** ActivityWatch + TimeLog, our fork of ActivityWatch's Windows installer, bundles
  `aw-timelog`: it starts with ActivityWatch and uploads every hour with the key pasted in the tray,
  «TimeLog: pegar llave…». «Llaves» links its latest release.
- [x] **RT-11** Any past day opens on its own screen, with the same block and the same list as «Hoy»;
  from «Semana» the day is reached by touching it, and the day's screen carries ‹ › to the day before
  and the day after. A day that is not a real date, or has not arrived, is a 404. (2026-10-30)
- [x] **RT-12** The interface is served in Spanish and in English. The language is the person's choice,
  kept in a cookie, else the browser's, else Spanish; no address changes with it. (2026-10-30)
- [x] **RT-13** An upload may carry, per device and day, the seconds each website was in front with the
  person at the computer, by hostname alone (`github.com`, `claude.ai`; no `www.`). A day that names its
  sites replaces them whole for that device; a day that does not leaves them as they are. (2026-10-30,
  «añadir tiempo de Claude Code, sesión, internet»)
- [x] **RT-14** An upload may carry, per device and day, the seconds Claude Code was working: the
  stretches between consecutive messages of its session logs at most five minutes apart (a lone message
  one minute), merged across sessions and cut at the Bogotá day. A day naming it replaces it whole; a
  zero stores no row. (2026-10-30)
- [x] **RT-15** «Exportar» downloads a CSV with a row per day of a range of up to 366 days: seconds at
  the computer, in Claude Code, on claude.ai, in the Claude app, Claude's total (the three added) and the
  top app. The MCP server answers the same rows (`get_daily`), read-only, with the same key.
  (2026-10-30, «si todos los días se exporta cuánto estuve trabajando en general sería bueno para mis métricas»)
- [x] **RT-16** An upload is classified on the PC and carries, per device and day, only seconds in buckets: per
  app; per window title inside an app (never a browser's: its titles are its pages); per website hostname and
  per page (its address without credentials, query and fragment, and its title); and Claude Code's seconds per
  day and per session (id, project folder, first and last message of the day). It never carries an event, a
  URL's query or fragment, or the content of a Claude Code message. The person's own rows are read only by them
  (RNT-01). Successor of RT-01. (2026-10-30, «Me gustaría que rastree todo más detallado»)
- [x] **RT-18** A day may carry the person's window titles per app and their pages; each part a day names
  replaces that device's day whole, a part it does not name is left alone. The server refuses a page that is
  not a bare `http(s)` address under its own hostname. Kept as long as app-days. (2026-10-30)
- [x] **RT-19** A day may carry its Claude Code sessions: id, project folder, first and last message and active
  seconds, on the same replace rule. «Hoy» and a day list them, longest first, with project and time span.
  (2026-10-30)
- [x] **RT-20** The PC drops, before building anything, private windows (the browser watcher's incognito mark and
  a window title naming a private window) and everything on a local exclusion list of hosts (with their
  subdomains) and apps. The list ships with Colombian banks (bancolombia.com, davivienda.com, bbva.com.co,
  nequi.com.co, daviplata.com) and password managers, and the person edits it in `aw-timelog.toml`
  (`exclude`), by `--exclude`, or from the tray. Excluded hosts and apps leave the PC as nothing, not even as
  seconds. (2026-10-30)
- [x] **RT-22** «Hoy» and any day show «Claude» (Claude Code, claude.ai and the Claude app, and
  «Claude en total» as their sum, then Claude Code's sessions) and «Internet» (the longest sites, each opening
  onto its pages); an app's row opens onto its longest window titles. «Semana» shows Claude's week
  total and a bar per day. Sites and pages come from the program on the PC, which reads the focused browser's
  address bar (Windows) or the browser's own history; never from a browser extension. Where a source never
  arrived the screen says what to do: update the program on the PC for sites, with a link to its install steps;
  the Claude folder for Claude Code. Successor of RT-17. (2026-11-01, «solo quiero que todo dependa del programa»)

### Non-functional requirements

- [x] **RNT-01** Every row is the person's alone: RLS on every table, read as `authenticated`, and no
  role reaches a table but through a policy or a definer function.
- [x] **RNT-02** An upload is one transaction: a day is never half replaced.
- [x] **RNT-03** Seconds are integers. Hours and minutes are derived for display, never stored.
- [x] **RNT-04** A screen fans its reads out at once and pays one session settle per read.
- [x] **RNT-05** No proof calls a paid service.

### Retired

- [x] **RT-01** — An upload carries, per device and day, the seconds each app was active with the person at the computer (ActivityWatch's AFK watcher says not-afk). It never carries a window title, a URL or an event. (P5, 1a) _Retired 2026-10-30, by the user («Me gustaría que rastree todo más detallado»). Successor: RT-16 (window titles, pages and Claude Code sessions join the upload, still never an event or a query; RT-20 drops private windows and an exclusion list on the PC)._
- [x] **RT-17** — «Hoy» and any day show «Claude» (Claude Code, claude.ai and the Claude app, and «Claude en total» as their sum, then Claude Code's sessions) and «Internet» (the longest sites, each opening onto its pages); an app's row opens onto its longest window titles. «Semana» shows Claude's week total and a bar per day. Where a source never arrived the screen says how to connect it: the browser extension for sites, the Claude folder for Claude Code. (2026-10-30) _Retired 2026-11-01, by the user («solo quiero que todo dependa del programa»). Successor: RT-22 (sites come from the program reading the address bar or the browser's history; the screen asks to update the program instead of installing an extension)._

---

## 4. Stack

The monorepo's: Next.js 16, React 19, Radix Themes, next-intl, drizzle-orm on Supabase Postgres,
`@repo/supabase-auth`, `mcp-handler`. Nothing else is installed for TimeLog.
