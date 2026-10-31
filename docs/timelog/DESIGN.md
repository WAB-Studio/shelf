# TimeLog — design guide

Governs `apps/timelog` alone. No pattern crosses over from HomeFund, WordBook or GoalLog because it
exists next door.

Written 2026-10-28 for P5. The user has not seen it drawn yet: the first screen built is the first
look, and these words change with what they say.

## The direction: Reloj de arena

Sand that fell. The screen says how much and where, and judges nothing.

- **No goal, no target, no colour for too much.** An hour on a game and an hour on an editor are
  drawn the same length. Ranking is by length alone. Since 2026-10-31 a class (Código, Navegador, Comunicación,
  Ocio, Sistema, Otras) colours the bar: classes describe where the time went, never grade it, and no class is
  louder than another.
- **Dark is the primary face**, as a screen read at the end of a day at the computer. Light is the
  same design inverted.
- **Every duration is set in mono**: `3 h 12 min`, `45 min`, `< 1 min`. A sentence is set in the
  app's sans.
- **One bar per app**, its length the app's share of the longest app that day. The bar is the only
  graphic. No pie, no chart axis, no legend.
- Rows are separated by space, never by a box. No shadow.

## Tokens

- Background `#14120f`, raised `#1d1a16`, text `#efe9df`, muted `#9a9184`, bar `#d9a441` (sand),
  bar track `#2a2620`. Light: background `#f7f3ec`, raised `#efe9df`, text `#1d1a16`, muted
  `#6f675b`, bar `#a8761a`, track `#e4ddd1`.
- Sans: Inter. Mono: JetBrains Mono. Titles: Space Grotesk 700. Sizes 14 (meta), 16 (row), 22 (day total), 36 (title; 44 on the desktop).
- Gutter 16 on the phone, content 720 max on the desktop. A row is 48 tall at least.

## Screens

- **Hoy**: the date as title; the day's total under it in 22 mono; then one row per app: its name,
  its time on the right in mono, the bar under both. «Sin datos de hoy · última subida <hora>»
  when nothing arrived.
- **Semana**: «Del 26 oct al 1 nov» as title, ‹ › beside it; seven rows Monday to Sunday, each with
  its total and a bar against the week's longest day; under them the week's apps as in «Hoy».
- **Llaves**: under the intro, one line on the Windows installer and «Descargar para Windows ›»; a name field and «Crear llave» on top; the new key shown once in mono with «Copiar»
  and the command line that uses it; then the keys as rows (name, «usada <cuándo>», «Revocar»).
- The nav: «Hoy», «Semana», «Llaves», a bar at the foot on the phone, a row above the title on
  the desktop. A day with nothing reads «—».

## Grafito y señal (2026-10-30)

Restyle by the recipe the user took from agendaamiga.com, with TimeLog's own colours: a title face
with character, one accent, one highlight used sparingly, one dark brand block, pill buttons,
tabular figures. It replaces the sand tokens above. Why: a computer's time is read off a
screen, so graphite with electric cyan (instrument panel) and Space Grotesk, a technical
grotesque, instead of warm sand and generic Inter titles. Dark stays the primary face.

- Accent: cyan, on the bars, links and primary buttons. Highlight: the same cyan, tinted, behind the
  day total (see round 2 below). Red is for danger alone. Brand block: «Hoy» title and total in a graphite block with
  radius 20, graphite in both faces.
- Primary buttons are pills. Titles are 36/44 bold, tracking -0.02em. Durations stay mono, tabular.

