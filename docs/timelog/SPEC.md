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
- [x] **RT-08** A person signs in by email. Only an allowed address may.
- [x] **RT-09** The uploader is `timelog-sync`, adapted from `aw-client`: `aw-client timelog --url
  <TimeLog> --key <key> [--days N]` sends the last N days (default 2) and can run on a schedule.
- [x] **RT-10** ActivityWatch + TimeLog, our fork of ActivityWatch's Windows installer, bundles
  `aw-timelog`: it starts with ActivityWatch and uploads every hour with the key pasted in the tray,
  «TimeLog: pegar llave…». «Llaves» links its latest release.
- [x] **RT-11** Any past day opens on its own screen, with the same block and the same list as «Hoy»;
  from «Semana» the day is reached by touching it, and the day's screen carries ‹ › to the day before
  and the day after. A day that is not a real date, or is still to come ("has not arrived" means the future only), is a 404;
  a past day nothing arrived on opens the empty day. (2026-10-30)
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
- [x] **RT-25** «Exportar» downloads a CSV with a row per day of a range of up to 366 days, cut at today (a day that has
  not happened has no row): `day`, seconds at the computer, in Claude Code (the agent's work), on claude.ai, in the Claude
  app, `claude_seconds` (the three added, as before), `claude_screen_seconds` (claude.ai and the app, never Claude Code), the top app and its seconds, and `uploaded`
  (1 when any upload reached the day, 0 when none did, so a day unseen is told from a real zero). The MCP server answers
  the same rows (`get_daily`), read-only, with the same key. Successor of RT-15. (2026-11-08)
- [x] **RT-16** An upload is classified on the PC and carries, per device and day, only seconds in buckets: per
  app; per window title inside an app (never a browser's: its titles are its pages, and the server
  drops one that arrives); per website hostname and
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
- [x] **RT-23** The day shows «Proyectos» under Apps: the seconds in VS Code-family windows (VS Code, Insiders, OSS,
  VSCodium, Cursor) grouped by the workspace folder their window title names («file — folder — [profile —] product»,
  remote and tunnel tags removed), read from the window rows RT-18 already stores; no new field is uploaded. (2026-11-01)
- [ ] **RT-29** «Hoy» and any day are one screen in one column, 760 wide at most, under the header every screen shares. Its
  top line reads «Jueves 19 nov · 5 h 12 min en la computadora» with ‹ and › («Día anterior», «Día siguiente») a day away and
  a «Hoy» link when the day is not today; on today «Actualizado hace…» sits under it. Under the line, the day's one stacked bar
  by class (RT-32) and its legend: each class's name and time, longest first. Then Apps (eight rows, each a name and one bar,
  then «y N apps más · X»), Sitios (the same bars and «y N más», each site opening onto its pages), Proyectos (RT-23) and one
  line «Claude: 26 min en pantalla · Claude Code trabajó 1 h 7 min» that opens Claude Code's sessions named by project (RT-19);
  claude.ai is a site like any other, and a source that never arrived says so once, in a sentence. The Apps list starts inside
  the first screen at 390x844 and at 1440x900. A row that opens carries its › at the row's start, centred, in a hit area of at
  least 24. An app reads under its readable name: a `-Win64-Shipping` suffix is dropped, `VALORANT` reads «Valorant» and `javaw`
  «Minecraft». There is no brand block, day line, day strip, «La que más usaste» or «Frente al día anterior». Extends RT-04, RT-11,
  RT-13, RT-19 and RT-23; successor of RT-24. (2026-11-19, «el diseño es muy malo»; «sí»)
- [ ] **RT-30** «Semana» (RT-05) opens on «16 – 22 nov · 32 h 41 min en la computadora» with ‹ and › («Semana anterior»,
  «Semana siguiente») in the same control as «Hoy». Seven rows, Monday to Sunday, each a link to its day with its full figure
  («9 h 52 min») and a bar against the week's longest day; a day not reached is dimmed and reads «—». Each day is floored to whole
  minutes, as its own screen floors it, and the total shown is the sum of those minutes, so the seven figures add up to it.
  Then the week's class bar and legend, the week's apps (the same rows as «Hoy»; an app opens onto its per-day split as small
  bars), Sitios, Proyectos, the one Claude line and, at the foot, «Exportar esta semana». There is no heatmap and no Claude card.
  Successor of RT-26. (2026-11-19)
