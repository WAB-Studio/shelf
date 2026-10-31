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

The unit is the **app-day**: the seconds one app was in front while the person was at the
computer, on one civil day in Bogotá, from one device. Nothing finer is ever sent or stored.

Interface language: Spanish or English, the person's choice (RT-12). A person reads only their own log.

### Functional requirements

- [x] **RT-01** An upload carries, per device and day, the seconds each app was active with the person
  at the computer (ActivityWatch's AFK watcher says not-afk). It never carries a window title, a URL
  or an event. (P5, 1a)
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

### Non-functional requirements

- [x] **RNT-01** Every row is the person's alone: RLS on every table, read as `authenticated`, and no
  role reaches a table but through a policy or a definer function.
- [x] **RNT-02** An upload is one transaction: a day is never half replaced.
- [x] **RNT-03** Seconds are integers. Hours and minutes are derived for display, never stored.
- [x] **RNT-04** A screen fans its reads out at once and pays one session settle per read.
- [x] **RNT-05** No proof calls a paid service.

### Retired

None.

---

## 4. Stack

The monorepo's: Next.js 16, React 19, Radix Themes, next-intl, drizzle-orm on Supabase Postgres,
`@repo/supabase-auth`, `mcp-handler`. Nothing else is installed for TimeLog.