| Token | Dark | Light | Pair | Ratio |
|---|---|---|---|---|
| `--tl-bg` / `--tl-text` | `#0c0e11` / `#eef2f6` | `#f6f8fa` / `#0e1115` | text on ground | 17.18 / 17.78 |
| `--tl-muted` | `#8f9aa8` | `#566170` | on ground | 6.77 / 5.91 |
| `--tl-bar` | `#22d3ee` | `#00687a` | on ground | 10.69 / 6.05 |
| `--tl-bar` | | | on raised (`#151a20` / `#e8edf2`) | ≥ 9.07 / 5.47 |
| `--tl-block` / `--tl-block-text` | `#232c37` / `#f2f6fa` | `#0e1115` / `#f2f6fa` | text on block | 13.01 / 17.43 |
| `--tl-block` | | | block on ground | 1.37 dark (so it carries a border) |
| `--tl-block-edge` | `#5d6b7d` | `#0e1115` | border on ground | 3.56 |
| `--tl-block-muted` | `#b4c0ce` | `#b4c0ce` | on block | 7.65 / 10.25 |
| `--tl-raised-on-block` | `#2f3b49` | `#1f2630` | text on card / muted on card | 10.49 and 6.17 / 14.03 and 8.25 |
| `--tl-bar-on-block` | `#22d3ee` | `#22d3ee` | on block / on card | 7.82 and 6.31 / 10.47 and 8.43 |
| `--tl-mark` / `--tl-mark-edge` | `#234754` / `#22d3ee` | `#113038` / `#22d3ee` | block text on the tint / edge on the tint | 9.21 and 5.53 / 12.86 and 7.73 |
| `--tl-danger` / `--tl-danger-ink` | `#ff4d42` / `#0e1115` | same | ink on the solid red («Sí, revocar») | 5.76 |
| `--tl-danger-text` | `#ff4d42` | `#b3261e` | «Revocar» as text on ground / on raised | 5.88 and 5.32 / 6.14 and 5.55 |

Revised 2026-10-30 after the critic: the «Hoy» block is built around the day total (64/72 mono, signal
red behind it, the date a 14 line, two cards: the top app and the gap to yesterday); «Semana» has a
block with the week total and seven vertical day columns (a day not reached is dashed and dimmed), the
top three apps large and the rest compact; every screen shares a header (logo mark, «TimeLog», sections
as pills); app names read without «.exe», system hosts grouped as «Sistema».

## Round 2 (2026-10-30)

The second critique, from the screens at 820, 1440 and 1920:

- **Width.** «Hoy», a day and «Semana» open the page to 1200 (`Page wide`). From 1100 a grid
  `minmax(340px, 400px) 1fr`: the brand block sticky on the left (top 24), the bar rows on the right.
  From 720 to 1099 the block sits on top at full width and the rows run in two columns. Below 720
  one column as before. «Llaves» stays one 720 column.
- **The total is not an alarm.** It sat on solid signal red, the colour of «Sí, revocar». It is now cyan at
  16% over the block with a 1px cyan border (`--tl-mark`, `--tl-mark-edge`); red is kept for danger. «Revocar»
  is red text with no fill; «Sí, revocar» is the solid red.
- **Week figures** are 14 and carry their unit («12 h», «45 min»), never «12:59», which reads as a clock;
  the exact time stays in the bar's label. The largest unit alone, floored.
- **«Frente al día anterior»** shows on past days only: an upload carries a day's total, so today so
  far cannot be set against yesterday up to the same hour.
- **Brand on every surface**: `icon.svg`, `icon` (PNG), `favicon.ico`, `apple-icon`, `opengraph-image`, the
  three cyan bars on graphite. Each page titles itself («Hoy», «Martes 27 oct», «Del 26 oct al 1 nov», «Llaves»).
- **Words**: «Entrar» says access is by invitation; an empty day says why it reads 0 and what to do.

## Claude and Internet (2026-10-30)

Same system, no new element. In «Hoy» and any day the main column reads Apps, then Claude, then
Internet; the brand block gains a third card, «Claude en total». «Claude» is a line of
`Claude en total` and its time over up to three bars (Claude Code, claude.ai, App de Claude, the last
only when it exists) and one line saying the three are added as they are. «Internet» is the eight
longest hostnames as bars, «y N sitios más», and a line saying only the site is kept. A source that never
arrived says so in a sentence and how to connect it, never a flat zero. «Semana» adds a card
«Claude en la semana» in its block and, under the apps, «Claude por día»: seven bars and «Exportar esta
semana». «Exportar» is a narrow screen like «Llaves»: two dates, a pill and three shortcuts.