- [ ] **RT-32** The day's and the week's time are split into ten classes, each written wherever it shows: Programar, IA, Reuniones
  y trabajo, Mensajes, Juegos, Videos y redes, Compras y pagos, Estudio, Sistema, Otras. An app takes its class by its readable
  name; a game is also any `*-Win64-Shipping` process, and `javaw` is Minecraft. A browser's seconds are not one class: they are
  split across the classes of the day's sites (RT-13) in proportion to each site's seconds, a site matching by host with a
  subdomain taking its parent's rule. The browser time no site accounts for counts in Otras. Estudio is the person's own study
  time: a page whose title names studyAid («… · studyAid» or exactly «studyAid», any case) is Estudio whatever its host, so a
  host's seconds split by its pages: the study pages' seconds (at most the host's) go to Estudio and the rest keep the host's
  class. These sites are Estudio: wordbookapp.vercel.app (more specific than `*.vercel.app`, which stays Programar),
  duolingo.com, ankiweb.net, coursera.org, udemy.com, platzi.com, khanacademy.org; the Anki app is too. The class bar of «Hoy», of
  a day and of «Semana» use this split, with pages on both screens; a screen that has sites but no pages falls back to the host's
  class. The browser's own row stays in Apps, drawn in its sites' main class. Extends RT-04, RT-05 and RT-13; successor of RT-28
  and RT-31. (2026-11-19)
- [ ] **RT-33** «Llaves» opens on the key name and «Crear llave», shows a new key once with its command, then lists the keys, then
  one sentence on the Windows installer with its download. «Conectar Claude» is a collapsed section: one sentence and the command
  that adds the MCP server to Claude Code with the key (the key just created, else a placeholder), its copy button on the row of
  what it copies; a key revoked on the screen leaves it at once, with its commands. «Exportar» (RT-25) opens with one sentence;
  what the file holds is a collapsed «Qué trae el archivo». Successor of RT-27. (2026-11-19)

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
- [x] **RT-15** — «Exportar» downloads a CSV with a row per day of a range of up to 366 days: seconds at the computer, in Claude Code, on claude.ai, in the Claude app, Claude's total (the three added) and the top app. The MCP server answers the same rows (`get_daily`), read-only, with the same key. (2026-10-30, «si todos los días se exporta cuánto estuve trabajando en general sería bueno para mis métricas») _Retired 2026-11-08, by the user's delegation. Successor: RT-25 (the CSV stops at today, ends with `uploaded`, and a column for Claude on screen joins Claude's total)._
- [x] **RT-22** — «Hoy» and any day show «Claude» (Claude Code, claude.ai and the Claude app, and «Claude en total» as their sum, then Claude Code's sessions) and «Internet» (the longest sites, each opening onto its pages); an app's row opens onto its longest window titles. «Semana» shows Claude's week total and a bar per day. Sites and pages come from the program on the PC, which reads the focused browser's address bar (Windows) or the browser's own history; never from a browser extension. Where a source never arrived the screen says what to do: update the program on the PC for sites, with a link to its install steps; the Claude folder for Claude Code. Successor of RT-17. (2026-11-01, «solo quiero que todo dependa del programa») _Retired 2026-11-08, by the user's delegation. Successor: RT-24 (Claude on screen apart from Claude Code's work; «actualiza el programa» goes to the latest installer)._
- [x] **RT-24** — «Hoy» and any day show «Claude» as what the person spent in front of it (claude.ai and the Claude app, «Claude en pantalla»; «% del día» counts only that), with Claude Code apart as the agent's own work («Trabajo del agente», its seconds and its sessions, never added to the screen time), and «Internet» (the longest sites, each opening onto its pages); an app's row opens onto its longest window titles. «Semana» shows Claude on screen for the week and a bar per day, and Claude Code's week apart. Sites and pages come from the program on the PC, which reads the focused browser's address bar (Windows) or the browser's own history; never from a browser extension. Where a source never arrived the screen says what to do: update the program on the PC for sites, with a link to the latest installer, the same one «Llaves» downloads; the Claude folder for Claude Code. Successor of RT-22. (2026-11-08) _Retired 2026-11-19, by the user («sí»). Successor: RT-29._
- [x] **RT-26** — «Semana» also shows «Proyectos de la semana» (the VS Code-family workspace folders of RT-23, added over the seven days) and «Internet de la semana» (the longest sites of the week), each with the eight longest and a «y N más» that opens the rest. A card with nothing is absent. On a phone a heatmap cell shows hours over minutes («4h» then «43»), so the minutes are not lost. (2026-11-08) _Retired 2026-11-19, by the user («sí»). Successor: RT-30._
- [x] **RT-27** — «Llaves» has a «Conectar Claude» section: the MCP server's address (`/mcp` on the app's own address), a block to copy that adds it to Claude Code with the key in the `Authorization: Bearer` header (the key just created, else a placeholder), and a line on what to ask. A key revoked on the screen leaves it at once, with its commands. (2026-11-08) _Retired 2026-11-19, by the user («sí»). Successor: RT-33._
- [ ] **RT-28** — The day's time is split into nine classes, each written wherever it shows: Programar, IA, Reuniones y trabajo, Mensajes, Juegos, Videos y redes, Compras y pagos, Sistema, Otras. An app takes its class by its readable name; a game is also any `*-Win64-Shipping` process, and `javaw` is Minecraft. A browser's seconds are not one class: they are split across the classes of the day's sites (RT-13) in proportion to each site's seconds, a site matching by host with a subdomain taking its parent's rule. The browser time no site accounts for counts in Otras. The day's class strip and the week's heatmap use this split; the browser's own row stays in Apps, drawn in its sites' main class. Extends RT-04, RT-05 and RT-13. (2026-11-19, «si se ve bien») _Retired 2026-11-19, by the user («sí»). Successor: RT-32._
- [ ] **RT-31** — A tenth class, Estudio, joins RT-28's nine: the person's own study time. A page whose title names studyAid («… · studyAid» or exactly «studyAid», any case) is Estudio whatever its host, so a host's seconds split by its pages: the study pages' seconds (at most the host's) go to Estudio and the rest keep the host's class. These sites are Estudio: wordbookapp.vercel.app (more specific than `*.vercel.app`, which stays Programar), duolingo.com, ankiweb.net, coursera.org, udemy.com, platzi.com, khanacademy.org; the Anki app is too. The class strip, the legend and the week's heatmap use it, with pages on both screens. A screen that has sites but no pages falls back to the host's class. Extends RT-28. (2026-11-19, «con la nueva studyaid no tiene sentido contarla como programar») _Retired 2026-11-19, by the user («sí»). Successor: RT-32._

---

## 4. Stack

The monorepo's: Next.js 16, React 19, Radix Themes, next-intl, drizzle-orm on Supabase Postgres,
`@repo/supabase-auth`, `mcp-handler`. Nothing else is installed for TimeLog.
