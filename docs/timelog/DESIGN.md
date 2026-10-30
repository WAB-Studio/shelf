# TimeLog — design guide

Governs `apps/timelog` alone. No pattern crosses over from HomeFund, WordBook or GoalLog because it
exists next door.

Written 2026-10-28 for P5. The user has not seen it drawn yet: the first screen built is the first
look, and these words change with what they say.

## The direction: Reloj de arena

Sand that fell. The screen says how much and where, and judges nothing.

- **No goal, no target, no colour for too much.** An hour on a game and an hour on an editor are
  drawn the same. Ranking is by length alone.
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
- Sans: Inter. Mono: JetBrains Mono. Sizes 14 (meta), 16 (row), 22 (day total), 28 (title).
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