Details (2026-10-30, after «rastree todo más detallado»): a row that has a detail opens onto it, the native
disclosure (a `›` before the row that turns when open, the detail indented under a 2px rail, no script). An app
row opens onto its longest window titles as compact bars; a site opens onto its pages, each a compact bar named by
the page title with its address under it in the meta line. «Claude» ends with «Sesiones de Claude Code»: bars
named by project, the span «9:12 a. m. – 10:40 a. m.» under each. The privacy line under «Internet» says only the
person sees it and that the exclusion list never leaves the PC.

## Round 3 (2026-10-31)

The third critique («Creo que podemos mejorar más, ¿no?»), from `private/reportes/timelog-ronda3.md`.

**Decisión del 2026-10-31** (the critic's picks; the user may override any):

- **P1.** The hourly line uses Claude Code sessions alone, the only thing that carries a time of day. No contract
  change; the apps get no «when» (RT-16).
- **P2.** Neutral classes with fixed colours: Código (cyan), Navegador (blue), Comunicación (violet), Ocio (pink),
  Sistema (slate), Otras (sand). Claude keeps its own orange, in three shades for Claude Code, claude.ai and the app.
  The class is always written (legend, row names, cell figures), never colour alone. This replaces «judges nothing» as
  «classes describe, never grade».
- **P3.** When more than one device uploaded a day, the block names its total as a sum and lists each device's total.
- **P4.** «Exportar» lives inside «Semana» (a link under the heatmap; `/exportar` keeps its address and marks
  «Semana» current): three tabs, «Hoy», «Semana», «Llaves».

What changed:

- **Mosaic.** Every app screen opens to 1200 so the header never moves; «Llaves» and «Exportar» keep a 720 column
  inside it. «Hoy» and a day: the brand block on top and wide (total and devices; Claude at a glance; the day by
  class; the top app and the gap to yesterday), then three cards, Apps, Claude, Internet (radius 20, raised ground, no
  shadow: a card is the one box allowed, since a screen at 1440 has to hold three columns). Cards are one column
  below 720, two to 1099 (Apps on a whole row), three from 1100.
- **Titles.** A section is a title in the display face (24) with its total at the right.
- **One scale.** A top-level list is measured against its own longest row; a child (a window, a page, a session, a
  Claude source) against its parent's time. Apps show eight, then «y N apps más · X» opens the rest.
- **Day line.** Claude Code's sessions as labelled segments from 6:00 to 24:00 (from the hour of the first session if
  earlier), on lanes where they overlap, an hour ruler every three hours. On the phone it scrolls and opens at the hour
  now; on a past day at its first session.
- **Class colours.** Every class is a token pair (on the ground, on the block) in `theme.css`, with its contrast.
- **Day strip.** L M M J V S D with the day number, the month named («26 oct – 1 nov»), the day shown filled, days
  with no screen dimmed, ‹ › to the same weekday a week away. It replaces «Día anterior» and «Día siguiente».
- **Semana.** The block holds the total, the seven day columns and Claude's week. Under it one card: a heatmap of
  seven days by the top eight apps, each cell with its figure (level 1 to 4 only tints it), then «y N apps más». It
  replaces the list of apps and the bars of «Claude por día».
- **Phone.** The bottom bar has a border and a shadow and a 16 gutter; the figures of the seven columns break into
  value over unit so two never read as one; first use shows only the connect button; «Actualizado hace…» re-reads
  today every minute and when the tab comes back.

## Critic's pass on the deploy (2026-10-31)

- Zero is «0 min», never «< 1 min». The day strip dashes and strikes a reached day nothing arrived on. A past day with nothing
  shows its own sentence and no empty Claude and Internet cards. «Hoy» is current on today alone.
- Day line: one colour per project (six tokens, `--tl-project-*`), the label beside a segment too short for it, the ruler on
  the same 12-hour clock as the spans. The Claude desktop app draws in Claude's orange everywhere.
- Every «y N más» (apps, windows, sites, pages) opens. Every cut text carries a `title`.
- The CSV stops at today and ends with `uploaded` (1 or 0), so a day unseen is told from a real zero.
