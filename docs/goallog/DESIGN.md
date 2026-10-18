# Goal log — design guide

Governs `apps/goallog` alone. `docs/DESIGN.md` governs `apps/homefund` and `docs/wordbook/DESIGN.md`
governs `apps/wordbook`; neither applies here and no pattern crosses over because it exists next door.

Approved by the user 2026-09-22 from the canvas
<https://claude.ai/artifact/5ZNtobfQDzeBNFcEMs38Qp>.

## The direction: Bitácora

A ship's log: what happened, when, and who wrote it down.

- **The design has no colour for failure.** A commitment done is the accent; one not done is an
  empty outline. No red anywhere, no broken streak, no badge, no praise. Decided by the user
  2026-09-22. A palette with no red is what enforces it — a later screen cannot reach for one.
- **Light is the primary face.** Dark is the same design inverted, never a second design.
  `apps/wordbook` is dark-first; this app inherits nothing from it.
- **A figure is set in mono, a sentence in Archivo.** Hours, counts, minutes, dates and quantities
  are the log's substance: they read as a log or they read as decoration.
- **Writing a fact costs one tap.** No form stands on the day's path. What needs a number offers it
  already filled.
- Rule between rows with a hairline. Never a card, never a border box.
- **No shadow anywhere.** Not on a sheet, not on a button, not on a field. Separation is a hairline,
  a change of fill, or the scrim — never a blur. Checked 2026-09-22 against all seventeen boards:
  they draw **zero**. A library that paints one is painting a decision this design did not take.

## Tokens

Light, the primary:

| role | value |
|---|---|
| ground | `#EDEFF2` |
| raised (a sheet, a field, the tab bar) | `#FFFFFF` |
| line | `#DCE1E7` |
| border | `#C7CED7` |
| ink | `#12171C` |
| ink, secondary | `#333C45` |
| muted | `#5E6874` |
| quiet (strokes and decoration only) | `#8A939E` |
| accent | `#1C6E5A` |
| accent, soft (the evidence mark's fill) | `#DCEAE5` |
| today (Semana's today column from 1024; the phone keeps `raised`) | `#E3E8EE` |
| scrim (behind a sheet) | `rgba(18, 23, 28, 0.34)` |

Dark, the same design inverted:

| role | value |
|---|---|
| ground | `#0F1317` |
| raised | `#161B20` |
| line | `#222930` |
| border | `#2B333B` |
| ink | `#E7ECF1` |
| ink, secondary | `#C3CBD3` |
| muted | `#949EA9` |
| quiet | `#5C666F` |
| accent | `#4FBEA0` |
| accent, soft | `#17332C` |
| today | `#1E252C` |
| scrim | `rgba(5, 7, 9, 0.62)` |

- The scrim is darker than the dark ground on purpose: a sheet is `raised`, and it has to lift off
  what is behind it on both faces. Taken 2026-09-22, when the only scrim in the app was a library's
  black alpha that no table held.
- **The theme root speaks these tokens.** Radix paints its own ground and ink on `.radix-themes`;
  both are overridden there. A surface that is not a `Page` would otherwise show a colour this table
  never chose — the same way it showed the system font before the family moved here.
- The accent is a different hex per face, not one colour at two opacities. `#1C6E5A` has too little
  contrast on the dark ground; `#4FBEA0` has too little on the light one.
- **muted is the smallest text colour there is.** `quiet` never carries a word a person must read:
  it draws strokes and empty marks. The unit beside a figure, in a `Figure` or a table cell or header,
  is muted on both faces: in quiet it read 2.96:1 dark and 3.11:1 light. Decided by the user 2026-10-11.
- Text on the accent is `#FFFFFF` on the light face and `#0F1317` on the dark one.

## Type

- Sentences, headings, commitment names and controls: **Archivo**, fallback `system-ui, sans-serif`.
- Every figure: **DM Mono**, fallback `ui-monospace, monospace`, `letter-spacing: 0.02em`.
- Set a section label at 11 px, mono, uppercase, `letter-spacing: 0.14em`, in **muted**. It names a
  goal or a group, never a state.
- Set a screen title at 27 px / 600 / `-0.02em` on the phone, 38–44 px / 600–700 / `-0.03em` wide.
- Set a commitment name at 16 px / 500. Its metadata line is mono 12 in muted.
- Set the measure at 26 px mono / 500, with its unit beside it at mono 11 in muted.
- Set a sheet's title at 21 px / 600 / `-0.02em`, and the line under it at 15 px / 1.6 in ink
  secondary. Both are what `HoyCantidad.dc.html` and `CompromisoRetirar.dc.html` already draw;
  written down 2026-09-22, when a primitive reached for 19 px and 14 px because no role here
  claimed them.
- Every size in this table is a `--pulsar-text-*` token in `app/theme.css`, the sheet's pair
  included. A size that lives as a literal inside one component is a size the next component will
  guess differently.
- **There is no role at 24 px and none at 14 px.** A component that needs one is a component
  reaching past this table; give it the nearest role or bring the decision here first.

## The marks

Four states, one shape — a 24 px circle at the head of the row:

| state | mark |
|---|---|
| done, declared | filled accent, a `#FFFFFF` check inside (`#0F1317` on dark) |
| done, by evidence | accent-soft fill, 1.5 px accent border, an accent check |
| done in part | 1.5 px accent border, the lower half filled accent, no check — a quantity logged under its target; it does not count as done |
| not done | 1.5 px border, nothing inside |

- The two done marks differ so a day marked by another app never reads as one the person said they
  did (RP-09). The difference is fill, never hue: a second hue would be a second accent.
- A row is a real `<button>`, never a div. Minimum 56 px tall; every other control minimum 48 px.
- Radius: 10 px on a control or a field, 16 px on the top corners of a sheet.

## The controls

Two variants, and no third until a board draws one:

| variant | fill | border | ink |
|---|---|---|---|
| solid — the act the screen is for | accent | none | `#FFFFFF` light, `#0F1317` dark |
| outline — the way out of it | transparent | 1.5 px `border` | ink |
| ghost — an icon alone, no frame | transparent | none | muted |

- `ghost` is what the day's theme control is drawn with: a 44 px glyph and nothing around it. Added
  to this table 2026-09-22 rather than left as a variant the code had and the design did not name.

- `CompromisoRetirar.dc.html` draws both, one above the other: «Retirarlo» solid, «Dejarlo como
  está» outline. That is the pair, and the outline's border is the `border` token, never a tint of
  the accent.
- **Disabled drops the fill, in every variant**: muted ink on the ground with a `line` ring. It never
  changes hue and never goes grey from somewhere else.
  - **Corrected 2026-09-22, the day it was written.** The first wording said «muted ink over the
    same fill», which on a solid control measures **1.08:1** light and **1.19:1** dark — unreadable.
    Dropping the fill measures 4.92 and 6.86. The rule was wrong, not the code that obeyed it; it
    was caught by measuring a rule nobody had drawn on a board.
- A variant the design has not dressed is not reachable: the primitive's own type offers these and
  no others. An undressed variant behind a legal prop is the same gap as an undressed export — it
  just takes one more keystroke to reach. Settled 2026-09-22, after `variant="outline"` was measured
  painting a library's teal.

## The boards

On the canvas, in six pages. A module that draws a screen cites its board by name.

| board | what it holds |
|---|---|
| `Main.dc.html` | the direction, both palettes and the type scale |
| `Hoy.dc.html` | the day with work left, one goal |
| `HoyVarias.dc.html` | two goals open and two one-offs that belong to none — the general case |
| `HoyOscuro.dc.html` | the same day on the dark face |
| `HoyCantidad.dc.html` | the sheet that takes a quantity and its optional line (RP-03, RP-04) |
| `HoyCompleto.dc.html` | every commitment satisfied, with no congratulation |
| `HoyVacio.dc.html` | no goal open yet |
| `HoyCargando.dc.html` | the day while it loads |
| `HoySinEvidencia.dc.html` | a source that could not be read (RNP-04) |
| `Semana.dc.html` | the week with its gaps (RP-16) |
| `Revision.dc.html` | the measure week by week, on the phone (RP-17) |
| `RevisionEscritorio.dc.html` | the same table wide |
| `Meta.dc.html` | a goal's commitments, cadences and phases |
| `MetaNueva.dc.html` | the least it takes to open a goal |
| `CompromisoNuevo.dc.html` | adding a commitment: what it is, how often, what satisfies it (RP-12) |
| `CompromisoRetirar.dc.html` | the sheet that retires one, saying what it leaves intact (RP-13) |
| `SueltaBorrar.dc.html` | deleting a one-off, and how it differs from finishing one (RP-22) |
| `Entrar.dc.html` | the link sent to an address (RP-18) |

### Page «El plan»

Drawn 2026-09-30, approved by the user the same day in their own words: «Apruebo los 21». Example
throughout: the 2026–2027 roadmap, goal «IA aplicada». Export (PDF) and import (IA) are drawn apart.

| board | what it holds |
|---|---|
| `MetaMes.dc.html` | the goal's «este mes»: reached of planned, the month's name, «Ver por mes» (RP-28, RP-36) |
| `MetaMesSinPlan.dc.html` | a measure and no amount this month: the reached figure and the way to plan it |
| `MetaMesBajo.dc.html` | day ≥ 20 and under 60 %: figures, the day and «60 %», in ink, never alarm (RP-29) |

- **Decided by the user 2026-10-06:** the pace line names no percentage of its own. It reads the day, reached of planned and «bajo el 60 %» — «día 21 · 5 h 24 min de 12 h, bajo el 60 %». A percentage of reached reads as a score (RP-29). The boards `MetaMesBajo` and `HoyMesBajo` still draw it; this line wins.
- **Decided by the user 2026-10-06:** a goal's one-off takes its estimate where it is planned — Mes and the month's task form, or a connected AI. Hoy's «Escribe algo suelto de…» stays one field (RP-30).
| `MetaMesSinEvidencia.dc.html` | the source unreadable: the month line is the declared half, and says so (RNP-04) |
| `HoyMes.dc.html` | Hoy on the phone: an «este mes» block, one line per goal with an amount this month |
| `HoyMesBajo.dc.html` | the same, the 22nd, one goal under 60 % |
| `HoyHoras.dc.html` | rows in a time unit read «1 h 30 min», «45 min de 1 h 30 min» (RP-35) |
| `CantidadHoras.dc.html` | the quantity chips in hours and minutes, wrapped at 360; the own field still in minutes |
| `RevisionHoras.dc.html` | the review table and the goal's figure in hours and minutes, no unit word per cell |
| `Meses.dc.html` | a goal's months: closed with reached, planned and share carried; «en curso»; future amounts (RP-32) |
| `MesesVacio.dc.html` | no amount in any month |
| `MesPlan.dc.html` | the amount sheet: hours and minutes as two whole fields for a time unit, one field otherwise, its refusals |
| `Mes.dc.html` | one month: tasks with their time, a parent as the sum of its sub-tasks, done ones (RP-30) |
| `MesArrastre.dc.html` | carried tasks first, «de octubre · debe 3 h», then the month's own (RP-31) |
| `MesVacio.dc.html` | a month with an amount and no task |
| `MesCerrado.dc.html` | a closed month: the share carried; what is owed reads in the next month |
| `MesCorrer.dc.html` | over half carried, during the month after: the proposal to shift the plan (RP-34) |
| `MesCorrerHoja.dc.html` | the shift sheet: what moves, what stays, what the next month keeps, one confirm |
| `TareaNueva.dc.html` | a new task: name, time in hours and minutes, month preset, «con sub-tareas» |
| `SubtareaNueva.dc.html` | a sub-task under a named parent; one level only |
| `TareaSinMedida.dc.html` | a goal that measures nothing: no time field, and why in one line |
| `MesSubtarea.dc.html` | the way into a sub-task: a row «Otra sub-tarea» closing each parent's children, indented as they are, dashed circle; open months only. Chosen 2026-10-01 by the coordinator, the user having left it to them |

### Page «Exportar»

Drawn 2026-09-30, approved by the user the same day: «Apruebo los 5».

| board | what it holds |
|---|---|
| `Exportar.dc.html` | `/metas` gains «el plan»: «Exportar» (absent with no goal open) and «Importar un plan» (always) |
| `Reporte.dc.html` | `/exportar` on the phone: per goal this month, to date, phases, carried, months, weeks; «Descargar PDF» (RP-33) |
| `ReporteImpreso.dc.html` | the same page printed on A4: no nav, no button, black on white, «pulsar» and the date in the head |
| `ReporteSinEvidencia.dc.html` | the source unreadable: one line at the top, each figure from it says «solo lo que dijiste tú» |
| `ReporteVacio.dc.html` | no goal open: one line and the way back |
| `ReporteMarco.dc.html`, `ReporteMarcoEscritorio.dc.html` | `/exportar` inside the shell, built 2026-10-05 (module 217): the header with «Metas» as its way back, tabs and rail around it with Metas current; each goal's name an `h2`, with a 2px ink rule over it on the phone; from 1024 the goals are cards in two columns (three were dropped 2026-10-06, see «Decisions of 2026-10-06») and «Descargar PDF» sits beside the title. The printed page is unchanged: no nav, no back |

### Page «Importar»

Drawn 2026-09-30, approved by the user the same day: «Apruebo los 10».

| board | what it holds |
|---|---|
| `Importar.dc.html` | paste or upload, the privacy line before sending, the template shown and copied, «Leer el plan» (RP-37) |
| `ImportarLeyendo.dc.html` | sent: the text stays, dimmed; the button busy; «Puede tardar un minuto.» |
| `ImportarRevisar.dc.html` | the proposal by goal, everything marked; unmark, change an amount in hours and minutes, «Crear N metas» |
| `ImportarRevisarAvisos.dc.html` | what cannot be written, on top, unmarked and not markable, each with why |
| `ImportarPlantillaError.dc.html` | the template broken at one line: its number, the line, what was expected |
| `ImportarVacio.dc.html` | the model found nothing; the text stays |
| `ImportarFallo.dc.html` | the model failed; the text stays; «Intentar otra vez» |
| `ImportarSinClave.dc.html` | no key: the AI read is not available, the upload is off, the template still reads (RNP-13) |
| `ImportarTope.dc.html` | ten AI reads today: tomorrow again; the template still reads |
| `ImportarFormato.dc.html` | a file over 4 MB or of a kind not read: paste its text |

- **The import in three steps is approved** (RP-86–RP-90, RP-95–RP-98), 2026-10-12, by the user: «Apruebo todos». Page
  «Importar», row «La importación en tres pasos»: `ImportarEntrada`, `ImportarPasos` (1–3), `ImportarArbol` (1 at 360 and
  1280, 2 a PDF, 3 notes open), `ImportarCorreccion` (1–2), `ImportarCambiar`, `ImportarFuera`, `ImportarNadaQueCrear`,
  `ImportarCreando`, `ImportarCrearFallo`, `ImportarExcelFilas`, `ImportarExcelAjeno`. Words and structure:
  `private/tableros-importacion/NOTAS.md` «# Importación». `ImportarLeyendo`, `ImportarRevisar`, `ImportarRevisarAvisos`
  and `ImportarRevisarNota` are superseded and go to «Archivo»; `ImportarVacio`, `ImportarFallo`, `ImportarSinClave`,
  `ImportarTope`, `ImportarFormato` and `ImportarPlantillaError` stay.
- **A part's name, amount or month changes from the button at the row's end**: its amount, or a pencil when it has none.
  It opens one sheet with only the fields that part has. Decided by the user 2026-10-12.
- **A correction nobody touches counts as accepted — on the model's read only; from the template it starts declined (RP-122, 2026-10-14).** The tree shows it applied; «Aceptar» confirms it, «Dejar como
  estaba» undoes it, and «Crear» never waits on one. Decided by the user 2026-10-12.
- **A goal that holds goals keeps the plan's phases; a plan's weeks are tasks with their sub-tasks.** Decided by the user
  2026-10-12.
- **The review tree needs primitive variants**: `CheckRow` gains `depth` (0–4, 16 px a level), `below` and `foldedNote`;
  `Fold` gains `depth`.
- **Boards that do not exist for the import**: the dark face (the token table's); 1280 except the tree (the 640 column does
  not change); a workbook's count in rows; the «nota llena» line (it reads as one more «Sin lugar en el plan» row).
- **The upload hint reads «PDF, texto o imagen · hasta 4 MB», without «Word».** The boards say «PDF, Word, texto o
  imagen»; the model's file part takes PDF alone and a `.docx` answers `unreadableType` (module 151). Decided by the
  coordinator 2026-10-01: the hint never promises a kind the route refuses.

### Notes on tasks (RP-45)

Drawn 2026-10-05 on the pages they belong to, approved by the user the same day: «Aprobados así».

| board | what it holds |
|---|---|
| `TareaNota.dc.html` | the note's sheet, empty: eyebrow «nota · <goal> · <month>», the task's name, a labelled text area, «Guardar», «Cancelar» |
| `TareaNotaEscribiendo.dc.html` | an existing note being edited: line breaks kept, the count from 1800 («1 850 de 2000»), «Guardando…» busy, «quitar la nota» |
| `TareaNotaGuardada.dc.html` | a month's list with noted tasks: up to two lines of the note under the name, clipped; the note button green with lines |
| `TareaNotaHecha.dc.html` | a done task keeps its note and its button; the row's tap still undoes |
| `TareaNotaFallo.dc.html` | the save failed: the sheet stays, the text stays, one line says so |
| `TareaNotaLarga.dc.html` | over 2000: the ring and the count turn ink, the line says how much fits, nothing is cut |
| `TareaNotaVaciar.dc.html` | after «quitar la nota»: the row as before, the button grey |
| `HoyNota.dc.html` | Hoy: the note button on each one-off, pending or done, never the text |
| `SueltasNota.dc.html` | `/sueltas`: up to two lines of the note under the name and its date |
| `ImportarRevisarNota.dc.html` | the review shows a template task's and sub-task's note whole, read-only |
| `ReporteNota.dc.html` | `/exportar`: the note whole under a carried task and its sub-task, set off by a thin left rule |
| `ReporteImpresoNota.dc.html` | the same on A4 at 12 pt; a long note breaks across pages, never cut |

### The critic's cut of trains 6 and 7 (RP-16, RP-46, RP-47)

Drawn 2026-10-06 on the pages they belong to, approved by the user the same day: «confirma los diseños, me da igual».

| board | what it holds |
|---|---|
| `HoyEnParte.dc.html` | Hoy: «1 de 3 min · 09:22 · lo dijiste tú» under the half-filled mark, beside a done and an empty row |
| `HoyCuentaEnParte.dc.html` | the count with a partial row: «hechos 2 de 5 · 1 en parte»; the partial never adds to «hechos» |
| `HoyTelefonoSinPedido.dc.html` | phone: a goal that asks nothing today has no section; its «este mes» line stays; asking goals first, in plan order |
| `HoyTareaMesSubtarea.dc.html` | the next month task is a sub-task: «de <parent>» above its name; the estimate on one line |
| `DiaPasadoEnParte.dc.html` | a past day with a partial row, the same mark as Hoy |
| `DiaPasadoPasos.dc.html` | a past day: «‹ día anterior», «día siguiente ›», «volver a hoy»; the date is the title; no empty goal section; «Ese día no pedía nada» when nothing asked |
| `SemanaEnParte.dc.html` | the phone week: a half dot; the footer «hechos 4 de 6 · 1 en parte»; the desktop cell takes the same half dot |
| `ReporteTareas.dc.html` | `/exportar` phone: «4 metas · 1 terminada»; «este mes · octubre» on the first figure; «tareas de octubre» — carried first, then the month's own, done and not, sub-tasks indented, notes under every task; every date with its year |
| `ReporteMesesSemanas.dc.html` | the months table with each week folded under the month of its Monday, indented and muted, spans with year |
| `ReporteImpresoTareas.dc.html` | the same on A4 |
| `ReporteMarcoEscritorio.dc.html` | redrawn at 1440: three columns beside the rail, the ended goal last with its date |
| `ReporteMarcoEscritorio1024.dc.html` | at 1024: two columns; the column count follows the width the rail leaves; no overflow |
| `ConexionesRevocar.dc.html` | «Revocar» opens a sheet: «¿Revocar «<key>»?», «Deja de funcionar en este momento. La IA que la usa ya no podrá leer ni anotar nada. No se puede deshacer.»; «Revocar» solid, «Dejarla» outline; an unused key reads «creada … · sin usar» |

## The boards that do not exist

Say what is missing, so a gap nobody drew reads as a gap nobody needed.

- **Modules 720, 721 and 723.** Built without a board (decided 2026-10-09 by the orchestrator); the user reviews them
  at the end.
- **Dark beyond `HoyOscuro.dc.html`.** Every other state is this design with the dark column of the
  token table. Drawing it again repeats a decision instead of taking one. Decided by the user
  2026-09-10, for every app.
- **The goals list (`/metas` with more than one goal).** Its own way in reuses `commitment-list.tsx`'s
  block-button pattern; no board draws the list itself. Decided 2026-09-27 by the coordinator, the
  user having delegated it.
- **The empty week.** No board draws a week with no goal open; it reuses the empty day's own shape
  and sentence, never a state of its own. Decided 2026-09-27 by the coordinator, the user having
  delegated it.
- **Writing a fact for a day already past (RP-06).** Not drawn.
- **The moment a phase ends (RP-15)** and the review's own act — recording the answer again. Not drawn.
- **A read-only field.** No board shows one; "Decisions taken here" says what it looks like anyway,
  because the kit needed the answer before any screen asked for it.
- **The goal's entry to a new commitment.** Decided under "Decisions taken here", built, not drawn
  on `Meta.dc.html`.
- **`Fase nueva`** (RP-15). Decided under "Decisions taken here", built in `CompromisoNuevo.dc.html`'s
  own shape, not drawn on any board. Decided 2026-09-27 by the coordinator, the user having
  delegated it.
- **«Escribir otra cantidad», typed.** `HoyCantidad.dc.html` draws the chips alone; the typed field
  the tap on that button opens — the exception this design already allows — is built and not drawn.
- **A done row with its note.** No board draws a commitment's second and third lines once it is
  satisfied — what was logged, and the note under it. "Decisions taken here" says what they read.
- **Renombrar.** No board draws the rename sheet; "Decisions taken here" says it takes the retire
  sheet's own shape, with a field. Decided 2026-09-27 by the coordinator, the user having delegated
  it.
- **Hoy with every goal ended, at 1024 and wider.** `HoyTodasTerminadas.dc.html` draws the phone
  face only. At 1024 the message and its two buttons sit in the left column inside a `Panel`, the
  buttons stacked as on the phone; goalless one-offs and «hechas hoy» keep the right column.
  Decided 2026-09-29 by the coordinator.
- **Archivar.** No board draws the archive sheet, the outlined block that opens it, or the solid
  «Reabrir» that replaces it once a goal is archived; "Decisions taken here" says all three. Decided
  2026-09-27 by the coordinator, the user having delegated it.
- **Metas archivadas.** No board draws `/metas`'s own «Archivadas» section; "Decisions taken here"
  says it reuses the list's own block-button pattern, under a second `SectionLabel`. Decided
  2026-09-27 by the coordinator, the user having delegated it.

- **Module 67's bound.** It changes the words of an error the form already shows, and nothing else.
- **`/sueltas` loading and failure.** They reuse `app/(app)/loading.tsx` (`HoyCargando.dc.html`) and
  `Fallo.dc.html`; the list has no state of its own there.
- **A past day with a goal opened later.** It is `DiaPasado.dc.html` with one goal fewer; drawing it
  again would repeat the board.
- **The desktop face of the slice «escritorio»'s new states.** `/sueltas` and `/metas` sit as one
  column in the desktop frame; the ended goal is `MetaEscritorio.dc.html` with
  `MetaTerminada.dc.html`'s differences. Drawing them again repeats two boards.
- **The whole done row undoing.** It changes no pixel: the row draws as `HoyHechas.dc.html` draws it.
- **Copy-only fixes of the slice «escritorio»** — «1 semana», the month on a far date, a goal's name as
  written, each goal's field naming its goal, «N esperan», the horizon sheet's label. They change words
  where the boards already draw them.
- **`/sueltas` with one group only.** It is `SueltasProgramadas.dc.html` with a group fewer.
- **`HoyEscritorioMes`.** At 1024 the aside card gains the month line under «esta semana» and keeps
  its shape; `HoyMes.dc.html`'s note says so. Approved 2026-09-30 by the user.
- **`MesesEscritorio`.** The months table sits in the 640 px column without widening; `Meses.dc.html`'s
  note says so. Approved 2026-09-30 by the user.
- **`MesCargando`.** The plan's routes sit under `app/(app)/`: `HoyCargando.dc.html` and `Fallo.dc.html`
  cover loading and failure. Approved 2026-09-30 by the user.
- **A month of an ended or archived goal.** It reads and takes no task and no amount, as
  `MetaTerminada.dc.html` already does for commitments and phases; the layout does not change.
- **The export and the import at 1280.** `/metas` and the review sit in the 640 px column; the layout
  does not change. `/exportar` no longer does: built 2026-10-05 (module 217) it takes the width the
  rail leaves, as `ReporteMarcoEscritorio.dc.html` draws. Approved 2026-09-30 by the user.
- **`/metas` after «Crear N metas».** It is the list `Exportar.dc.html` draws, with the new goals.
- **A template read.** It is `ImportarRevisar.dc.html` with «leído con la plantilla, sin IA» in place of
  «leído por OpenAI».
- **Notes on tasks: dark, the desktop dialog, the create forms.** Dark is the token table's; from 1024 the note's sheet
  is the centred dialog every sheet already is; `TareaNueva` and the AI's paths draw nothing new. Decided 2026-10-05 by
  the coordinator with the boards' approval.

- **The critic's cut: what draws no new board.** Evidence below its threshold stays `empty`: there is no partial for a
  source. The page titles, the Mes link, the 360 controls, «sin monto», the row alignment, the `/metas` plan rows and
  «nov–nov» each match the board they already had. Dark is the token table's; the desktop dialog is unchanged. Decided
  2026-10-06 by the coordinator with the boards' approval.

## Decisions taken here

- **The light/dark control sits in the day's header** (RNP-08), a 44 px icon button at the top
  right. No `/cuenta` screen exists in this app. Taken by the user 2026-09-22; drawn on
  `Hoy.dc.html`, `HoyOscuro.dc.html` and every other day board the same day.
- **A one-off is written in a field at the foot of the day** (RP-19), permanently visible under the
  day's one-offs: type and it lands. No sheet and no screen of its own. Taken by the user
  2026-09-22; drawn on `Hoy.dc.html` and `HoyVarias.dc.html`. The empty mark beside it is dashed,
  the only dashed stroke in the design, because it is the one row nothing has written yet.
- **A goal is opened with a name and a horizon, nothing more** (RP-11). The measure and its unit are set later,
  with the first commitment that measures something. Taken by the user 2026-09-22, and
  `MetaNueva.dc.html` redrawn the same day: it had a third field for the measure and now has two.
- **The day is `America/Bogota`** (RNP-06), one constant in one file, not a column and not the
  browser's zone. Taken by the user 2026-09-22.
- **The day holds every open goal at once, grouped, with no selector**, and the one-offs sit below
  the last goal. With four goals the person scrolls. Taken by the user 2026-09-22;
  `HoyVarias.dc.html` is the board that shows it.
- **The theme control is binary** (RNP-08). It offers light and dark; «system» is the state before a
  choice is made, never a third thing the control cycles to. Settled 2026-09-22 against a control
  that cycled three ways.
- **The tap floor is 48 px, with two named exceptions**: the mark, 24 px inside its 56 px row, and
  the theme control at 44. Both clear RNP-07's 32.
- **Superseded 2026-10-06 by the user: a field's label is Archivo 13, not mono caps** (see «Decisions of 2026-10-06,
  after the UX review»). Was: **a field's label takes the section label's type** — 11 px mono, uppercase, 0.14 em, muted — and
  has no type of its own. It is what `MetaNueva.dc.html`, `HoyCantidad.dc.html` and
  `CompromisoNuevo.dc.html` already draw; written down 2026-09-22 so it reads as a decision rather
  than a coincidence.
- **A quantity is offered as chips, not typed** (RP-03). `HoyCantidad.dc.html` draws four, with the
  number the plan expects already selected. Typing a number is the exception, not the path.
- **Deleting a one-off reuses the retire sheet** (RP-22). No swipe and no ×: this app has neither,
  and a gesture invented for one row is a gesture nobody finds. The sheet's sentence carries the
  only thing anyone hesitates over — done leaves a record, deleted leaves nothing. Drawn
  2026-09-22 on `SueltaBorrar.dc.html`.
- **A cadence is chosen with chips, not a menu** (RP-12). «días sueltos» opens a row of seven day
  toggles; the other three cadences replace that row with one number. Drawn 2026-09-22 on
  `CompromisoNuevo.dc.html`, which unblocks the commitment act.
- **Retiring says what it does not do** (RP-13). The sheet's sentence is about what survives — the
  weeks already governed, the days already done — because that is the only thing anyone hesitates
  over. Drawn 2026-09-22 on `CompromisoRetirar.dc.html`.
- **How much evidence satisfies a day (RP-08): one search.** Taken by the user 2026-09-22.
  `Meta.dc.html` draws «1 búsqueda · diccionario»; the day boards draw 55, which is the real figure
  measured in `reading.lookups` that day. The threshold is per commitment and the person can raise it.
- **The kit keeps composing on Radix Themes.** A fourth path of unstyled Radix paint reached the
  screen — `-webkit-text-fill-color` on a disabled or read-only field, set by Radix beside `color`
  and never pinned by the kit, so Chromium and WebKit painted their own grey under a correct-looking
  computed style. Taken knowing a fifth path can still surface: the fix is dressing what Radix paints,
  not leaving the library or rebuilding a primitive on bare elements. Taken by the user 2026-09-22.
- **A read-only field reads exactly as a disabled one.** Muted ink, a `line` ring, no fill of its
  own — one form for "this does not move," not two half-dressed states a reader would have to tell
  apart. No board draws a read-only field; this decision has none. Taken by the user 2026-09-22.
- **A goal adds a commitment from its own screen.** `Meta.dc.html` draws the list and no way into
  `CompromisoNuevo.dc.html`, and a goal is born with no commitment. A block button «Añadir un
  compromiso» sits under the goal's list: outlined while the list holds one, solid while it is empty,
  because then it is the only thing the screen asks for. Decided 2026-09-27 by the coordinator, the
  user having delegated it.
- **«N veces al mes» has no chip.** The schema and the engine accept `times_per_month`; the new
  commitment's screen offers the four cadences `CompromisoNuevo.dc.html` draws, and one already
  stored still reads on the goal. Taken by the user 2026-09-27: no chip until someone needs it.
- **The week draws no footer and no «descanso deliberado».** `Semana.dc.html` closes on a
  paragraph that only explains an empty day, and marks a day asking one thing as a deliberate rest.
  The first is cut as text a person does not act on; the second has no data behind it — nothing
  tells a rest the person chose from a day the plan simply asks little of. Also taken: one 8 px
  `dot` mark instead of the board's 9, the 56 px `Row` instead of 54, and «semana N de M» on each
  goal's label rather than once above the week, which reads right with several goals of different
  horizons. Decided 2026-09-27 by the coordinator, the user having delegated it.
- **The quantity sheet's question is neutral, never gendered by the unit.** «¿Cuántos {unit}?» read
  «¿Cuántos páginas?» for a feminine unit; the heading is now «¿Cuánto hiciste hoy?», the unit named
  once beside the chips instead of inside the sentence. Decided 2026-09-27 by the coordinator, the
  user having delegated it, over storing a gender per unit.
- **The chip row keeps the whole unit word, never the board's short form.** «10 minutos», not «10
  min»: no table maps an arbitrary unit string to an abbreviation, and guessing one would be a second
  unit the person never typed. Decided 2026-09-27 by the coordinator, the user having delegated it.
- **`/metas` always lists the person's open goals, and never redirects past a single one.** Each row
  is its own way into `Meta.dc.html`; the list ends with a block `Button` «Abrir otra meta», outlined,
  linking to `/metas/nueva` — the same pattern `commitment-list.tsx` draws under a goal's own
  commitments. With none yet, there is nothing to list and nobody to open a second goal from, so
  `/metas/nueva` is still the only useful screen and the redirect there stays. The bottom nav's
  «Meta» tab lands on this list. Decided 2026-09-27 by the coordinator, the user having delegated it.
- **The goal's own screen has no added way back to the list.** The bottom nav's «Meta» tab already
  sits on every signed-in screen and already routes to `/metas`, so a second link would be a second
  way to do what one control already does. Checked, not built, 2026-09-27 by the coordinator.
- **The empty week reuses the day's own empty state, word for word.** «Todavía no tienes una meta
  abierta.» and «Crear una meta», linking to `/metas/nueva` — copied into `week.json` and a sibling
  component (`components/week/empty-week.tsx`) rather than importing `components/day/empty-day.tsx`,
  since a week's own screen owns nothing under `components/day/**`. Decided 2026-09-27 by the
  coordinator, the user having delegated it.
- **A figure formats through `Intl.NumberFormat`, in the one locale `i18n/request.ts` fixes the app
  on** (`"es"`), rather than printing a bare number. `components/ui/figure.tsx` still takes only
  props and imports no catalogue: the locale is a constant beside it, the same way `lib/zone.ts`
  fixes `TIME_ZONE` for the same reason — the app has exactly one of each and nothing negotiates
  either. `Intl.NumberFormat("es")` groups `1000039` into `1.000.039` — a period, not the space this
  decision was first asked for in, measured against both Node's and Chromium's own ICU data on this
  machine (`Intl.NumberFormat.supportedLocalesOf`, Playwright's own bundled Chromium): grouped
  digits is the fix RP-14's own figure needed, and which punctuation mark ICU picks for Spanish is
  not this app's decision to make twice. Decided 2026-09-27 by the coordinator, the user having
  delegated it.
- **A second tap on a done `tap` row undoes its fact through `undoFact`.** No confirm sheet: the
  same gesture that made it unmakes it. Decided 2026-09-27 by the coordinator, the user having
  delegated it.
- **A tap on a done `quantity` row opens the quantity sheet showing the logged figure**, with
  «Deshacer» as a secondary action beside changing the amount. Its primary reads «Cambiar» and
  replaces that day's fact in one transaction; only the first log of the day reads «Anotar» and adds.
  Replacing, not adding, keeps the day and the goal's total saying the same number. Evidence rows stay untappable
  (RP-05: a derived fact cannot be undone). Decided 2026-09-27 by the coordinator, the user having
  delegated it.
- **A done row's second line shows what was logged** («25 minutos») instead of the target, and the
  note, when there is one, as a third quiet line (the type role already named `quiet` in the token
  table; no new role). Decided 2026-09-27 by the coordinator, the user having delegated it.
- **A goal adds a phase from its own screen, the same pattern as a commitment** (RP-15). Under the
  phase list, «Añadir una fase» → `/metas/[goalId]/fases/nueva`, always outlined on the phone and a
  `TextLink` from 1024; on an empty goal «Añadir un compromiso» is the one solid act. Decided by the
  user 2026-10-06 with the UX review (`ux-2026-10-06-b`: «Añadir una fase» solid on an empty goal),
  replacing the coordinator's 2026-09-27 rule (solid until the first phase).
- **`Fase nueva` is a full screen in `CompromisoNuevo.dc.html`'s own shape** (RP-15): overline the
  goal's name, h1 «Fase nueva», a field «qué busca» for the aim, a section «qué semanas» with two
  numeric fields «desde la semana» / «hasta la semana», counted from the goal's own opening week
  exactly as `goal-screen.tsx`'s own `phaseSpanLabel` already counts (`components/goal/phase-
  weeks.ts`'s `weekIndex`, shared rather than reimplemented). Prefilled: from the week after the
  last phase's own end (week 1 with none), four weeks long, never past the goal's own horizon.
  Primary «Añadirla». Decided 2026-09-27 by the coordinator, the user having delegated it.
- **A week span converts to civil dates in one pure function, `weeksToPhaseSpan`**
  (`components/goal/phase-weeks.ts`), the inverse of `weekIndex`: week `N` opens `(N - 1) * 7` days
  after the goal's own opening and closes the day before week `N + 1` opens. Proved by its own unit
  test at both ends of a span and across a month boundary — never `lib/zone.ts`'s `weekOf`, which
  counts the real Monday-to-Sunday week and has nothing to do with a goal's own opening day. Decided
  2026-09-27 by the coordinator, the user having delegated it.
- **An overlapping phase is refused, never silently accepted** (RP-15): the day names one phase
  (`phaseOn`, `lib/day/derive.ts`), so two spans covering one day would make it guess which one.
  `phasesOverlap` (`lib/validation/plan.ts`) is a plain function, not part of `addPhaseSchema` — the
  schema alone cannot see a goal's other phases — checked on the client against the phases the page
  already loaded, and again inside `addPhase`'s own transaction, authoritative, against a fresh
  `select` of the goal's own phases. A `EXCLUDE USING gist` constraint on `(goal_id, daterange(starts
  _on, ends_on, '[]'))` would close the same race two concurrent inserts could still slip through
  under `READ COMMITTED`, but costs a migration, `btree_gist` enabled in the `goals` schema, and a
  second place this rule is stated — not built, this being a single-editor screen with no such race
  observed. Decided 2026-09-27 by the coordinator, the user having delegated it.
- **The goal's own header counts active commitments only** (RP-13): a retired commitment stays in
  `commitment-list.tsx`'s own list — dimmed, marked, never hidden — but the count above the list
  names only what still asks something of the goal, not the whole history the list itself keeps.
  Decided 2026-09-27 by the coordinator, the user having delegated it.
- **Renaming is a quiet text action under the goal's own title, in the retire sheet's shape.** A
  ghost `Button` «Renombrar» — the same variant the theme control and «Escribir otra cantidad»
  already draw with — opens a `Sheet` carrying one `Field`, prefilled with the goal's current name
  and bound to the same rules `MetaNueva.dc.html`'s own name field already enforces (trimmed,
  required, 120 characters). «Guardarlo» / «Dejarlo como está», the retire sheet's own solid-over-
  outline pair. Nothing else moves: facts, weeks and commitments read exactly as they did (RP-23).
  Decided 2026-09-27 by the coordinator, the user having delegated it.
- **Archiving is an outlined block at the foot of the goal screen, opening the retire sheet's own
  shape.** «Archivar esta meta» opens a `Sheet` labelled with the goal's own name, h2 «¿Archivarla?»,
  a sentence naming what survives — its facts, the weeks it governed, its commitments — and that it
  leaves Hoy and Semana and can be reopened from Metas. «Archivarla» / «Dejarla abierta». For an
  archived goal, the block is replaced by a solid `Button` «Reabrir» — a direct action, no sheet,
  the same way undoing a tap needs none — and the goal's own add-commitment and add-phase ways in
  are both gone (RP-24). Decided 2026-09-27 by the coordinator, the user having delegated it.
- **`/metas` lists open goals first, then a quiet section «Archivadas»** (RP-24) — `listGoalsForMetas`
  (`lib/queries/goal.ts`) is the one statement behind both halves. Each archived row is still its own
  way into `Meta.dc.html`, from where «Reabrir» brings it back. The redirect to `/metas/nueva` only
  fires when the person has opened no goal at all, open or archived. Decided 2026-09-27 by the
  coordinator, the user having delegated it.
- **The day and the week exclude an archived goal by filtering the one "goals" subquery each already
  runs** (`lib/queries/day.ts`, `lib/queries/week.ts`) — no second check for the empty state: with
  every goal archived, that subquery returns nothing and the screen's own `goals.length === 0`
  branch already draws `HoyVacio.dc.html` / the empty week. Decided 2026-09-27 by the coordinator,
  the user having delegated it.
- **The week's «N de M» per day is a count, not a score.** It says how much was done and judges
  nothing, so RP-16's «no score» does not forbid it. Decided by the user 2026-09-28.
- **A one-off left undone carries to the next day.** It reads on Hoy, marked as from an earlier day,
  until it is done or deleted. Decided by the user 2026-09-28.
- **Pulsar's not-found and error pages speak Spanish**, as `NoEncontrada.dc.html` and `Fallo.dc.html`
  draw. The not-found marks no tab. An error inside the app keeps the nav of the layout it broke in,
  so a crash on Hoy shows Hoy marked: the error happened in that place. The quiet accent link is
  `Button tone="accent"`. Decided 2026-09-28 by the coordinator, the user having delegated it.
- **The review's columns are semana, the measure, fase and nota.** The wide board's second figure
  column («monólogo sin parar») is not built: no data feeds it. The phone shows the measure and the
  note alone. A week with nothing reads «0», never «—» and never hidden; the review stops at the
  current week, whose note reads «en curso». Decided 2026-09-28 by the coordinator, the user having
  delegated it.
- **The way into the review is a ghost «Ver por semana» under the goal's measure figure.** No board
  draws one; it shows only on a goal with a measure. Decided 2026-09-28 by the coordinator, the user
  having delegated it.
- **The review is the one screen wider than 640 px.** `Page` takes `width="wide"`, which lifts the
  cap to 1020 past the kit's 700 px breakpoint, as `RevisionEscritorio.dc.html` draws. Decided
  2026-09-28 by the coordinator, the user having delegated it.
- **Six boards drawn for the slice «la revisión», approved by the user 2026-09-28.** `Hoy.dc.html`
  (redrawn: a step back to yesterday before the date), `Semana.dc.html` (redrawn: past days within
  seven are links; no footer, no «descanso deliberado»), `HoySueltaAtrasada.dc.html` (a carried
  one-off reads «del sábado 19» under its text, before today's), `DiaPasado.dc.html` (step back,
  «volver a hoy», «anotado el lunes 21» on a late fact, no step back on the seventh day, no one-offs),
  `NoEncontrada.dc.html` and `Fallo.dc.html` (no tab marked: neither is a place in the app).
- **A past day lists only what existed that day.** A commitment created after the day drawn is not
  on `/dia/<fecha>`; with nothing left, the day says it asked for nothing. Decided by
  the user 2026-09-28, over allowing a backfill before the commitment existed.
- **A past day draws the dated tasks it still owed and those done on it, tapped as on Hoy; month tasks stay on
  Hoy.** Overturns «no one-offs» of `DiaPasado.dc.html` (:550-551). Decided by the user 2026-10-15.
- **A week is Monday to Sunday, on Semana and in the review alike.** A goal's week 1 is the partial
  week up to its first Sunday. Replaces «the review's week is the goal's own», taken the same morning.
  Decided by the user 2026-09-28, over 7-day runs from the opening day, and over
  printing both with dates.
- **A done one-off stays on Hoy, in a «hechas hoy» list, and a second tap undoes it**, as a
  commitment's fact does. Decided by the user 2026-09-28, over an
  undo toast and over leaving it.
- **A goal's horizon can be moved from the goal screen**, which keeps «Se puede mover después» true.
  Decided by the user 2026-09-28, over changing the copy.
- **A one-off's field takes a day, today by default.** One gesture still writes it for today; the
  person may pick «mañana», a date, or «sin día», and a dayless one waits in its own list (RP-21).
  Decided by the user 2026-09-28, over one-offs for today only.
- **The seventh day back says why there is no step further.** One line from the catalogue; the limit
  stays `PAST_DAY_LIMIT` = 7. Decided by the user 2026-09-28, over widening it to 14 or 30.
- **The cadences take bounds a person means:** at most 7 times a week and every 365 days at most, and
  the message says so. A commitment already stored outside them still reads. Decided
  by the user 2026-09-28, over keeping 1 to 1 000.
- **RP-17 is kept through the move to Monday–Sunday weeks.** Its text stays true; the change lives in
  the decision above. Decided by the user 2026-09-28, over retiring it for a new code.
- **Fifteen boards drawn for the slice «lo que la crítica pidió», approved by the user 2026-09-28.**
  `HoyHechas`, `HoyHechasTodas` («hechas hoy» at the foot of the one-offs, with its time; a second tap
  undoes; «N sin día» to the right of the «sueltas» label, absent at zero), `HoySueltaDia`,
  `HoySueltaOtroDia`, `HoySueltaSinDia` (the chips «hoy · mañana · otro día · sin día» show only while
  typing, «hoy» chosen, so Enter still writes today; a past date is refused in place; a one-off written
  for another day or none is confirmed in a line), `SueltasSinDia`, `SueltasSinDiaVacia`,
  `SueltaDarDia` (the list marks Hoy's tab; its sheet gives a day or leads to the delete sheet),
  `DiaPasadoSeptimo` (no step back, one line why), `DiaPasadoVacio` («Ese día no pedía nada»),
  `MetaHorizonte`, `MetaHorizonteHoja`, `MetaHorizonteFase`, `MetaHorizontePasado` («mover el final»
  beside the horizon; the sheet asks weeks and names the Sunday it ends; two refusals),
  `SemanaMetaNueva`; `Revision` and `RevisionEscritorio` redrawn with each week's dates.
- **A goal opened late in the week keeps the weeks it was written with.** Its partial first week is
  week 1, and «12 semanas» ends on the Sunday of week 12. Decided by the user 2026-09-28, over counting
  twelve whole weeks after the partial one.
- **Pulsar has a desktop face from 1024 px.** A left rail (Bitácora, Hoy, Semana, Metas; the date
  and the theme toggle at its foot) replaces the bottom nav. Hoy opens in two columns (the goals and
  their commitments; the week's figure, the one-offs, «N esperan» and «hechas hoy»). Semana changes
  shape: a table, one commitment per row and one day per column, today shaded, past days links, a
  «hechos» row at the foot. The goal opens in two columns (commitments; the end, the figure, the
  phases), «Renombrar» and «Archivar» beside the title. Every sheet is a centred 480 px dialog. The
  past day, `/sueltas`, `/metas`, the forms, the 404 and Fallo sit in the same frame as one column;
  700–1023 px keeps the phone face, centred. Boards: `HoyEscritorio`, `SemanaEscritorio`,
  `MetaEscritorio`, `HojaEscritorio`. Replaces «A wide face beyond `RevisionEscritorio.dc.html`» in
  «The boards that do not exist». Decided and approved by the user 2026-09-28: «no tiene sentido que
  sea tan feo».
- **A one-off written for a later day waits in `/sueltas` under «programadas»**, with its date, where
  it can be moved, done or deleted; the link on Hoy reads «N esperan» (dayless and scheduled). Not
  built; no board draws it yet. Decided by the user 2026-09-28, over showing it dimmed on Hoy and over
  leaving it hidden.
- **A goal past its end says «terminó el <día>» and leaves Hoy and Semana.** Its screen offers
  «Archivar» and «Mover el final»; `/metas` lists it under «terminadas». Not built; no board. Decided by
  the user 2026-09-28, over drawing it with a note and over leaving it open.
- **A goal that ends mid-week stays in Semana until that Sunday**, with the days it lived and blank
  days after its end; it leaves Hoy the day after its end and is gone from the next week. Not built.
  Decided by the user 2026-09-29, over dropping it from Semana the day after its end.
- **A one-off for another day is written with a visible «Anotar»**, shown with the chips once a day
  other than today is chosen, and Enter in the date field writes too. Decided by the user 2026-09-28.
- **Tapping a done one-off's name undoes it**, the whole row, as a done commitment does. Decided by the
  user 2026-09-28, over leaving the undo on the mark alone.
- **«hechas hoy» prints each one's time**, as `HoyHechas.dc.html` draws. Decided by the user
  2026-09-28, over cutting it from the design.
- **«Borrarla» in `SueltaDarDia` is a muted ghost button, not underlined.** `Button` has no underline
  prop and none was added for one link. Decided 2026-09-28 by the coordinator, the user having
  delegated it.
- **Ten boards drawn for the slice «escritorio», approved by the user 2026-09-29.**
  `SueltasProgramadas`, `SueltasProgramadasHecha`, `SueltasProgramadasVacia`, `SueltaMover`,
  `SueltaMoverPasado`, `HoyTodasTerminadas`, `MetaTerminada`, `MetaTerminadaMover`,
  `MetasTerminadas`, `MetasSoloTerminadas`; `HoySueltaOtroDia` redrawn in place with «Anotar».
- **`/sueltas` is titled «Lo que espera»**: «N sin día» first, «N programadas» after, each programada
  with its weekday and day, the month only outside this week, and its goal when it has one. A group
  with nothing in it does not draw. Done from the list, the one-off leaves it and a status line says
  it is in «hechas hoy», with «ver hoy». Decided 2026-09-29 by the coordinator; board approved by the
  user.
- **A programada moves from «¿Para cuándo?»** with its current day under the title, «hoy · mañana ·
  otro día» (no «sin día»), «Moverla» solid, «Dejarla como está» outlined, «Borrarla» a muted ghost.
  A past day is refused as the one-off field refuses it. Decided 2026-09-29 by the coordinator; board
  approved by the user.
- **«Anotar» is a solid accent button under the chips**, in the same place for «mañana», «otro día»
  and «sin día». Decided 2026-09-29 by the coordinator; board approved by the user.
- **An ended goal's screen**: «terminó el <weekday day month>» in place of the weeks line, «Mover el
  final» solid and «Archivar» outlined side by side, no way to add a commitment or a phase, the figure
  and phases as they were. Its move sheet opens on the weeks that end this Sunday. Decided 2026-09-29
  by the coordinator; board approved by the user.
- **`/metas` lists «terminadas» between the open and «Archivadas»**, each with «terminó el <day
  month>». With only ended goals the list still draws, «Abrir otra meta» included. Each ended row
  reads «terminó el {día} {mes corto}» at its end, with no year, as on the goal screen and on Hoy;
  the year is omitted on purpose. Decided 2026-09-29 by the coordinator; board approved by the user.
- **Hoy with every goal ended and none open** reads «Hoy no pide nada.», names the goal that ended
  and its day, and offers «Ver las metas» solid and «Abrir otra meta» outlined; goalless one-offs
  still draw below. Decided 2026-09-29 by the coordinator; board approved by the user.
- **The Semana says when a goal ended**, «terminó el <día> · ver» under its name, as Hoy does. Board
  `SemanaMetaTerminada.dc.html`. Decided 2026-09-29 by the coordinator, on the user's delegation.
- **An archived goal's overline reads «meta · archivada el {date}»**, the day it was archived in the
  person's zone, in place of «meta · abierta el {date}». Decided 2026-09-29 by the coordinator.
- **Hoy's desktop figure is each open goal's measure this week**, one card per goal with a measure:
  its name, the number, «esta semana», «Ver por semana». A goal without a measure draws no card.
  Decided 2026-09-29 by the coordinator, reading `HoyEscritorio.dc.html`.
- **«hechas hoy» prints `HH:mm`, 24-hour.** Decided 2026-09-29 by the coordinator, from
  `HoyHechas.dc.html`.
- **The horizon sheet's label reads «semanas, contando la del {date}».** Decided 2026-09-29 by the
  coordinator.
- **The kit gains `Panel`, the desktop card**: white ground, 1px line, radius 14, from 1024 px. Below
  1024 px it draws nothing and its content flows as on the phone. Decided 2026-09-29 by the
  coordinator, reading `MetaEscritorio.dc.html`.
- **The time of a done one-off goes under its name.** Decided 2026-09-29 by the coordinator.
- **The rail's date is short: «martes 22 sep»** (`civilDateShort`). Decided 2026-09-29 by the
  coordinator.
- **«Hoy no pide nada.» only when nothing is asked and nothing waits today.** With every goal ended and
  a one-off still due, Hoy keeps the ended-goal line and its two buttons and drops the sentence. From
  1024 the sentence is body text, never a second headline under «Hoy». Decided 2026-09-29 by the
  coordinator, after the critic found it contradicting a waiting one-off.
- **Two columns split 3:2 from 1024, and fix the aside at 1280.** Below 1280 the main column (goals,
  commitments) takes three parts and the aside two; from 1280 the aside keeps the boards' own width.
  No board draws 1024; this is the coordinator's reading. Decided 2026-09-29 by the coordinator.
- **Semana's name column is 200 px at 1280**, not the 260 `SemanaEscritorio.dc.html` draws, so a day
  header reads «mar 29 · hoy» on one line; the header row stays in view while the table scrolls.
  Decided 2026-09-29 by the coordinator.
- **A goal's weekly figure is named by its unit** («kilómetros esta semana»), never by the first
  commitment with a number: the sum takes every fact in that unit. Decided 2026-09-29 by the user.
- **Hoy says when a goal ended**, in one quiet line under the title for the days after its end:
  «Dejar el azúcar terminó ayer · ver», then «terminó el lunes 28» later in the same week, gone once
  that week is over (a goal that ended on a Sunday is gone on the Monday). «ver» opens the goal.
  Board `HoyMetaTerminada.dc.html`, approved by the user 2026-09-29; the desktop face is the same line
  under «Hoy». Several goals ended that week: one line each, in plan order (RP-47; «most recent first» superseded by the user's RP-47 of 2026-10-05, read 2026-10-07). Only on today, never
  on `/dia/<fecha>`, and never beside the all-ended card, which already names the last goal. Wording
  decided 2026-09-29 by the coordinator.
- **A flexible cadence counts by its period in Semana**: «2 veces por semana» and «N al mes» say their
  period and no longer leave the daily «hechos» (corrected 2026-10-09: they count; see «hechos N de M» below), and their row says the cadence and the count: «3 veces por semana · 1 de 3 esta
  semana», «4 al mes · 3 de 4 este mes». On the table the days not done read the quiet «·»; on the
  phone they sit in a group «{meta} · por semana y por mes» under the day rows. Boards
  `SemanaFlexible.dc.html` and `SemanaEscritorioFlexible.dc.html`, approved by the user 2026-09-29.
  Decided 2026-09-29 by the user.
- **A one-column screen caps at 640 px from 1024.** Decided 2026-09-29 by the user.
- **From 700 to 1023 px the phone face's column holds 600 px of content** (640 minus 20 px of padding a side); from 1024 it is 640. Kept as built, not widened. Decided 2026-09-30 by the user, after the suite review found no test measured the range.
- **«N al mes» is the fifth cadence chip** and swaps the row for «veces al mes». Board
  `CompromisoNuevoMes.dc.html`. Decided 2026-09-29 by the user.
- **Hoy builds what `HoyEscritorio.dc.html` draws**: each row's cadence, a flexible
  commitment's progress, «fase 1 de 3», the time on a done commitment. Decided 2026-09-29 by the user.
- **Hoy says «hechos N de M» over the same rows as the Semana's «hechos»**, flexible rows counted since 2026-10-09; a flexible row with
  progress says only its progress; a flexible met in its period stays as a quiet row «cumplida esta
  semana», and can be marked again. Board `HoyCuenta.dc.html`. Decided 2026-09-29 by the coordinator,
  on the user's delegation. Over its quota the row reads «cumplida esta semana · 2 veces», never «2 de 1».
- **The goal's measure line reads «mide en {unidad}»** (in time, «mide en horas y minutos»: see below), and the review's measure column is headed
  «total» beside the table's own unit. Decided 2026-09-29 by the coordinator, wording module 89.
- **A row the person marked says «lo dijiste tú» after its hour; a `quantity` row not yet marked
  says «pide el número» after its target.** «Anki · 10 min · 07:40 · lo dijiste tú», «Monólogo
  grabado · 3 min · pide el número». An evidence row keeps its source and never says either; a quiet
  row met in its period says neither. Drawn on `HoyEscritorio.dc.html` and `HoyHechas.dc.html`
  since the first boards; decided 2026-09-30 by the user, module 100.
- **A quantity row logged under its target reads «1 de 3 min · 09:22 · lo dijiste tú»**, the mark still empty (superseded 2026-10-06: the mark is «done in part», `HoyEnParte`); «pide el número» is only for a row with nothing logged that day. «lo dijiste tú» stays on every row the person marked, whether or not the day has evidence. Decided 2026-09-30 by the user, after the critic of module 100.
- **The plan by month is built as the 21 boards of «El plan» draw it.** Approved by the user 2026-09-30.
- **A time is written «12 h 30 min»** and stored in whole minutes (RP-35). Decided 2026-09-30 by the user.
- **A done task adds its estimate to the measure** (RP-36), knowing the same hours may count twice if
  the day's block was marked too. Decided 2026-09-30 by the user.
- **The shift is proposed, never applied alone** (RP-34): over half carried, during the month after,
  one confirm. Decided 2026-09-30 by the user.
- **A phase already begun does not move when the plan shifts**; only phases not yet started move, both
  ends. Decided 2026-09-30 by the user (question 6, option a).
- **The month after a shifted one keeps no amount**; it shows the reached figure and the way to plan
  it, as `MetaMesSinPlan.dc.html` draws. Decided 2026-09-30 by the user (question 7, option a).
- **The export is a PDF through the browser's print**, a print page and `window.print()`, no library.
  Decided 2026-09-30 by the user.
- **The export and the import are built as the 15 boards of «Exportar» and «Importar» draw them.**
  Approved by the user 2026-09-30.
- **Words no board drew, worded by module 134 in the boards' voice** (`apps/goallog/messages/es/`): the
  amount and task sheets' labels («horas», «minutos», «cuánto, en {unit}», «Guardar», «Cancelar»), the
  plan errors (`month.errors.*`, e.g. «Ese mes queda fuera del plazo de la meta.», «Esta tarea se da
  por hecha cuando lo están sus sub-tareas.»), the import errors no board shows (`horizonPast`,
  `duplicateMonth`, `unreadableType`, `draftInvalid`), «plantilla copiada», «Creando…». The catalogue
  is the source of these words; a board that later draws one follows it. Decided 2026-09-30 by the
  coordinator.
- **In a time unit, the wide review's measure column is headed «total» alone**; each cell carries its own
  «h» and «min», so «total minutos» would say the unit twice. `RevisionHoras.dc.html` draws the phone face
  only. Decided 2026-09-30 by the coordinator, module 146.
- **In a time unit, the quantity sheet offers `CantidadHoras.dc.html`'s spread, not four neighbours.** The
  target, up to four 15-minute steps below it (only those above zero) and three 30-minute steps above, at
  most eight chips, the target selected: 90 min reads «30 min, 45 min, 1 h, 1 h 15 min, 1 h 30 min, 2 h,
  2 h 30 min, 3 h». Other units keep the four
  integers. The own field «otro número, en minutos» stays. Decided 2026-09-30 by the user.
  **Under an hour the steps are 5 minutes**, four below (only those above zero) and three above: 10 min
  reads «5, 10, 15, 20, 25 min», 45 min reads «25 … 60 min». Decided 2026-09-30 by the coordinator.
- **With the source unreadable, the months table's caption reads «{count} meses · solo lo dicho».** The phone hides
  the header row, so the caption is where that table says its figures are only what was declared, as it did before
  171 made the caption a count. `ReporteSinEvidencia.dc.html` draws the mark under each closed month instead; the
  caption replaces it. Decided 2026-10-05 by the coordinator.
- **Page «La IA» approved as drawn: `ConexionesVacio`, `ConexionesUna`, `ConexionesCreada`, `ConexionesRevocada`,
  `ConexionesFallo`, `ConexionesOAuth`, `MetasConectar`, `Autorizar`, `AutorizarSinSesion`, `AutorizarInvalida`.** The
  screen lives at `/conexiones`, reached from `/metas`'s «el plan» («Conectar una IA»). Phone and light face only; the dark
  face is the token table's, and 1280 follows the desktop layout. Approved by the user 2026-10-05, «por mientras», with the
  desktop layout as a whole under review.
- **A key or connection unused for 90 days stays on `/conexiones`, muted like a revoked one, with no «Revocar»:
  «venció el {date} · sin uso desde el {used}».** `ConexionesVencida` draws it; a claude.ai connection expires the same way,
  in its own section. Order: live, expired, revoked; newest first within each. The screen derives the row from
  `expiredAt` and computes no date. Phone and light face only; dark is the token table's. Approved by the user 2026-10-08
  (audit B3, Q2).
- **Signed out, the consent screen names no client.** Before sign-in the name is only what the client declares, so anyone
  could call itself «Claude»: it reads «Una aplicación pidió entrar…». `AutorizarSinSesion`'s «Claude» is the signed-in
  name. No grant to `anon`. Decided 2026-10-05 by the coordinator.
- **The consent screen has no rail: its column is 640 px, centred, at every width from 700.** The shell's rail and left
  alignment belong to the screens inside `(app)`; `/oauth/autorizar` stands outside it with no nav, and the boards draw one
  column at 1280. `AutorizarInvalida` centres its content vertically. Decided 2026-10-05 by the coordinator; the design
  said nothing for a screen outside the shell, so it is centred.
- **The shell is redrawn before any screen rides on it.** The critic of 2026-10-05 measured the desktop as the phone column
  (640 px pinned left, 456 px empty at 1440) and the phone's tabs off screen on every long page (Hoy's start at y=1490 of
  844). Decided by the user 2026-10-05, four answers:
  - **Phone: four tabs, fixed to the bottom — Hoy · Semana · Mes · Metas.** «Mes» is this month across every goal: its tasks,
    what was carried, the amounts. Import, export and «Conectar una IA» live inside Metas. Every screen gets one header: its
    title and one way back. Replaces the three tabs at the foot of the page.
  - **Desktop: the rail plus list and detail.** The rail names each goal; a list sits beside its open item (goals beside the
    goal, months beside the month, the import text beside its review); the export and the tables take the full width.
    **Retires the 640 px column decisions of 2026-09-29 and 2026-09-30** for every screen this shell redraws.
  - **Semana takes ‹ › and shows any past week, read-only.** Writing stays seven days back.
  - **A month's tasks live in «Mes».** Hoy keeps only each goal's next task (174, 177).
  The order is the coordinator's, 2026-10-05: one «armazón» slice first (nav, header, desktop frame), then each screen on it.
- **The armazón boards are approved as drawn**, 38 of them on four new canvas pages and four existing ones:
  «Armazón» (`ArmazonPestanas`, `ArmazonPestanasHoja`, `ArmazonEncabezado`, `ArmazonFormulario`, `ArmazonCargando`,
  `ArmazonFallo`, `ArmazonNoEncontrada`, `ArmazonRiel`, `ArmazonRielMuchas`, `ArmazonRielSinMetas`, `ArmazonListaDetalle`,
  `ArmazonFormularioEscritorio`, `ArmazonCargandoEscritorio`, `ArmazonFalloEscritorio`, `ArmazonNoEncontradaEscritorio`);
  «Mes» (`MesTodas`, `MesTodasVacio`, `MesTodasNada`, `MesTodasHecho`, `MesTodasSinEvidencia`, `MesTodasEscritorio`);
  «Semana pasada» (`SemanaPlegada`, `SemanaPasada`, `SemanaPrimera`, `SemanaPasadaArchivada`, `SemanaPasadaEscritorio`,
  `SemanaEstaSemana`); «Metas» (`MetasCentro`, `MetasCentroEscritorio`, `MetaRiel`); and `MesesFilas`, `MesesListaDetalle`
  («El plan»), `ImportarListaDetalle` («Importar»), `ReporteMarco`, `ReporteMarcoEscritorio` («Exportar»), `RevisionAncha`
  («Semana y revisión»), `SueltasEncabezado`, `DiaPasadoEscritorio` («Hoy»). Approved by the user 2026-10-05: «sí acepto».
  - Taken by the boards: the tab bar is 56 px plus the safe area; the back is a chevron and the place's name, 48 px; the rail
    stays 232 px with 44 px items and the open goals under «metas abiertas»; on a goal's page only the goal is marked; the
    list column is 320 px (360 for the import); a form caps at 560 px, left under its title; a past week has no «volver a
    esta semana» (the Semana tab is the way back); in «Mes» a goal's name opens that goal's month.
  - **Retired** for every screen the armazón redraws: «A one-column screen caps at 640 px from 1024» (2026-09-29);
    `MesesEscritorio`'s 640 px column (2026-09-30); «The export and the import at 1280… 640 px column» (2026-09-30); «The
    review is the one screen wider than 640 px» (2026-09-28); «Semana's name column is 200 px at 1280» (2026-09-29); and
    the 2026-09-28 entry's «the past day, `/sueltas`, `/metas`, the forms… sit in the same frame as one column».
  - **Kept:** «From 700 to 1023 px the phone face's column holds 600 px» (2026-09-30); every sheet a centred 480 px dialog;
    «Two columns split 3:2 from 1024» for Hoy and the goal.
  - Not drawn: every dark face (the token table says it); «Mes» loading and failure (they are `ArmazonCargando` and
    `ArmazonFallo` with Mes marked); 700–1023 (the phone face, centred).
- **`/metas` with no goal ever draws `MetasVacio.dc.html`, and the empty Hoy draws `HoyVacioImportar.dc.html`;
  the Semana is unchanged.** Reverses the 2026-09-27 redirect to `/metas/nueva` (see «`/metas` lists open
  goals first»): a person with no goal, open, ended or archived, reads «Todavía no hay metas», «Abrir una meta»
  and, under «el plan», «Importar un plan» with no «Exportar»; Hoy says «Todavía no hay nada que anotar.» with
  the same two ways. A person with any goal reads the list as before. Decided by the user 2026-10-01, options
  (a) and (c). **Faces not drawn:** both boards are the phone alone (390). At 1280 each follows the existing
  desktop layout (the rail, the 640 column for `/metas`, Hoy's main column), no board of its own; no dark face
  (the token table says it). The boards' fixed 844 px phone is not reproduced: both screens flow in the standard `Page`.
- **Module 203 against its boards.** Decided 2026-10-05 by the coordinator:
  - The amount sheet still has no «Cancelar»: `HoyCantidad` does not draw one.
  - A goal's full name in the rail also shows on keyboard focus, not only on hover, as `ArmazonRielMuchas` draws it.
  - Moving the blocks of `escritorio.spec.ts` waits for module 218.
- **The failure and the 404 have no back link: their actions are the way out** (`ArmazonFallo`, `ArmazonNoEncontrada`).
  The header is the title under its eyebrow; «Ir a hoy» leaves. Decided 2026-10-05 by the coordinator.
- **`/metas`, plan rows.** «Importar un plan» first, then «Exportar» with the hint «cómo va cada meta, en PDF». Decided by the coordinator 2026-10-05 against the approved board `MetasCentro`.
- **`/metas` on the phone.** The plan sits between «Abrir otra meta» and «Archivadas» (`Split`'s `tail`, which follows `after` on a phone and stays under `main` from 1024). Decided by the coordinator 2026-10-05 against the approved board `MetasCentro`.
- **`/metas` at 1440, rows.** Each open goal's row shows its current month and figure («octubre · 2 h 41 min de 12 h»; «octubre · 86 páginas» with no plan; «octubre · 2 de 5 tareas» with no measure) and its last day at the end. The figure counts declared facts, done tasks and evidence readings, read in parallel with the goals statement as Hoy's month line does. A goal with nothing this month shows its last day alone. Decided by the coordinator 2026-10-05 against the approved board `MetasCentroEscritorio`.
- **`/metas` at 1440, proportions.** The plan column is two parts of five at every width from 1024 (`Split`'s `twoFifths`), and «Abrir otra meta» sits inline under the open goals. Decided by the coordinator 2026-10-05 against the approved board `MetasCentroEscritorio`.
- **`/metas` at 1440, the figure.** 2026-10-05: la cifra de cada meta en /metas incluye la evidencia, como Hoy. Decided by the coordinator against the approved board `MetasCentroEscritorio`.
- **Module 218, the forms' caps.** `/conexiones` and the 404 keep the 560 px form cap; `/metas/importar` keeps its 640 px;
  a past day's «volver a hoy» keeps its name. Decided 2026-10-05 by the coordinator.
- **Module 211, `MetaRiel`.** The rail draws one row; nothing in it shares a left edge with the header. The plan said
  otherwise and was corrected to the board. Decided 2026-10-05 by the coordinator.
- **Notes on tasks (RP-45).** Decided by the user 2026-10-05, five answers:
  - the note lives on the task (month task, sub-task, one-off), editable at any time, done or not;
  - it opens from a note button at the end of the row, grey when empty, green with lines when not; no tap that exists today
    changes (the mark marks, the name deletes, undoes or schedules as before). Boards approved: «Aprobados así»;
  - the month's lists and `/sueltas` show up to two lines of it; Hoy shows only the button;
  - the connected AI writes and replaces a note, never empties one;
  - the PDF prints it under every task it lists — carried ones, and this month's once the report lists them (the second
    answer, the same day, superseding «carried only»); it travels in on the template's import, not out as text.
- **What the critic of 2026-10-05 (trains 6 and 7) asked.** Decided by the user 2026-10-05, four answers
  (`private/critica-2026-10-05-tren7.md`):
  - a quantity logged below its target is **done in part**: a fourth mark, a half-filled circle; the target stays the bar
    and the palette stays without red. It needs its board before any screen draws it;
  - goals and tasks follow **the plan's order**, kept as a position written at import; on Hoy alone, the goals that ask
    something today come first. A goal's commitments follow the plan's order too (decided the same day);
  - on the phone, **Hoy drops the section of a goal that asks nothing today**; its line under «este mes» stays, and a
    one-off for it is written from Mes or the goal;
  - the report carries **this month's tasks**, done and not, under each goal, and folds the weeks into the months table.
    This changes RP-33: it is retired and succeeded.
- **The critic's cut of trains 6 and 7, drawn.** The 13 boards above, approved by the user 2026-10-06: «confirma los
  diseños, me da igual». What the coordinator chose while drawing stands: the partial never adds to «hechos» and is
  named apart («· 1 en parte»); a past day steps both ways and keeps «volver a hoy»; a week sits under the month of its
  Monday; the report is three columns at 1440 and two at 1024; the revoke sheet's words as drawn.

## Decisions of 2026-10-06, after the critic of train 13

- **The report has two columns from 1024, never three.** At 1440 three columns gave 299 px cards and the months table
  (334 px) ran out of them. `ReporteMarcoEscritorio.dc.html` (three columns) is superseded on this point; the 1024 board's
  two columns hold at every desktop width. From 1024 to 1279 the months table inside its card takes the phone's stacked face (label over
  figures); the wide table returns at 1280, where it fits. Decided by the orchestrator 2026-10-06 (module 281): two columns
  at 1024 leave 280 px of card and the wide table needs 382.
- **A week that crosses two months is split in the report's months table.** Each month holds the days of that week that
  fall in it, so the weeks under a month add up to the month. The split week shows under both months with its own span
  («sem 5 · 28–30 sep 2026», «sem 5 · 1–4 oct 2026»).
- **Every goal with tasks this month has its «este mes» line on Hoy, measured or not**, as `HoyTelefonoSinPedido.dc.html`
  already draws «Mudanza · 1 de 3 tareas». A goal with no measure reads its tasks done of total; its next task follows as
  `HoyTareaMesSubtarea.dc.html` draws it.
  - On the phone the goal's name sits over its figures, not beside them as the board's one row does: a long name and
    «1 de 3 tareas» do not share 328 px. Decided by the orchestrator 2026-10-06 (module 283).
  - From 1024 a goal with no week card gets a side card of its own: its name, «Este mes», then the same lines. No
    board draws it; it repeats the measured card's order minus the week figure. Decided by the orchestrator 2026-10-06
    (module 283).
- **«Correr un mes» is offered only when the month also fell short of its amount** (RP-48, succeeding RP-34).

## Decisions of 2026-10-06, after the UX review

Taken by the user 2026-10-06 («todo sí») on the two UX critics' reports, `private/reportes/ux-2026-10-06-{a,b}.md`.
The user's words: «textos todos pegados, no se entiende la mayoría, la estructura no es tan buena».

- **Space lives in the primitives, never in a screen.** A `Section` primitive carries its label→content gap and the
  gap to the next section; Split's columns space their children; a field's hint keeps air before the next control.
  A screen that needs a gap of its own is reaching past `components/ui`.
- **Content stops at about 1200 px wide on desktop.** A block button never runs the width of the column; a link
  button and a `<button>` side by side are one width rule.
- **Mono is for figures and dates only.** Every sentence — a hint, an explanation, a refusal, an empty state, a note
  — is Archivo, in muted. A new quiet-sentence variant of `Text` carries it; `variant="meta"` keeps figures and dates.
  This is the Type section's «a figure in mono, a sentence in Archivo», which the screens had drifted from.
- **A field's label is Archivo 13 / 500, in ink secondary**, never the section label's mono caps. Two labels must
  never read as two headings. Reverses the 2026-09-22 rule above.
- **Tapping a task's or a suelta's name opens an edit sheet**: name, estimate and month, with «Borrar» at its foot.
  The mark still marks done. Tapping a name never offers deletion first.
- **«hechos N de M» on Hoy counts every commitment row that asks that day**, flexible (weekly, monthly) and evidence rows included; the Semana's «hechos» counts the same. Sueltas are not in it. A past day's «ese día pedía N» counts the same rows. Corrects the 2026-09-29 rule that left flexible rows out. Decided 2026-10-09 by the user (answers Q1 (a) and Q4 (a) of 2026-10-08). Boards `HoyCuenta`, `HoyDia`, `HoyAyerPrimerDia`.
- **The plan's words are plain.** «arrastró», «correr un mes», «debe», «umbral», «toque» give way to plain Spanish
  («quedó pendiente», «aplazar un mes», «falta»). The exact words are drawn on the boards first. Behaviour is
  unchanged, so no code is retired.
- **The report folds its weeks under their month on screen; on paper it prints months only.**
- **A phase is still chosen by week numbers, with the dates beside them, live, and the valid range stated.**

- **The space system, approved by the user 2026-10-06 on `SistemaEspacio.dc.html`.** Every gap is a multiple of 4.
  - Header: date → title 6; title → lead 12; header → first section 32.
  - Section: label → content 12; section → section 32, 40 from 1024. A row pads 12 above and below, 56 tall at least.
  - Field: label → control 8; control → hint or refusal 6; hint → next control 20.
  - Width from 1024: content up to 1200, centred in what the rail leaves; a one-column screen (a form, an empty state)
    up to 640. Cards in a column stand 16 apart, from the column's gap, never a card's margin.
  - Buttons: full width and stacked 12 apart on the phone; from 1024 sized to their text, 160 at least, in a row, the
    primary first. A link shaped as a button follows the same rule as a `<button>`.
- **The type roles, approved the same day on `SistemaTipo.dc.html`:** title; section label (mono 11 caps, one per
  section, names a group); field label (Archivo 13 / 500, ink secondary); name (Archivo 16 / 500); quiet sentence
  (Archivo 13 / 1.5, muted: hints, refusals, empty states, notes); figure and date (mono 12); measure (mono 26, its unit
  13 beside it, never wrapped). A unit never breaks from its number.
- **`ConexionesTelefono.dc.html` and `HoyVacioEscritorio.dc.html` are the two screens redrawn on the system**, approved
  with it. Their words: «Claude lee tus metas, anota lo hecho y reorganiza tus meses. Nunca borra ni archiva.»; a key's
  line «Creada hoy a las 12:18 · sin usar»; «Copiar» answers «Copiada.» beside a check.
  A failed copy shows, in the same place, one quiet sentence: «No se pudo copiar. Mantén presionado el texto para copiarlo.» (decided 2026-10-06).
- **Seven more, taken by the user the same day on the planner's questions** (the orchestrator's picks, «el resto de
  recomendación»):
  - The report on paper prints months only; RP-46 retired for **RP-49**.
  - A done task's name can be edited; its estimate cannot, so past totals never move.
  - The app is called **«Bitácora de metas»** everywhere a person reads it: the rail, the consent screen, the PDF, every
    button. «pulsar» stays in the address alone.
  - A goal's weeks count its partial last week: a goal that ends mid-week has 36 weeks when 35 are whole, and a phase may
    take the 36th.
  - «Aplazar un mes» (the old «Correr un mes») is offered on Hoy and on the goal too, while it is open.
  - Hoy steps between days with labelled controls beside the date, «‹ ayer» and «mañana ›»; a bare ‹ means back
    everywhere.
  - A commitment in a goal that measures takes the goal's unit; there is no free unit field there.
- **The plan is a roadmap, decided by the user 2026-10-06** («que vaya por cantidad de horas por mes y funcione como
  roadmap, de esa manera todo se mueve proporcionalmente»). Drawn on the page «El plan por mes» (`RoadmapPlan`,
  `RoadmapHoyMovido`, `RoadmapPasaElFinal`, `RoadmapSinRitmo`, `RoadmapFijar`) and approved by the user the same day; written
  as RP-50 to RP-55, retiring RP-42 and RP-48. RP-28 stays: a month's own amount overrides the rhythm.
  - A goal has a rhythm, hours per month, which one month may override. Its tasks are one ordered list, each with its
    estimate. The app gives each task its month by filling each month's hours in order.
  - The person may **fix** a task to a month (a real date: an exam, a delivery); the rest flows around it.
  - **The plan moves by itself** whenever something changes — a month left short, an estimate, a new task, a month's
    hours — and Hoy says so («tu plan se movió 2 semanas»). Nothing asks to be accepted.
  - **A task that does not fit whole starts where it fits and goes on in the next month** («sigue en noviembre»); its
    hours are split between the two.
  - The end date is the plan's: «a este ritmo terminas en …», set against the goal's end.
  - Built before wave 3 of the UX slice: the edit sheet and the plan's words wait for these boards.
- **Boards III of the roadmap, approved by the user 2026-10-06** on the page «El plan por mes», second row:
  `RoadmapTramoMedio`, `RoadmapTareaNueva`, `RoadmapRitmoHoja`, `RoadmapSinMedida`, `MetaVerPlan`,
  `RoadmapHoyMovidoDias`. `RoadmapFijar` asks the estimate in hours and minutes, the task form's two fields (RP-35).
- **Five more, taken by the user the same day** (the orchestrator's picks):
  - A goal's first rhythm releases its pending fixed tasks into the plan; «Armar el plan» says first how many will
    move. Fixed after that stays fixed. That line is not on `RoadmapSinRitmo`; its words come with module 346.
  - A task the plan carried keeps «de septiembre · falta 3 h», fixed or not. RP-31 stays.
  - The AI fixes a task to a month and returns it to the plan; it never changes a rhythm. RP-40 retired for **RP-56**.
  - «Septiembre cerró con 6 h de 12 h» counts the estimates of the tasks done that month, never the measure reached:
    what is missing is exactly what moved.
  - A one-off with no goal is renamed from the same sheet: **RP-57**.
- **A pin means something only against a plan** (2026-10-06, decided by the orchestrator). A row draws the pin and «Fijada en …»
  only when its goal has a rhythm and the task holds a month. A goal with no rhythm draws none on any row: every task
  of it has a month and pinning all of them says nothing. The task's sheet still shows «Mes» there, with «Fijarla en»
  selected for a task that holds a month.
- **`RoadmapFijar` picks the month with chips** (2026-10-06, decided by the orchestrator): «Fijarla en» opens a row of
  month chips, one selected, instead of a select; no select primitive exists in `components/ui`.
- **The plan's notice on Hoy** (2026-10-06, decided by the orchestrator). A move under 7 days reads in days
  (`RoadmapHoyMovidoDias`: «se movió 3 días», and no sentence about the rest running behind); from 7 days it reads in
  whole weeks, rounded (`RoadmapHoyMovido`: «se movió 2 semanas»). With several goals the notices stack at the top of
  Hoy, above the goal sections, each naming its goal. A move of 0 days draws none.
- **A phase is written in weeks and reads its dates**, decided by the user 2026-10-06 after the wave-2 review. The
  phase form shows live, under the weeks, the days they cover («del lunes 5 de octubre al domingo 8 de noviembre») and
  the last week the goal allows, as «Mover el final» does. No schema change. Boards `FaseFechas`, `FaseFechasFuera`,
  `FaseFechasSolapa`, approved by the user 2026-10-06.
- **The phase form rings the field that is out of range** (2026-10-06, decided by the orchestrator): «hasta» when only
  the end passes the goal's last week, «desde» when the start does. `FaseFechasFuera` drew «desde» only because its
  example started past. «Añadir la fase» under a refusal moves focus to that field, «desde» first.
- **An imported phase that starts before its goal is cut to week 1**, decided by the user 2026-10-06. The import's
  review says so before «Crear» («la fase X empieza en la semana 1, el 6 de octubre»). Board `ImportarFaseRecortada`,
  approved by the user 2026-10-06.
- **The goal at 1024 draws its phases on a full-width row under the two columns** (2026-10-06, decided by the
  orchestrator): a 260 px phases column broke an aim into one word per line.
- **Decided by the user 2026-10-06, after the roadmap and wave-2 critics:**
  - A goal holds no fact before the day it opened. The AI refuses such a fact and says why; the past day never draws
    the goal before it opened.
  - A month's figure on the goal and the plan is the hours of the tasks done that month against its room, as Hoy's
    notice counts («septiembre cerró con 6 h de 12 h»). The measure's total stays on its own line.
  - «Mover el final» asks first: a sheet names the old and the new end («Mover el final del 29 de noviembre al 20 de
    febrero»), «Moverlo» and «Cancelar». Supersedes the one tap of `RoadmapPasaElFinal`. Boards `RoadmapMoverFinalHoja`,
    `RoadmapMoverFinalFallo`, approved by the user 2026-10-06.
  - When several plans moved, Hoy draws one card: «N planes se movieron», a line per goal (how far, «Ver el plan»), one
    «Entendido». Supersedes one card per goal (`RoadmapHoyMovido`) and the stacking decided earlier today. Board
    `RoadmapHoyMovidoVarios`, approved by the user 2026-10-06.
- **Decided by the orchestrator 2026-10-06, same reviews:**
  - A task past the goal's end that starts inside it reads its part in its month («Empieza aquí con 10 h y sigue en
    diciembre.»); only what falls after the end is listed under «después de tu final» (RP-54).
  - A row under «después de tu final» opens the task's sheet, as every task row does.
  - A month's header says which figure it is: the current month «5 h de 12 h en tareas hechas», a later one «12 h planeadas de
    12 h». Boards `RoadmapMesCifras`, `MetaPlanHechas`, approved by the user 2026-10-06.
  - Setting a goal's first rhythm raises no «se movió» notice: the plan starts there.
  - A task with no estimate reads «sin estimar» as its trailing, muted, in every list of the plan.
  - A parent's sheet says under «Nombre» why it has no estimate: «Suma lo de sus sub-tareas.»
  - A task fixed to a month that has closed shows that month as the selected chip, closed, in its sheet.
  - On `/sueltas` a suelta's name opens the RP-57 sheet; «Darle un día» is a row inside that sheet (W3-Q1).
  - A goal's own dated one-off opens the same sheet with its name alone (W3-Q2).
  - Figures use a plain zero, never the slashed one (W3-Q3).
  - An imported phase that ends before its goal opens is dropped and listed in the import's review (W3-Q4).
- **Wave 3 of the UX review, decided by the orchestrator 2026-10-06** (module 365):
  - A past day's heading counts what «hechos» counts (:671, :846): «ese día pedía cinco» counts the weekly rows too (corrected 2026-10-09).
  - The phone week draws a goal only when it has rows, and says «hechos» once, in its footer.
  - An empty section draws no label: no «cero compromisos», «cero fases», «abiertas» over nothing.
  - An archived goal with no task this month draws no month block.
  - A unit is said once in a figure pair («7 de 90 kilómetros»); a stored phase reads from week 1 at the earliest.
- **`SistemaPiezas.dc.html`, approved by the user 2026-10-06.**
  - A mixed line is a sentence in Archivo with only its figures, the unit glued to them, and its dates in mono, each kept
    on one line: «Día 21 · 5 h 24 min de 12 h, bajo el 60 %».
  - A measure's minutes take two digits after hours: «1 h 05 min», never read as «15».
  - A row's name wraps by words, never inside one; its trailing figure keeps one line and drops under the name when it
    does not fit.
  - One link style: accent, 15 / 500, no underline, underlined on hover and focus; never grey.
  - A selected chip is the accent's soft fill with an accent border; the full accent fill is the act's button alone.

- **Chips and paired fields are spaced by their primitives** (2026-10-06, decided by the orchestrator from the space
  system's multiples of 4). Chips in a row sit 8 apart and wrap by chip; the seven weekday chips sit 4 apart
  (`ChipRow`, `tight`). A field pair sits 8 apart, two fields sharing the width, or the first sized by the pair when
  it is narrow, a quantity beside its unit (`FieldPair`). No screen spaces either with `Flex gap` or `style`.

- **`MetaVerPlan`, states the board does not draw** (2026-10-06, decided by the orchestrator).
  - A goal with no rhythm: the row's first line reads «Armar el plan», with no second line; it still links to the plan.
  - A goal with no task in the plan: no «el plan» section.
  - The plan's end carries the year only when it is not the current year, as the rest of the screen does.

- **The plan's months, module 349** (2026-10-06, decided by the orchestrator):
  - A task past the goal's end appears only under «después de tu final», never again in the month holding its hours.
  - A month past the goal's last month with no rows is dropped.
  - A goal with no measure draws no figure and no bar on the plan's months.
  - «Añadir una tarea» opens the sheet with no «va a» hint.
  - A plan that ends on the goal's last day reads «A este ritmo terminas el {date}, el día de tu final.», never «0 días antes».

- **Eighteen boards of wave 3 and the roadmap's second round, approved by the user 2026-10-06: «si a todo».**
  `RoadmapMoverFinalHoja`, `RoadmapMoverFinalFallo`, `RoadmapHoyMovidoVarios`, `RoadmapMesCifras`, `MetaPlanHechas`,
  `FaseFechas`, `FaseFechasFuera`, `FaseFechasSolapa`, `ImportarFaseRecortada`, `EntrarFormulario`, `EntrarEnviado`,
  `PermisoSinSesion`, `PermisoConSesion`, `SueltaHoja`, `SueltaHojaHecha`, `ReportePlegado`, `ReporteImpresoMeses`,
  `PalabrasDelPlan`. Canvas version 69. Where a board and the lines above disagree, the lines above win.
- **`ReportePlegado`'s «Esta semana: [3 h] de [3 h].» keeps its second figure** (decided by the user 2026-10-06): it is
  the month's planned amount prorated by day over the week (RP-58, module 392). Until 392 lands the line reads the done
  figure alone. Options refused: owed over the remaining weeks (moves daily), dated tasks' estimates (empty for most goals).
- **The report's split week is one row** (2026-10-06, orchestrator, module 379): a week across two months reads its
  whole total once under the fold, no longer two halves.
- **`MetaPlanHechas` settles where «hechas» reaches** (2026-10-06, read by the orchestrator from the approved board):
  the goal's plan row reads «Ritmo 12 h al mes · en octubre, 5 h de 12 h en tareas hechas» (amended 2026-10-06, A3); the block «lo medido» keeps the measure («6 h 40 min de
  estudio en octubre», RP-28). Hoy's month line and «Mes» (RP-43) keep the measure this round. No code retired.
- **A fact before its goal opened is refused with «Ese día es anterior a cuando abriste esta meta.»** (2026-10-06,
  decided by the orchestrator; no board draws it).
- **The consent screen keeps its «may / never» lists under `PermisoConSesion`'s lead** (2026-10-06, decided by the
  orchestrator, module 381). The board draws the layout — centred, h1, «Podrá leer tus metas y anotar lo que hagas. Puedes
  revocarlo en Conexiones.», «Permitir» over «No permitir» — and not the removal of what a person reads before granting
  access. Signed out, the promise line under the form goes, as the board draws.

## Decisions of 2026-10-06, after the product critic of train 4 (module 393, decided by the orchestrator, no board)

- **On the plan with no rhythm, «Armar el plan» is the one solid act.** «Añadir una tarea» is outlined until the plan has
  a rhythm, then solid as built (:114). A goal with no measure draws no rhythm form, so its «Añadir una tarea» stays solid.
- **A sub-task's row on Semana says «de <parent>» as its second line**, Archivo muted, the pattern of
  `HoyTareaMesSubtarea` (:255). A top-level task or a suelta draws no second line.
- **«Mover el final» opens on the goal's own end.** The count it opens with names the goal's last day, and «Moverlo»
  untouched moves nothing. A count that is not 1–520 says why under the field as it is typed, the field ringed, as the
  phase form does (378).
- **An archived goal whose end passed reads «terminó el <weekday day month>»**, as an ended goal does (:612), never
  «N semanas · hasta el …». An archived goal whose end is still ahead keeps its weeks line.
- **What is in the import box when the screen answers is what is read.** Text typed before the page settles is kept;
  the stored draft fills the box only when it is empty. The box never changes under the person's hands.
- **Decided by the user 2026-10-06, after the product critic of train 4** (questions A–D and W4-Q2):
  - A. «hechas» on the plan is labelled as the done tasks it counts; Hoy, Semana and the goal's measure keep their own
    figures. The plan's figure never adds commitments' facts.
  - B. A suelta is a task with no goal. A goal's task with no day stays in its goal's plan, never on `/sueltas`.
  - C. «Armar el plan» keeps every month that already has an amount and spreads only the rest.
  - D. A closed month that did more than planned stays as it is; nothing is split into the next month.
  - W4-Q2. An imported task with sub-tasks and its own amount is left out, and the create bar says what stays out (RP-37).
- **Words of the boards of wave 4, approved by the user 2026-10-06 on the words, before the boards were drawn**
  («apruebo los tableros»). Drawn after, from these lines; where a drawing and these lines disagree, these lines win.
  - `HoySiguienteCifra` (394): one hour figure per row, never a 0. A whole task trails its estimate and reads «Siguiente
    del plan» with no figure; a task with no estimate trails «sin estimar», muted; a sub-task reads «de <parent>» above
    and trails its own estimate; a split task trails its estimate and reads «Siguiente del plan · 10 h este mes».
  - `MetaTotal` (399): under the measure figure, a quiet line «en total, desde el 24 de agosto» (date mono, year only
    when not the current one, as «de <year>»). «0 min» stays.
  - `ImportarFuera` (401): above «Crear 1 meta», one quiet line: «Sin «Elegir método» y su sub-tarea: no se puede
    crear.» for one item, «Sin 3 cosas que no se pueden crear.» for more, the count linking up to «No se puede crear». Decided by the orchestrator 2026-10-06 (module 401): a goal refused whole reads «Sin «<goal>»: no se puede
    crear.»; a task with several sub-tasks «Sin «<name>» y sus <n> sub-tareas: no se puede crear.»; a task with none
    «Sin «<name>»: no se puede crear.»
  - `MetaPlanHechas` and `RoadmapMesCifras` (405): «Ritmo 12 h al mes · en octubre, 5 h de 12 h en tareas hechas»;
    the current month «5 h de 12 h en tareas hechas»; a later month keeps «12 h planeadas de 12 h».
  - `HoyTareaDeMeta` (408): the field at a goal's foot is labelled «Una tarea de {goal}»; on «sin día» it answers
    «Anotada en el plan de {goal}.» with «ver el plan»; an empty name answers «Escribe qué hay que hacer.». The goalless
    field keeps «Algo suelto». Boards `HoyTareaDeMeta`, `HoyTareaDeMetaAnotada`, `HoyTareaDeMetaVacia` drawn 2026-10-07 and
    approved by the user that day: the empty field's placeholder reads «Una tarea de {goal}…», the link «ver el plan»
    in lower case.
  - A goal's task with no day is a task of the goal's plan: it never shows on `/sueltas`, never counts in «N sin día»,
    and Hoy never calls it suelto (RP-59).

## Decisions of 2026-10-08, after the pulsar audit

- **The consent screen names where it sends you back** (B2, approved by the user 2026-10-08, boards `PermisoDominio` and
  `PermisoDominioLocal`). Under the h1, in mono 13 px, ink colour: «al permitir, vuelves a **claude.ai**» — the
  `redirect_uri`'s host, with its port when it has one (`localhost:33418` for Claude Code), never the path. It sits
  between the h1 and the lead, before the «may / never» lists and the buttons. Signed out nothing changes:
  `PermisoSinSesion` names neither client nor domain, since nothing is validated before sign-in.

## Decisions of 2026-10-08, after the product critic of the audit slice

Taken by the user on the critic's questions. No board drawn yet; each one opens its module with a board first.

- **Each connection row names where it sends you back.** «Claude · vuelve a claude.ai»: the grant's `redirect_uri`
  host, as the consent shows it. Two rows named «Claude» are told apart by host. Not trusting the registered name in
  the consent's h1 when the host is not claude.ai is a later step, not taken.
- **Keys that no longer enter fold away.** A lapsed or revoked key older than 30 days folds under «N llaves que ya no
  entran»; nothing is deleted (RP-38). A lapsed key says «crea otra».
- **A loose task on today moves from Hoy.** The Hoy sheet of a suelta gains «Darle otro día», the same step `/sueltas`
  already has. A code succeeding RP-57.
- **The plan is for goals measured in time.** «El plan» (rhythm and roadmap) is offered only to a goal whose unit is
  time; a goal in km or pages keeps its month amounts and no roadmap. A code narrowing RP-50.
- **The template carries a rhythm.** `ritmo: 12 h` in `PLANTILLA.md`; the import writes the goal's rhythm, so an
  imported plan arrives armed. A code next to RP-37.
- **Hoy counts every row that asks today**, flexible and evidence rows included, in «hechos N de M».
- **Row metadata in plain days.** «mar y jue · 2 h»; «pide el número» goes.
- **The key screen's sample sentence is generic:** «lee mis metas y dime qué sigue».
- **Yesterday is a word.** «‹ ayer», hidden before the first day that has a goal.
- **Tasks of a goal not measured in time are fixed to the month they are created in**; the person moves them by hand.
- **Codes.** RP-62 narrows RP-50 (RP-50 stays); RP-64 opens for the host on each connection row and the folding of dead
  keys (RP-60 and RP-38 stay). The 30 days count from when the key stopped entering (lapsed or revoked).
- **Claude Desktop gets a copyable `claude_desktop_config.json`** running `npx mcp-remote` with the key in a header;
  RP-38 stays true.

## Decisions of 2026-10-09, the boards of the product critic

- **The 19 boards are approved as drawn** (user, 2026-10-09, canvas version 84): `ConexionesConDominio`,
  `ConexionesPlegadas`, `ConexionesPlegadasAbiertas`, `ConexionesVencidaCreaOtra`, `ConexionesCreadaDesktop` (446, 448);
  `PermisoPalabras`, `FuenteCaidaPalabras` (580); `HoyDia` (574, 590, 591); `HoyAyerPrimerDia` (590); `HoySueltaMover`,
  `HoySueltaMoverDia` (575); `SemanaHoyEvidencia`, `SemanaHoyEvidenciaOscuro` (576); `ReporteFuenteCaida`,
  `ReporteTareaParte` (578); `ReporteImpresoCompacto` (579); `MetaSinPlan`, `MetaSinPlanTareas` (583);
  `ImportarRevisarRitmo` (586). Each board's own note carries its words and what it takes for granted.
- **`ReporteTareaParte` says only «sigue en».** The plan always starts in the current month, so a month's report never
  receives a part carried from before; there is no «viene de».
- **A goal with no measure keeps «El plan»** (user, 2026-10-09, module 583). Only a goal measured in a unit other than time
  loses it: its `/metas/<id>/plan` redirects to the goal. A goal with no measure estimates its tasks in hours, as before.

## Decisions of 2026-10-09, after the slice-close critic

Taken by the user the same day («elige el recomendado», `private/plan-cierre-2026-10-09.md` Part 2). Each one waits on its
module; until it lands, the screen and its approved board stay as built.

- **A done task adds its figure only to a goal measured in time.** In a goal measured in km or pages a task carries no
  figure: its sheet asks no estimate and Hoy never says «sin estimar». RP-36 retires for a successor in the module that
  builds it.
- **Hours are time.** `horas`, `hora` and `h` are accepted as a goal's unit and stored in minutes, so such a goal keeps
  «El plan».
- **An imported `ritmo:` moves the plan.** With `ritmo:` in the template, each task goes into the plan and its month only
  orders it; the review lets the person change the rhythm like any other amount. Needs a board.
- **Semana marks today with its own tint at 1440**, distinct from the card and from the evidence fill, checked for
  contrast in both faces. Needs a board. The step back reads «‹ semana anterior», as Hoy reads «‹ ayer».
- **Claude Desktop connects like claude.ai**, as a custom connector to `/mcp` with the OAuth consent, if the person's
  Claude plan allows custom connectors; otherwise the `mcp-remote` file stays and says where the file lives in each
  system, that it merges with other servers and that it needs Node.
- **`PermisoPalabras` and `FuenteCaidaPalabras` are redrawn.** The consent lists only acts that exist: «darle mes o día a
  una tarea, devolverla al plan y cambiar el monto de un mes», and «nunca» gains «cambiar el ritmo» (RP-56). An evidence
  row under a fallen source says what it asks and that the source was not read.
- **The connections section on `/conexiones` reads «conexiones»**, not «claude.ai»; each row already says where it
  returns.
- **The report:** the table header reads «por mes | hecho | planeado», as `ReporteImpresoCompacto` draws it; «HECHO km»
  stays; the month's tasks stay a full list and every open task says it is pending; A4 is the app's promise, and the
  tests print with the app's own `@page`.
- **A goal's month line says tasks in tasks** («0 de 4 tareas») next to the measure's figure, so the two are not read as
  the same number.
- **The harness registry learns OAuth clients**, so `harness:reap` deletes the ones a test registers.
- **Deploy when this cut closes.**

## Decisions of 2026-10-09, the boards of the slice close

- **The four boards are approved as drawn** (user, 2026-10-09, canvas version 91): `HoyTareaMesSinPlan`,
  `HoySueltaMoverArrastrada`, `ConexionesVencidaSinUsar`, `ImportarErrorLinea`.
- **The person's Claude plan allows custom connectors** (user, 2026-10-09). Claude Desktop connects like claude.ai: the
  desktop section says «agrega un conector con esta dirección» and the `mcp-remote` JSON goes (module 672).
- **RP-30 retires for RP-68** (user, 2026-10-09): a task carries an estimate only in a goal measured in time.
- **«Darle otro día» offers no «sin día»** (orchestrator, 2026-10-09, module 654). `HoySueltaMoverArrastrada` draws four
  chips ending in «sin día»; RP-61 moves a one-off «to any day from today on», so the chip stays out and the step offers
  «hoy», «mañana», «otro día». A one-off on today opens on «mañana»; a carried one opens on «hoy».

## Decisions of 2026-10-10, after the train-5 critic

Taken by the user the same evening, on the critic's four questions. Boards `ImportarCabeceraRota`, `ImportarPrimeraLinea`,
`ImportarErrorMarcaLinea` and `ReporteImpresoTablaLarga` approved as drawn by the user 2026-10-10.

- **(1) A broken header cuts the reading and says so.** A header line the reader cannot take (a measure without its
  unit) shows that one error, with its own message, and «Arréglala y vuelve a leer: las líneas de abajo no se pudieron
  leer.» The lines below are not judged. All-at-once (RP-72) holds for everything after a sound header.
- **(2) A first line that starts with «pulsar ·» and is not «pulsar · plantilla 1» is refused here, never sent to the
  model.** The message names the line: «La primera línea va como «pulsar · plantilla 1».» Text that does not start with
  «pulsar ·» still goes to the AI reading.
- **(3) Label, table and months-left-out line stay together only when the table fits a page.** A table of 15 rows or more (20,
  lowered to 15 after the train-6 critic) starts on the page it reaches and flows; its label stays glued to its first rows. Refines decision (2) of the train-4
  critic for long tables only.
- **(4) Tapping an error selects its line in the box.** After a reading with errors, focus goes to the list; each error is
  a control that selects its line in the textarea and scrolls it into view. No line-number gutter.

## Decisions of 2026-10-10, after the train-6 critic

Taken by the user the same evening. No board: they move a page break and name a cause; nothing new is drawn.

- **A goal whose «por mes» table prints whole (8 to 19 rows) keeps its name, measure line and figures on the table's
  page.** The head never ends a page without its table.
- **A «por mes» table of 15 printed rows or more flows (was 20): a goal's head never ends a page alone.** Taken by the
  user 2026-10-10.
- **An over-long goal name says so:** «El nombre de la meta va en 120 caracteres o menos.» It no longer reads «Falta el
  nombre de la meta».
- **Accepted as is:** a long table's last page may hold one row, its head and the months-left-out line.
- **Taken by the orchestrator, no question:** tapping an error scrolls the page so the box and its line are on screen,
  also with the keyboard up (the approved «scrolls it into view» meant the screen, not only the box).

## Decisions of 2026-10-11, after the train-8 critic

Taken by the user the same day, on the critic's three questions and two from the workers. Boards still to draw: the
«unit once» screens and the paper line.

- **A goal's first and last month plan their share of the rhythm, by the goal's days, as the week does:** a goal from 16 sep to
  7 oct with 10 h a month plans about 7 h 15 min, not 20 h. On the goal's card, `/meses`, `/exportar` and paper.
- **«The unit once, at the end» reaches every figure followed by «de»:** «30 de 60 búsquedas» on `/metas`, the goal's card,
  `/meses`, `/mes`, `/exportar` and the week line. A figure with no «de» keeps its unit: «45 búsquedas · sin monto».
- **On paper, a time goal with no rhythm says its months' tasks on the left-out line:** «sin monto · 1 tarea» (RP-73 on paper).
- **«sin monto» may wrap at 1024 on `/meses`** rather than push the row's chevron out: the «one line» rule gives way there.
- **`/exportar` on screen says «sin monto» on a month not yet begun with no amount,** for every goal, in the planned
  column; a goal measured in time with no rhythm names each month's tasks under its state, like `/meses` («en curso» /
  «2 tareas»; «1 tarea» alone in a future month), never «0 tareas» and never a trailing «·». Correr (km) and a goal with a
  rhythm count no tasks. A started month with no amount keeps its done figure alone (844). The printed row carries its tasks;
  the left-out line does not change. Board `ReporteFilasSinMonto` approved by the user 2026-10-11 (option B, RP-77).
- **«hs» reads as hours,** in the template and in the rhythm's «otra» field: «8 hs».
- **Text the «otra» field cannot read says how to write it,** not the range: «8 hss» → «Escríbelo como 8 h, 1 h 30 min o
  90 min.» Text it reads but out of 1 min–744 h keeps the range error. Decided by the orchestrator 2026-10-11 (module 853).
- **No rhythm notice names an end when no pending task has an estimate.** First rhythm: «Con 8 h al mes. Ninguna tarea
  tiene estimación todavía: van a octubre de 2026 hasta que les pongas una.» The sheet: «Con 12 h al mes. Ninguna tarea
  pendiente tiene estimación: van a octubre de 2026 hasta que les pongas una. Los meses que ya cerraron no cambian.» The lead
  of `/plan`: «Ninguna tarea pendiente tiene estimación: van a octubre de 2026 hasta que les pongas una.» The month is the
  first the plan places them in, with its year. One estimated task keeps today's notice. Board `RitmoSinEstimacion`
  approved by the user 2026-10-11 (module 854).
- **Approved the same day:** board `UnidadUnaVez` as drawn (`/metas`, the goal, `/meses`, a month, `/mes`, Hoy, `/exportar`);
  board `ReporteImpresoTareasFuera` option A — one line per group of months by task count («noviembre de 2026 y enero de 2027:
  sin monto · 1 tarea», «diciembre de 2026: sin monto»), the month with «de» in that sentence; option B is discarded.
- **`/metas` on the phone shows the month's figure** in each goal's row, unit once, under the name and above «hasta el …»:
  «octubre · 30 de 60 búsquedas»; no amount keeps its unit («octubre · 18 búsquedas»); no measure, no figure. Board
  `MetasConCifra` approved the same day.
- **The shared month (first and last) reaches every reader** — Hoy, `/mes`, a connected AI — **and the plan fills it with its
  share** («A este ritmo terminas el…» moves later for a goal opened mid-month). RP-74; RP-71 retired for RP-75.
- **Taken by the user later the same day:** the line «Ritmo X al mes» always says the whole rhythm the person set
  («Ritmo 10 h al mes»), never the first or last month's share; only the month's figures carry the share. On `/metas` on the
  phone, a goal that counts tasks keeps «octubre · 1 de 3 tareas» under its name, though `MetasConCifra` does not draw it.
- **A first-month share that rounds to 0 draws no figure on Hoy** (taken by the user the same day): a 20 km rhythm opened on
  the 31st reads on Hoy as a month with no amount, never «ESTE MES 0 de 0 kilómetros». The goal, «Por mes», `/exportar` and
  paper keep the 0, as RP-74 rounds it.
- **After the train-9 critic, taken by the user the same day:**
  - The goal's card and the month page say why a first or last month plans a share, in one muted line:
    «desde el 7: 8 h 03 min de tus 10 h». Not on `/metas`, Hoy or the other readers. A new phrase: on a board first.
    Board `ParteExplicada` (goal 360/1280, month page 360/1280, a whole month with no line) approved the same day.
  - On `/meses` a time note that does not fit beside its month drops whole under it, as on paper (`wholeNote`). It never
    splits («de / 8 h / 03 / min») and never pushes the chevron out of its row, at any width.
  - Every screen reads a share that rounds to 0 as «sin monto», never «0 min de 0 min»; only paper keeps the 0
    (RP-76, retiring RP-74). This widens the Hoy-only rule above.
- Decided by the orchestrator 2026-10-11, for `ParteExplicada` wording the board did not draw: a last month that ends before the month's end reads «hasta el 7: 2 h 15 min de tus 10 h»; a goal opened and ended in the same month reads «del 7 al 20: … de tus 10 h».
- Decided by the orchestrator, from rules already taken: a goal that has ended has no month «en curso», no «ESTE MES» and no
  «faltan N días»; `/meses` does not ask a goal with a rhythm to plan a month; every month in the rhythm's preview carries its
  year; one «mover el final» link for open and ended goals.

## Decisions of 2026-10-11, after the train-7 critic

Taken by the user the same day, on the critic's questions and two of the planner's.

- **Every figure's unit goes through the `units.words` catalogue on screen**, as «mide en» already did: «0 búsquedas de 60
  búsquedas», never «searches». On `/meses`, the month, the weekly review, `/exportar` and `/mes`.
- **A goal's last week ends on its last day and is not «en curso» once the goal has ended:** «5–7 oct», on the weekly review and
  the report alike.
- **The week line's planned figure takes its share of the rhythm** when the month has no amount of its own, as it does of a
  month amount: «Esta semana: 0 min de 2 h 42 min.» (RP-58 as written.)
- **A `.md` read with template errors puts its text into the box.** The live list and a row's tap work as for pasted text; the
  file's name moves to a note. This revokes «A list read from a file does not re-read» of 2026-10-10.
- **«Always the year» reaches the import's review** (each task's month, the start date; the horizon is said once) **and the
  weekly review's ranges** («5–11 oct 2026»).
- **When a text with a list stops being a template, the box says so** and says the plan will be read by the AI, before «Leer el
  plan». A new phrase, on a board.
- **«Por mes» counts the tasks of a goal measured in time with no rhythm** (RP-69 retired, RP-73). With a rhythm, the plan
  still counts them.
- **A goal's first rhythm keeps returning its fixed tasks to the plan** (RP-50 stands). The rhythm's preview says the end the
  click really leaves.

- **Boards approved 2026-10-11:** `MesesFuturoYTareas`, `RevisionConAño`, `ImportarArchivoYAviso`, `ImportarRevisionConAño`.
  - A row of «Por mes» in a unit other than time says its unit once, at the end: «0 de 60 búsquedas», «20 de 40 km».
  - A future month with an amount says «planeado» and the amount alone, a link while the goal is open: no «0 km», no «de».
  - A row that names its tasks breaks its label in two lines with no dangling «·»: «en curso» over «2 tareas». The km goal's
    «planeado · 1 tarea» follows.
  - The weekly review's range sits on one line under the week («5–11 oct 2026»); a range across a year pushes its figure right
    rather than wrap every row.
  - The import's review: the goal's line says «Desde el 11 de octubre de 2026»; the end date lives in the horizon's row alone.
    Months read «octubre 2026», phases carry the year at both ends.
  - Words: «Leído de plan.md. Corrige aquí y vuelve a leer.» under the box while a file's list stands; «Ya no es la plantilla: la
    primera línea no empieza por «pulsar ·». «Leer el plan» lo mandará a la IA.» With the AI closed there is no second notice:
    the screen cannot know before the press, and «La lectura con IA no está disponible ahora…» answers it.
  - Not drawn: dark faces (the token table says what dark is); the import's review at 1024 with two goals, broken today
    (columns at ~80 px, text broken letter by letter) — 820 lays it out as at 1280.

## Decisions of 2026-10-10, after the train-6 findings

Taken by the user the same evening, on six questions. Boards `MesesConAño` and `ImportarErroresVivos` were drawn and approved before their modules.

- **The months table's first column reads «mes»**, on screen and on paper, with a measure and without. The label above it
  already says «<goal> · por mes». Replaces «por mes | hecho | planeado» of 2026-10-09.
- **The report's week names its days when the goal does not fill it:** «Esta semana, desde el sábado: 34 km de 2 km.», «Esta
  semana, hasta el miércoles: …», «Esta semana, del sábado al martes: …». The figures stay RP-58's; a goal that opens and ends the same day says «Esta semana, el sábado: …».
- **«Por mes» and a month's title carry the year, always:** «octubre 2026», «Diciembre 2026». Sentences that name a month
  beside its title («Planear octubre», «¿Cuánto en octubre?», «de octubre») keep the month alone.
- **The import's error list follows the box.** After a reading with errors, every change to the text re-reads the template in
  the browser, with no request: a fixed line leaves the list, a new broken one joins it in its place, the cut's line goes when
  the header is fixed, and the list goes at zero. A list read from a file does not re-read.
- **The template keeps refusing a task's figure in a goal that does not measure time**, and says what to remove: «Quita la
  cifra de esta línea: esta meta no mide tiempo.» The AI reading still drops it with «se crea sin cifra».
- **Not reopened:** the goal says «mide en km», the paper «mide distancia, en km» (1b above stands).
- **Board `MesesConAño` approved, option B:** the narrow table's label column grows from 100 to 112 px, so «septiembre 2027» fits on one line; no row of «Por mes» wraps at 360 or in the 320 column at 1024.
- **Board `ImportarErroresVivos` approved as drawn:** four states (read; a fixed line leaves and the count drops; a fixed cut header drops the notice and shows the lines below; zero errors drops the list and the box's mark). No new phrase.

## Decisions of 2026-10-10, after the train-4 critic

Taken by the user the same evening, on the critic's four questions.

- **(1) The months a paper leaves out always carry their year:** «diciembre de 2026, enero de 2027 y febrero de 2027: sin
  monto». No ranges, no count. RP-71 already says every printed date carries its year; the line now obeys it.
- **(2) A goal's «por mes» label, its table and its months-left-out line stay together on paper.** A blank at the foot of a
  page is the accepted cost; a table longer than a page still breaks.
- **(3) The import accepts the goal's unit on every line that carries an amount, and shows every error at once.** A
  commitment written «8 km» under a km goal passes like a month; under a goal in another unit the message names the unit
  that goes. One reading lists all the template's errors, not the first. Board `ImportarTodosLosErrores` approved as
  drawn by the user 2026-10-10: **RP-72**.
- **(4) A goal with no measure prints its months on paper:** a «por mes» table of its tasks, done and to do. RP-71 already
  promises «its months» for every goal. Board `ReporteImpresoSinMedida` approved as drawn by the user 2026-10-10:
  TAREAS instead of HECHO, «N de M hechas» or «N por hacer», and «…: sin tareas» for the months left out.

## Decisions of 2026-10-10, after the part-3 critic

Taken by the user («1. b 2. b 3. b 4. a»); questions 2 and 3 are voyager's.

- **(1b) The paper names a goal's measure with both its name and its unit:** «mide Práctica, en horas y minutos»,
  «mide distancia, en km». The goal screen keeps «mide en horas y minutos».
- **(4a) The paper says which months it leaves out.** A line under the goal's «por mes» table names the months not
  printed (not started, no amount), e.g. «diciembre y enero: sin monto»; the table's count counts printed months only.
  It refines RP-70 (2026-10-09): the months still do not print, but the paper no longer hides that they exist. Board
  `ReporteImpresoMesesFuera` approved as drawn by the user 2026-10-10; RP-70 retired for **RP-71**.
- **Taken by the orchestrator, the same day, no board (they fix what boards already draw):**
  - A weekdays cadence reads Monday first and joins with «y» on every screen (goal, import review, Hoy).
  - A km goal's month block carries its unit («34 km de 120 km»); «N tareas» never splits from its number.
  - A month with no planned amount shows «sin monto planeado» alone; a month that is not the current one never says
    «este mes».
  - The import accepts a month amount written with the goal's own unit («- 2026-10 · 8 km»), and names the unit when
    another is written.

## Decisions of 2026-10-09, the boards of Part 2

Taken by the user the same evening («1. si 2. b 3. a 4. a 5. a 6. a»), on canvas version 94.

- **The eleven boards of Part 2 are approved as drawn:** `HojaTareaSinCifra`, `MesTareaNuevaSinCifra` (663),
  `ImportarRitmoPlan` (669), `SemanaHoyTinte` (670), `SemanaPasoAtras` (671), `ConexionesSeccionConexiones`,
  `ConexionesDesktopConector` (672), `PermisoPalabrasActos` (673), `FuenteCaidaQuePide` (674), `ReporteTareaPendiente`
  (675), `MetaRitmoTareas` (676). `PermisoPalabras`, `FuenteCaidaPalabras`, `ImportarRevisarRitmo` and
  `ConexionesCreadaDesktop` go to «Archivo» the day their successor's module lands.
- **`--pulsar-today`** is `#e3e8ee` light and `#1e252c` dark, as `SemanaHoyTinte` measures it (670).
- **With `ritmo:`, the review's task rows say «va al plan · desde octubre»**, not the month alone (669).
- **The connector address shows on the main `/conexiones` screen only**, not again after a key is created (672).
- **The report's month state moves under the month's name** («cerrado · 25 % pasó a octubre», «en curso»), since the third
  column now carries the plan (675).

## Decisions of 2026-10-09, after the critic of Part 2

Taken by the user the same night («todo lo que recomendaste»).

- **Under a rhythm, a task's written month only orders the tasks** (686). The review says «va al plan», never «desde {month}»,
  and a parent's second line drops the month («la suma de lo marcado»). This replaces «va al plan · desde octubre» above.
- **A month amount coexists with the rhythm, and says so** (687): under a rhythm, a month with its own amount reads «en lugar del
  ritmo», in the review and on the goal's month block.
- **`/plan`'s month header counts tasks** (688): «1 de 3 tareas hechas», as the goal does since 676.
- **The rhythm runs from 1 min to 744 h a month** (orchestrator, 689), and its error says so in hours.
- **No boards drawn for 686–689 before the code:** the user chose to review every app at the end. The canvas gets the built
  screens at slice close.

### The canvas at slice close, 2026-10-09

- **Version 95 carries the built Part 2 as real captures** of `integracion` c021347b: the eleven approved boards, plus
  `ImportarRitmoHoja`, `RitmoTope`, `ImportarCifraSinTiempo` (686, 689), `MetaMesEnLugarDelRitmo` (687) and `PlanMesTareas` (688).
- `PermisoPalabras`, `FuenteCaidaPalabras`, `ImportarRevisarRitmo` and `ConexionesCreadaDesktop` are in «Archivo».
- **`ConexionesDesktopConector` is the capture, not the drawing:** after a key is created there is no Claude Desktop section.
- **Boards still drawn though built:** `HoyTareaMesSinPlan` (656), `HoySueltaMoverArrastrada` (654), `ConexionesVencidaSinUsar`
  (657), `ImportarErrorLinea` (659). Their captures are owed.

## Decisions of 2026-10-09, after the critic of Part 3

Three answers of the user, 2026-10-09.

- **RP-49 is retired for RP-70 (2026-10-09, user).** On paper a month that has not begun and has no planned amount does not
  print; past months, the current one and the planned ones do. On screen and to a connected AI every month stays.
- **RP-69 opens (2026-10-09, user).** A goal measured in km or pages says this month's tasks on its own screen, «1 de 3 tareas
  hechas», and «Por mes» counts them beside each month.
- **The two changes of form take a board before the code (2026-10-09, user):** `MetaKmTareas` (722) and
  `ReporteImpresoSinMesesVacios` (725). Both approved as drawn (user, 2026-10-09, canvas version 97).
- **A measure in time reads «mide en horas y minutos»** (orchestrator, 2026-10-09). It replaces «mide en {unidad}» above for
  time only; every other unit keeps «mide en {unidad}».
- **The empty month of a goal that does not measure time promises no time** (orchestrator, 2026-10-09, 723).
- **Built without a board, for the user's review at the end:** 720, 721 and 723 (see «The boards that do not exist»).

## Decisions of 2026-10-12, the hierarchy boards

- **The boards of the goal hierarchy are approved** (RP-78–RP-85, RP-95). Drawn 2026-10-12 as captures of the real app with a
  throwaway patch and a sample plan, approved by the user the same day: «si». Page «Metas y una meta»: `JerarquiaArbol`,
  `JerarquiaMetaGeneral`, `JerarquiaMetaGrande`, `JerarquiaMetaPequena`, `JerarquiaCrearDentro`, `JerarquiaMover`,
  `JerarquiaArchivar`, `JerarquiaFinRechazado`, `JerarquiaOtraUnidad`; page «Hoy»: `JerarquiaHoy`. Words and structure per
  board: `private/tableros-jerarquia/NOTAS.md`; the patch: `private/tableros-jerarquia/jerarquia.patch`.
- **Every row of one tree level shares one left edge.** A row without a fold chevron reserves its width; at 360 the general goal
  sits at 52 px, a large goal at 72 and a small goal at 92.
- **Moving a goal picks one destination** from a single-choice list; a destination that cannot take it stays listed, dimmed,
  with its reason. `CheckRow` gains a `radio` prop for it. The board's «Empieza el …, y «…» arranca antes» is superseded by
  P1 = B: no destination is refused for its start, since a goal that holds goals starts with its earliest goal.
- **A level is a position, not a kind**: a goal is large because it sits under a general one.
- **A month a holder's goals do not cover reads «sin monto».**
- **A general goal keeps its own commitments** in the commitments section it always had.
- **A Hoy line names only the goal it comes from**, never the chain. Groups that ask something today come first; inside, the
  tree's order.
- **Reopening a goal reopens what was archived with it**, not every goal of the branch; a goal under an archived one cannot be
  reopened alone. An archived goal adds nothing to the goal above.
- **The second batch is approved** (RP-80, RP-84, RP-95), 2026-10-12, by the user: «apruebo los tableros». Page «Metas y una
  meta»: `JerarquiaNota`, `JerarquiaPorMes`; page «Mes»: `JerarquiaMes`; page «Exportar»: `JerarquiaInforme`. Words and
  structure: `private/tableros-jerarquia/NOTAS.md` §10–13.
- **A goal's note is the task note's sheet with other words**: placeholder «Lo que quieras recordar de esta meta», cap 100 000,
  the count from 90 000. Emptying it and saving removes it; it is never stored empty. It sits between the end line and «Archivar
  esta meta», folded; with no note, «Agregar una nota» (outline, full width) stands in its place.
- **A goal that holds goals has no rhythm of its own.** «El plan» replaces «Horas al mes», the chips and «Armar el plan» with
  «Este plan no tiene ritmo propio. Cada mes suma el de sus metas.» and one row per goal inside; its own tasks stay, by month.
- **The report and the paper group by general goal**, the loose goal as its own group. Superseding `JerarquiaInforme` where it
  differs: the paper prints the goal's note whole and every goal inside whole (its months, its phases), with no page cap. The
  screen keeps the board's one line per goal inside.
- **Boards that do not exist**: the dark face of every hierarchy board (the token table's); «Por mes» and «Mes» grouped at 1280
  (the list and the card they always had); the paper's note (drawn by no board; it prints as the screen's text, whole).

## Decisions of 2026-10-13, the chat (RP-91–94, RNP-21), by the user

- **P1 — The way in is an icon at the right end of every screen's header.** The four tabs and the rail stay as RNP-16 and
  RNP-17 say; nothing is retired. No fifth tab, no floating button.
- **P2 — «Hacer todo» makes every change it can.** A refused change stays marked with its reason; the others are made.
  Never all-or-nothing.
- **P3 — The chat proposes only over what exists.** A change never names a goal another change of the same message creates;
  the person asks for the next step after «Hacer».
- **P4 — One line under the field, always,** says the message and the parts of the plan it reads go to OpenAI.
- **P5 — The chat answers questions about the plan too,** from the same reads (RP-39). Each question is one of the fifty.
- **P6 — An untaken change lapses when the next message is sent:** it reads «sin hacer» and has no button.
- **The chat boards are approved** (RP-91–94), 2026-10-13, by the user: «Apruebo tal cual». Page «Chat» of the canvas, 15
  captures of a prototype: `ChatVacio`, `ChatEnviando`, `ChatRespuesta`, `ChatPropuesta`, `ChatPropuestas`, `ChatHecho`,
  `ChatRechazada`, `ChatFallo`, `ChatTope`, `ChatSinClave`, `ChatEscritorio` (1280) and `ChatEntrada` (Hoy and Metas, 360 and
  1280). Words and structure: `private/tableros-chat/NOTAS.md`.
- **On a screen whose header carries a steps row** (Semana, a day), the chat icon sits at the right end of the title row; the steps keep their two edges. 2026-10-13.
- **The field lives in the flow,** below the last turn, never fixed to the foot. The tab bar stays the only fixed thing.
- **A failed message stays as a turn;** the button reads «Intentar otra vez» and nothing is retyped.
- **A refused change has no button.** Its row carries the act's reason; the person asks again in a new message.
- **Turns are labelled «TÚ» and «GOALLOG» (2026-10-15, after the rename to GoalLog),** no bubbles, no left/right alignment. «Hacer todo» shows only with two or more
  changes open. A change reads in two lines: what, in the person's own names; then «antes → después» in mono.
- **Faces not drawn for the chat:** dark (the token table says it) and 700–1023 (between the two drawn).
- **A change's line keeps the screens' words:** «Mover el final de «Meta»», «Fijar «Tarea» en noviembre». The other 14 stay as they read. 2026-10-13.
## Decisions of 2026-10-13, after the critic of the hierarchy and the import, by the user

- **A goal that holds goals and measures nothing reads in its goals' unit on `/metas`,** as its own screen already does
  («0 min de 11 h», never «0 de 660»). Nothing stored changes.
- **Picking a file on `/metas/importar` only attaches it.** «Leer el plan» sends it; no paid read starts on a pick.
- **Creating a goal inside one with a rhythm says so in one line before «Abrirla»,** and the new goal takes the measure of the
  goal above it, so its rhythm can carry the sum.
- **«Loses nothing» (RP-96) means every line the model leaves out goes, verbatim, into the general goal's note before the
  review.** Built 2026-10-13, module 903.
- **The model puts tasks under the goal they serve,** and the check step flags a goal with a rhythm and no tasks while the goal
  above holds tasks; the person decides. Measured again on the real roadmap (one paid read). Built 2026-10-13, module 903.
- **The fix boards are approved,** 2026-10-13, by the user: «Apruebo tal cual». Page «Importar»: `ImportarAdjunto` (a picked file
  named with «Quitar», nothing sent until «Leer el plan»; after a refused type the file stays named and the type's sentence stays);
  page «Metas»: `CrearDentroAviso` (muted line before the buttons: «El ritmo al mes de «{name}» deja de contar; la meta nueva mide
  como ella.», only when the goal above has a rhythm) and `MetasUnidadArbol`. Words: `private/tableros-f1/NOTAS.md`.
- **A file attached with text in the box:** «Leer el plan» reads the file, and one line under the file says «Se lee el archivo; el
  texto de la caja no se envía.»
- **A plan created with parts that were not written** (RP-90), 2026-10-13, by the user: option A, `ImportarCreadoConFallos`
  (page «Importar»). The review route becomes «Plan creado»: one sentence with the count, section «NO SE ESCRIBIÓ», one row per
  part (its name, where it went, what to do), «Ir a Metas» full width. Corrected from the board: rows carry no checkbox, and each
  reason says what happened and what to do in plain words, never «la tabla». With nothing failed, «Crear» goes to Metas as before.
  The list lives in the tab (`sessionStorage`, from `lib/`) until «Ir a Metas»; a reload keeps it. `ImportarCreadoConFallos-B`
  goes to «Archivo».

## Decisions of 2026-10-13, the critic's «thin» items, by the user

- **The PDF opens with a summary, then the annex.** Page one lists every goal in one line each (its month and its week); behind
  it, the detail as today, whole (the 2026-10-12 «no cap» decision stands for the annex).
- **An imported note is clean text.** The import strips list marks, `**` and headings from note lines; a line marked «HECHO» or
  `- [x]` creates its task already done on its date, and the review shows it as done.
- **The 1280 rail draws the tree:** each general goal with its goals indented under it, folding as `/metas` does.
- **The review's sheets change more than names:** a commitment's cadence (days or times) and amount; a goal's horizon.
- **Moving a general's end offers to move its branch:** the sheet says how many goals end after the new end and offers «Mover
  también sus finales»; one tap moves them all. Every end date shows its year.
- **The five boards are approved,** 2026-10-13, by the user: «Apruebo tal cual». `ExportarResumen` (page «Informe»),
  `ImportarHojas` and `ImportarNotaLimpia` («Importar»), `MoverFinalRama` («Metas»), `RielArbol` («Armazón»). Words and structure:
  `private/tableros-delgado/NOTAS.md`.
- **The day chips are 40 px,** so the seven fit one row at 360 (7 × 40 + 6 × 4 = 304), everywhere `Chip day` is used.
- **A general's end never moves alone past its goals' ends** (RP-79): «Mover también sus finales» is the only way to shorten it.
- **An imported «HECHO» line becomes a done task and leaves the note;** it is never written twice.
## Decisions of 2026-10-13, the review of a long plan (module 902), by the user

- **Option A,** `ImportarRevisionLarga` (page «Importar»): every goal is one row with its summary (tasks, commitments, months,
  «N por revisar») and «Sus partes» folded under it; inside, each month folded. 1 632 px at 360 for the real roadmap, from
  74 690. Option B (one goal at a time behind chips) goes to «Archivo».
- **«SIN LUGAR EN EL PLAN» is grouped by the section of the person's own text** (its heading: «Presupuesto de horas por mes»,
  «Fuentes»…), each group folded with its count. Never by form (table row, link, title).
- **A goal with corrections still to decide arrives open;** the others arrive folded.
- **The goals under the general stay at their level, indented,** each with its summary; they never fold inside the general.
- Words and structure: `private/tableros-revision/NOTAS.md` §A, with the three decisions above where it differs.
- **Every plan's review arrives folded,** short or long, 2026-10-13, by the user: one rule, whatever the length. A goal opens on
  its own only when it has corrections to decide. `ImportarArbol` (drawn unfolded) gives way to `ImportarRevisionLarga` for that.

## Decisions of 2026-10-13, goals with no end, loose habits, a rhythm in any unit (RP-99–102), by the user

- **The boards are approved,** 2026-10-13, by the user: «Apruebo tal cual». Canvas page «Sin final y hábitos», four boards by
  area (`SinFinalMetas`, `SinFinalPlan`, `SinFinalDias`, `SinFinalInformeImportar`), holding `MetasSinFinal`, `MetaNuevaSinFinal`,
  `MetaSinFinal`, `FinalQuitarPoner`, `HabitosSueltos`, `MetaRitmoUnidad`, `PorMesRitmoUnidad`, `PorMesSinFinal`, `HoyHabitoSuelto`,
  `HoySinFinal`, `SemanaHabitoSuelto`, `MesHabitoSuelto`, `InformeSinFinal`, `ImportarSinFinal`. Words: `private/tableros-sin-final/NOTAS.md`.
- **The loose habits are «Hábitos» everywhere:** the group on Hoy, Semana and «Mes», and the section on `/metas`. Never «Sin meta».
- **A goal with no end prints the same twelve months the screen shows** (the current one and eleven after).
- The user's answers P1–P11 are at the end of `private/plan-pulsar-sin-final-2026-10-13.md`; the spec carries them (RP-99–102).
- Faces not drawn: dark (the token table) and 700–1023.

## Decisions of 2026-10-13, after the critic of slice s1 («sin final», hábitos), by the user

For the next slice; nothing here is built yet. Critic: `private/reportes/s1-critic/CRITIC.md`.

- Putting an end on a goal with no end counts weeks from this week («semanas desde esta»), never from the day it opened.
- A loose habit edits its name and its note only. Its cadence and amount do not change; that keeps past weeks read as they were.
- A habit has its own screen with its months, like «Por mes», reached from /metas and from Mes. «Retirarlo» lives inside it; tapping the row on /metas opens the habit, never the retire sheet.
- Lists that grow without an end (Por semana, Por mes, the report) show the last 12 with «ver todo». Screen and paper use the same 12.
- The template's example and the «PARA OTRA IA» text teach a goal without `horizonte:` and a `ritmo: 40 páginas`. Words only. Habits in the template and the report are a slice of their own, not taken.
- Not decided, pending: create a goal «sin final» inside a goal with no end from its sheet; thousands written «1.000» accepted back by the rhythm sheet and the import.

## Decisions of 2026-10-13, the boards of slice s2 (RP-103–106), by the user

Boards, approved 2026-10-13 on the page «Sin final y hábitos»: `HabitoPantalla.dc.html`, `VerTodoListas.dc.html`,
`PonerFinalDesdeEsta.dc.html`. Words and structure: `private/tableros-s2/NOTAS.md`.

- **A habit has its own screen,** `/metas/habitos/{id}`: «HÁBITO · DESDE EL {fecha}» above its name, its cadence, its note, «Editar»
  (outline), «POR MES» as a bare table, and «Retirarlo» at the foot. No card. The tab reads «Hábito».
- **A habit month reads «25 de 27 días»;** «0 de 1 día» takes the catalogue's plural. A cadence by week or month reads «3 días», never «de M».
- **A retired habit says «retirado el {fecha}»** under its name and keeps its months. It shows neither «Editar» nor «Retirarlo».
- **«Editarlo» edits the name and the note only:** «Guardarlo», «Guardando…», «Cancelar».
- **The /metas row of a habit opens its screen,** with a chevron. In «Mes», a habit's name is a link to it.
- **«ver todo»** sits under the table, on the left, once a list that grows with no end passes 12 rows. It has no «ver menos»: leaving the
  screen brings back the 12. Only goals with no end, and a habit's months, are cut (D1). Paper prints the same 12.
- **Putting an end on a goal with no end counts from this week:** the field reads «semanas, contando esta», 12 by default. A refused phase
  is named by its week counted the same way («semana 19»), the number the person changes in the field. A goal with an end keeps «semanas,
  contando la del {fecha}».
- **Faces not drawn for s2:** dark (the token table says it) and 700–1023 (between the two drawn). The habit screen at 1280 is the same
  640 column, drawn once. «ver todo» opened in «Por mes» and in the report is the list as it reads today, not drawn again.

## Decisions of 2026-10-13, after the critic of slice s2, by the user

For the next slice; nothing here is built yet. Critic: `private/reportes/critic-s2/REPORT.md`.

- **A goal with no end shows its last 11 closed months and the current one** in «Por mes», the report and paper. The months ahead fold
  into one line («los meses que vienen: 40 páginas cada uno»). The cut built in s2, the current month and 11 ahead, is a defect against
  «the last 12».
- **Every end sheet counts «semanas, contando esta»,** on any goal: «ponerle final» and «mover el final» alike. Retires RP-103's last
  sentence when built. The phase line keeps counting from the opening.
- **A retired habit lives in a folded «Retirados» under «Hábitos» on /metas;** each row opens its screen. No «volver a pedirlo».
- **A weekly habit's month reads «3 de 4 semanas»,** the weeks met. A week across two months needs its rule before it is built.
- **A week across two months belongs to the month holding 4 or more of its days** (the month of its Thursday), 2026-10-13, by
  the user. It is judged whole and counts once; a month has 4 or 5 weeks. The current week counts once it has ended.
- **The s3 boards are approved,** 2026-10-13, by the user: «Apruebo tal cual». Canvas page «Sin final y hábitos», board
  `S3Propuesta` (`PorMesUltimos`, `InformeUltimos`, `FinalSemanasContando`, `HabitosRetirados`, `HabitoSemanas`). Words and
  structure: `private/tableros-s3/NOTAS.md`. Approved with them:
  - «los meses que vienen: 40 páginas cada uno» reads in «Por mes», on the report screen and on paper.
  - A goal with no rhythm draws no such line.
  - A month ahead with its own amount set by hand is not folded: it is a row above the line.
  - «Retirados» sits above «Agregar un hábito».
  - «Mover el final» counts weeks from this one (8) while the goal screen and its phases count from the opening (9). Both stand.
  - A habit created this week reads «aún sin semanas cerradas».
  - Where the board differs, this file wins: `PorMesUltimos-2-sin-ritmo` and `InformeUltimos-2-sin-ritmo` draw a «los meses que
    vienen: sin monto» line that is not built, and the board folds a hand-set month that is built as its own row. Without a rhythm,
    the months ahead with no amount are simply not listed.
- **A weekly habit's first and last week count when it lived that week's Thursday** (2026-10-13, orchestrator, from the approved
  board: «Llamar a mamá», created Wed 8 jul, reads July as 4 weeks). Same rule as the month a week belongs to.
- **In «Mes», a weekly habit with no closed week yet this month reads «{cadencia} · aún sin semanas cerradas»** (2026-10-13,
  orchestrator, module 933), the words the board approved for its own screen.
- **A month ahead is reached from «ver todo»** (2026-10-13, orchestrator): it opens every month, those ahead included, and the
  fold line links there.
- **Paper folds the empty months ahead of a goal with no end into one line,** as a goal with an end does. Paper no longer matches the
  screen row for row there.

## Decisions of 2026-10-13, after the critic of slice s3, by the user

For the next slice; nothing here is built yet. Critic: `private/reportes/critic-s3/REPORT.md`.

- **Every goal with no end shows next month as its own row,** rhythm or not, so planning ahead is one tap. A goal with no rhythm
  reaches it today only through `?todo=1` (the critic's «broken»).
- **The end sheet says both counts under its field:** «contando desde esta semana; la meta lleva N semanas», and a phase refusal
  names the week in both counts. The goal screen keeps counting from the opening.
- **A weekly habit's retirement week counts whole when it was met before the retirement,** and its month shows «esta semana: N»
  for the week in progress.
- **The fold line goes right after the current month,** and the hand-set months follow it under «y estos meses con monto propio:».
  Built in s3 the other way round, it reads as if a hand-set month were at the rhythm.
- **The s4 boards are approved,** 2026-10-13, by the user: «Apruebo tal cual». Canvas page «Sin final y hábitos», board
  `S4Propuesta` (`PorMesSiguiente`, `FinalDosCuentas`, `HabitoSemanaRetiro`). Words and structure: `private/tableros-s4/NOTAS.md`.
  Approved with them:
  - The order under the current month: next month as a row, then «los demás meses que vienen: N cada uno», then «y estos meses con
    monto propio:» and their rows. Next month is not repeated there when it has its own amount.
  - «la meta lleva N semanas» counts this week too: «Correr 10 km» reads 8 in the sheet and «lleva 2 semanas»; «Leer» lleva 102.
  - A weekly habit's week in progress reads «1 de 2 esta semana», as Hoy does, for 1 a week too; «0 de 1 esta semana» with nothing done.
  - A retired habit's last month never reads «en curso».
- **Next month's row opens the amount sheet** (`?planear=<mes>`), 2026-10-13, by the user: planning ahead is one tap. The other rows
  open the month's page as before.
- **A habit retired in a met week whose Thursday falls next month counts that week in its retirement month** (2026-10-13,
  orchestrator): the habit has no next month to put it in.

## Decisions of 2026-10-13, after the critic of slice s4, by the user

For the next slice; nothing here is built yet. Critic: `private/reportes/critic-s4/REPORT.md`.

- **A retired habit in «Mes» reads «retirado el 7 oct»** in the «Hábitos» group of the month it was retired in; today it is drawn
  as a live line.
- **The end sheet shows the total the goal's screen will read:** «113 semanas en total» beside «termina el …», under the two counts.
- **Goals with an end fold «Por mes» as goals with no end do** (the last rows and «ver todo»), in a later slice: «Leer» with an end
  lists 27 rows today.
- **Reopening an ended goal offers «Ponerle final» and «Dejarla sin final»,** as the approved board `FinalDosCuentas` draws; the
  build shows «Quitar el final» and «Moverlo».
- Not a decision, a defect found by the same critic: «Leer» with a hand-set December reads «13 MESES» over 14 rows on /meses and the
  report screen, and «14 MESES» on paper. Every count must match its rows.
- **The s5 boards are approved,** 2026-10-13, by the user: «Apruebo tal cual». Canvas page «Sin final y hábitos», board
  `S5Propuesta` (`PorMesConFinal`, `CuentaMeses`, `FinalTotal`, `MesRetirado`). Words and structure: `private/tableros-s5/NOTAS.md`.
  Approved with them:
  - A long goal with an end shows its last 11 closed months, the current one and the next, then «N meses más, hasta el 3 ene 2027»
    with no amount (its last month is partial), then «ver todo». A goal with an end of 12 rows or fewer reads as before.
  - The total reads «termina el 3 ene 2027 · 113 semanas en total»; while a refusal holds the hint, the total moves to the line of
    the two counts so it never disappears.
  - Every «N MESES» equals the month rows drawn, own-amount rows included, on screen and on paper.
  - A retired habit appears in «Mes» only in the month it was retired in, with «retirado el 7 oct».
- **«Dejarla sin final» takes the end off** an ended goal being reopened, 2026-10-13, by the user: the goal reopens with no end, as
  «Quitar el final» did. To leave it ended, close the sheet.

## Decisions of 2026-10-13, after the critic of slice s5, by the user

For the next slice; nothing here is built yet. Critic: `private/reportes/critic-s5/REPORT.md`.

Approved by the user 2026-10-14 on the boards `PorMesConFinalVerTodo` and `PapelCabeceraPegada` (canvas page «Sin final y hábitos»,
strip `S6Propuesta`), with three answers: RP-115 retires for **RP-116**; the label over the own-amount months of a goal with an end
reads «estos meses con monto propio:», with no «y», since the line now follows them; the line of a goal with no end («los demás
meses que vienen: …») stays a link in s6. A goal that fits whole on one page (8 to 19 rows) still moves whole to the next page.

- **A folded goal with an end always draws «ver todo»** under its line «N meses más, hasta el …»; the line stops being a link
  where both would open the same list. «Escribir» with hidden months ahead and no hidden closed ones has no «ver todo» today.
- **The line «N meses más, hasta el …» follows the own-amount table,** so the list reads in time order. It keeps no amount: the
  months' amounts live behind «ver todo».
- **On paper a goal's header stays with its «por mes» table, and the table may split across pages.** Today «Leer»'s 14-row table
  jumps whole to page 3 and leaves page 2 with its header alone: 5 pages, two of them ~60 % and ~85 % blank.
- **The end sheet keeps «contando desde esta semana; la meta lleva N semanas»** beside the total: it says what the field counts.

## Decisions of 2026-10-14, after the critic of slice s6, by the user

For the next slice; nothing here is built yet. Critic: `private/reportes/s6-critic.md`.

- **The count over a folded «Por mes» says the drawn rows out of the goal's months: «2 de 120 meses».** Today «Piano» reads
  «2 MESES» over «118 meses más, hasta el 28 sep 2036». Changes RP-116's count clause: it retires for a new code when built.
- **Paper keeps every goal's detail on its own page, and never opens a page with a single task.** At 12 open tasks «Leer»'s
  task «Leer el epílogo» opens page 3 alone. The summary page stays ~35 % full; the detail never starts under it.
- **The end sheet of a goal with a phase warns while the person picks the date, not after «Moverlo».** Today the field, the
  refusal and the fine line read 6, 6 and 7 weeks for one clash, and nothing shows until the press.
- **A connected AI sets a goal's measure and rhythm (RP-117).** Today a whole roadmap can only come in through the import.


## Decisions of 2026-10-14, the boards of slice s7, by the user

Approved by the user 2026-10-14 («sí a todo») on the canvas «Bitácora de metas», strip `S7Propuesta` of the page «Sin final y hábitos».

- **Approved boards:** `PorMesDeN`, `VerMenos`, `PapelTareasPares`, `PapelEtiquetaPegada`, `PapelSinMontoSinFinal`, `FinalFaseEnVivo`,
  `PonerMedida`, `PermisoRitmo`.
- **The panel of a goal with no measure keeps «esta meta no mide nada» and offers «Ponerle medida».** «Esta meta todavía no tiene cifra.»
  belongs to «Por semana».
- **The first two and the last two tasks of a goal never separate on paper, even at the cost of a sheet.** «Leer» with 12 tasks goes from
  3 to 4 sheets.
- **«estos meses con monto propio:» is the title of the second table on paper and never closes a sheet.**
- **A goal with no end prints no line for its months ahead with no amount and no tasks; a month with tasks keeps its line** («enero de 2027:
  sin monto · 1 tarea»).
- **Answers Q1–Q6 of s7:** «de N» only with an end; RP-65 unchanged; «ver menos» on the four lists; RP-119 succeeds RP-56; «Ponerle medida»:
  a measure once set never changes; Q6 (c).
- **Boards that do not exist:** dark mode; `VerMenos` at 1280; the long finished goal («12 de 20 meses»); `/exportar?todo=1` at 1280; the
  «before» of `PapelEtiquetaPegada` (the prototype's seed did not reproduce the defect).

## Decisions of 2026-10-14, after the critic of slice s7, by the user

For the next slice; nothing here is built yet. Critic: `private/reportes/s7-critic.md`.

- **A folded list names its hidden closed months in a line before the table — «12 meses anteriores» — that opens «ver todo».**
  Today «Leer» reads «13 DE 27 MESES» over 13 rows and «2 meses más»: 12 closed months are said nowhere. The habit's count
  aligns: «12 de 21 meses» and the same line. Needs a board and a successor to RP-118.
- **«Ponerle medida»'s «qué cuenta» is shown wherever the measure is**: «mide cajas embaladas, en cajas» on the goal, «Por mes»,
  the report and paper. Today the goal reads «mide en cajas» and the name is never seen again.
- Also from the critic, not yet put to the user: on paper at 9 open tasks «Escribir»'s figures split across two sheets («0» at
  the foot of sheet 3, «de 17 páginas» on sheet 4); «Poner un ritmo» reads «cuántas km al mes» for a masculine unit.

## Decisions of 2026-10-14, the boards of slice s8, by the user

Approved by the user 2026-10-14 «tal cual» on the canvas «Bitácora de metas», strip `S8Propuesta` of the page «Sin final y hábitos».

- **Approved boards:** `MesesAnteriores` and `MideQueCuenta`, with two accepted differences: in «Por semana» and the habit the
  «… anteriores» line follows the label; on the goal, «el ritmo» stays above the measure's panel, as today.
- **Paper prints «12 meses anteriores» as text stuck to the first row**, without a link. «Por semana» too: «134 semanas anteriores».
- **A measure taken from the first commitment reads «mide en km»**; a name the person wrote goes as written («mide Cajas embaladas, en cajas»).
- **RP-118 gives way to RP-120**; «Por mes» draws no measure line (RP-121).
- **A goal's figures never split between sheets on paper.**
- **«¿Cuánto al mes, en km?»**: the rhythm's sentence takes no gender.
- **Boards that do not exist:** dark mode; the paper figures kept together (cut rule); `MesesAnteriores` at 1280 but the report.

## Decisions of 2026-10-14, after the critic of slice s8, by the user

For the next slice; nothing here is built yet. Critic: `private/reportes/s8-critic.md`.

- **The count stays as chosen in s7:** «13 de 27 meses» on a goal with an end; «13 meses» and «12 meses anteriores» on one with
  no end. The critic's «N de total» for every goal was put to the user and refused.
- **«Por semana» at 1280 gets its own board,** and its empty FASE and NOTA columns go. Today no board draws the wide face.
- **On paper a task list that continues on the next sheet repeats its label** («TAREAS DE OCTUBRE»). A lone table row at the top
  of a sheet is tolerated.

## Decisions of 2026-10-14, after the critic of the whole app, by the user

The one whole-app pass (`.claude/skills/orchestrator/SKILL.md`); critic: `private/reportes/critic-app-completa.md`. These are the polish picks: one slice
(s10) ships them, then polish stops. Nothing here is built yet.

- **A = a. The template keeps what the person wrote** (RP-122): every correction starts declined; «Aceptar» on one is real.
- **B = a. A goal that holds goals reads week by week** as the sum of its goals' weeks (RP-123), like its month (RP-80).
- **C = a. Paper follows the screen:** nested goals print inside their general goal (RP-84), and a «POR MES» with no task and
  no amount in any row does not print (RP-124).
- **D = a. Paper prints commitments,** one line each: «Estirar · todos los días» (RP-124).
- **In the slice besides:** «estos meses con monto propio» never over a goal that holds goals; the template's error lines say
  what is wrong (the missing accent, the cap of 7, the unit that goes, «ritmo» in hours) and every one at once (RP-72);
  «Por semana» at 360 carries the phase under the date line and «en curso» on one line; «Añadir una tarea» in «Mes» for a goal
  that has tasks; one task field on Hoy at 360, the goal chosen inside it; one number format everywhere («2.100 de 6.000
  palabras»); no «0 tareas · 0 hechas» (RP-73); the words: «no mide horas» on a goal with no measure, «Agregar» → «Añadir»,
  «Ábrelo en este teléfono» at 1280, the export's month names.
- **Left out by the user's scope** (the critic's Thin 1, 3 but commitments, 4, 6, 8, 11): to `private/pulido.md`. The NOTA column
  of «Por semana» stays dormant: nothing writes a week's note.
- **Answers of 2026-10-14 to the s10 plan's questions, by the user («todo lo que elegiste»):** 1 = a, paper equals the
  export screen: a nested goal's note, phases and «POR MES» stop printing; 2 = a, the export screen shows commitments and
  every «POR MES» paper prints (RP-124 widened); 3 = a, months named as their rows («noviembre 2026») go into RP-124, RP-77
  is not retired; 4 = a, a correction nobody touched is not announced in the folded month. The note's character counter
  («2 001 de 2000») stays out of «one number format».

## Decisions of 2026-10-14, the boards of slice s10, by the user

Approved by the user 2026-10-14 («todo a») on the canvas «Bitácora de metas», board `S10Propuesta` of the page «Sin final y hábitos»:
`ImportarComoEscribiste`, `ImportarErroresClaros`, `PorSemanaContenedora`, `PorSemanaTelefono`, `MesesContenedora`, `MetaSinTareas`,
`PapelSigueLaPantalla`, `CifraUnFormato`, `HoyUnCampo`, `MesAñadirTarea`, `PalabrasPulido`.

- **`HoyUnCampo`: the day chips carry their own label, «para cuándo»,** like «de qué meta» above them.
- **`ImportarErroresClaros`: the notice stays under the text box,** where it is today.
- **A correction from the template is read only on the model's path as accepted;** from the template it starts declined (RP-122).
- **Boards that do not exist:** dark mode; 1280 of `HoyUnCampo` (Hoy at 1280 does not change); 1280 of `PorSemanaTelefono` (s9
  draws it); the paper face of `CifraUnFormato`.

## Decision of 2026-10-14: the app is called «GoalLog»

- The visible name is **GoalLog**: the rail, the title, the tab and the OAuth consent («Ir a GoalLog»). It was «Bitácora de metas».
  Paper prints it too once module 995 lands (`export.json` `printBrand`). The folder and the URL keep `pulsar`.

## Decisions of 2026-10-14, after the audit of s10, by the user

- **RP-125:** the export's months hold no weeks on screen; «Por semana» is its own table. A goal with no measure drops «sin tareas»
  from its «Por mes» (`components/month/months-screen.tsx:100`).
- **The workbook's example rows** (`lib/import/workbook.ts:259,267`) move into next-intl: the person reads them in the file.

## Decisions of 2026-10-15, by the user («acepto todo lo que digas pendiente»)

- **A daily cap on model calls for the whole app**, on top of each person's 10 imports and 50 chats.
- **The chat labels its replies «GOALLOG».**
- **A write that fails to reach the server keeps the person where they are, with what they typed,** and the line «No se pudo guardar. Tu texto sigue aquí; inténtalo otra vez.» (Hoy's tap, the quantity sheet, «Abrirla» on a new goal). Form pages that read no data keep opening during an outage and fail on save.

## Decisions of 2026-10-15 (pending list), by the user

- **«Nada se borra» covers facts only.** Phases, cadences, a measure, a rhythm and goals with no facts can be edited and deleted; a goal or commitment that explains facts stays archived or retired (RP-13, RP-24). Built (RP-127, RP-134, RP-135).
- **A goal's hours come from blocks alone,** a block's quantity. A task's estimate does not count toward hours. Built in RP-128.
- **A task can be marked done on a past day, up to 7 days back,** the same reach as a fact (RP-06). Built (RP-129).
- **A later import can update goals created before, matched by name,** and shows the differences before applying them. Overturns RP-86 as written («An import creates new goals and never changes an existing one»). Built (RP-130).
- **Three goal levels stay,** as today (RP-78).
- **The last day of a month reads «último día»,** never «faltan 0 días». Built (RP-132).
- **The report writes cadence days in full** («martes y jueves»); Hoy keeps the short form. Built (RP-133).
- **CI, decided for the infra train:** concurrency per branch, path filters, `pulsar-fechas` out of manual dispatch, and 6 shards for `pulsar-e2e`. Built in #609.
- **Access is by invitation only.** Public sign-ups are off in Supabase Auth and the app keeps a list of allowed emails; the server refuses a sign-in link for an email not on the list before any email is sent. PKCE applies: a link only works in the browser that asked for it. Built in GoalLog (RP-131) but the cut of `token_hash`, which waits for the shared template; sign-ups stay on until WordBook and HomeFund have their lists.

## Decisions of 2026-10-15, the printed report's page break

- **A goal whose «por mes» table holds 8 printed rows or more prints whole: a table that does not fit opens a fresh
  sheet.** Its name, measure line and figures lead the table. Revokes the flow of decision (3) of 2026-10-10 (train-5
  critic) and «a table of 15 printed rows or more flows» (train-6 critic). Accepted: a blank at the foot of the sheet
  before. Taken by the user 2026-10-15.

## Decisions of 2026-10-15, answers to the last slice's plan, by the user

- **The AI keeps a set measure fixed;** the person changes or removes a measure no fact feeds. Retires RP-117 for RP-134.
- **A loose habit no fact names changes its cadence.** Retires RP-104 for RP-135.
- **A cadence or a measure facts depend on never changes:** the person retires it and opens another.
- **A goal with goals inside is not deleted** until they are moved out or deleted.
- **An act that cannot be done is shown disabled with one line saying why, never hidden** («Borrar la meta», «Cambiar la medida», «Cambiar la frecuencia», «Borrar el compromiso»). A removal's sentence sits with its own removal control, never above the sheet's primary button.
- **A past day lists the dated tasks it owed and the tasks done on it;** month tasks stay on Hoy.
- **An import merges and never removes:** open goals only, matched by name; two goals of one name are not updated.
- **Sign-ups stay on in Supabase Auth** until WordBook's and HomeFund's lists are built. Nothing to code.
- **GoalLog's sign-in route accepts `code` and still `token_hash`;** RP-131 stays unticked until the email template moves.
- **A stranger reads «Este correo no tiene invitación a GoalLog.»**
- **The allowed list seeds everyone who owns a GoalLog row;** new people enter by `npm run allow-email` plus a dashboard invite.
- **Two phases of one goal may share a calendar week when their dates do not overlap;** the person's dates are kept and both phases show that week number. Overlap is judged on dates in the form, the server and the import, never on weeks. Saving an unchanged phase moves no date. Decided by the user 2026-10-15.
- **An import phase whose name matches none but whose dates cross an existing phase is not added:** the review reads «se cruza con «<fase>»» and leaves it unmarked, and the confirm refuses it even if sent marked. Overlap is judged on dates (phases may share a calendar week). Taken by the user 2026-10-15.

## Boards of 2026-10-17: sign in with a six-digit code (RF-146 / RL-73 / RP-136)

Board «EntrarCódigo», GoalLog, 360 and 1280, for `/entrar` and `AutorizarSinSesion`. Decided by the user 2026-10-17. Not built yet.

- **`EntrarEnviado` was superseded on 2026-10-17 by the code step** (`EntrarCódigo`).
- **The canvas page «Archivo» now holds every superseded board joined in one board, `Archivo.dc.html`** (2026-10-17, by the user's decision, to free room: the canvas had hit 511 files).
- **Sent (`EntrarCódigo`):** `ScreenHeader` eyebrow «GoalLog», title «Revisa tu correo», sentence meta «Te mandamos un
  código de seis números a {email}. Vence en una hora.» (address as `Figure` meta); `Field` «Código del correo»
  (numeric keyboard, one-time-code autofill, 6 characters, autofocus); `Button` block «Entrar»; muted sentence «También
  puedes abrir el enlace del correo en este navegador.»; ghost accent `Button` «Usar otro correo».
- **Pending (`EntrarCódigoComprobando`):** «Comprobando…», disabled.
- **Incomplete / Refused / Our side / Too many:** the field's `invalid` + hint, as the email refusals: «Escribe los seis
  números del correo.» / «Ese código no vale o ya venció.» / «No se pudo comprobar el código. Escríbelo otra vez; si no
  entra, pide otro.» / «Demasiados intentos. Prueba de nuevo en unos minutos.»
- **Done:** no board; `/` or the consent.
- **Form before the send:** lead «Te mandamos un código a tu correo. Lo escribes aquí y entras; no hay contraseña.»;
  button «Enviar código»; on the consent, «Entra primero. Te mandamos un código a tu correo, lo escribes aquí y decides.»
  and «Enviar código».
- **Notes (what the boards take for granted):**
  - The mail is the shared template of `docs/DESIGN.md`: no app name, the code drawn as the example 482913 in place of
    `{{ .Token }}`, the subject painted by the mail client and not part of the body, the text part carrying the link as a
    bare URL.
  - `/entrar` is a single centred page, no tab bar; the light face is the primary one.
  - The field follows the app's `Field` (no letter spacing); the address is mono as `Figure` meta.
  - The sentence and «Usar otro correo» group under the button.
  - «Comprobando…» dims the controls to 55 %.
  - The consent's client name is drawn as «Claude».
  - 1280 is drawn only for the state that asks for the code.
  - An interrupted code step comes back: the address is kept on the device for the code's hour; «Usar otro correo» or a code that lands clears it.

## Decisions of 2026-10-17, after the critic of the six-digit code (#651), by the user

- **Another code: a «Pedir otro código» button on the code step, with a countdown.** It sends a new code to the same address without typing it again; a send that Auth refuses gives the daily send back. Its boards are not drawn yet.
- **The code mail names its sender and carries one English line.** One shared template still; a sender name and a short English line under the code. Its board is not drawn yet.

## Decisions of 2026-10-17 (afternoon), by the user

- **A daily cap on sign-in links per client, the twin of HomeFund's RF-143.** It takes the next free RP when the planner
  cuts it. Not built yet.

## Boards of 2026-10-17: «Pedir otro código» (codigo-6b)

Canvas «Bitácora de metas», page «Armazón», from y=13700. 360 five states and the signed-out consent waiting, 1280
waiting. Not built yet.

- Between the muted link sentence and the ghost «Usar otro correo», a ghost accent `Button`:
  - Waiting: disabled «Pedir otro en {seconds} s», counted from the last send (60 s).
  - Ready: «Pedir otro código».
  - Pending: «Enviando…», the controls at 55 %.
  - Done: the sentence «Te mandamos otro código a {email}. Usa el del último correo.», the address as `Figure` meta;
    the wait restarts.
  - Refused: a sentence with `role="alert"` under the button, `errors.rateLimited`'s words.
- The signed-out consent shows the same step; its other states are the ones of `/entrar`.
- The mail is HomeFund's shared template (canvas «HomeFund», «CorreoV2»).

## Boards of 2026-10-17: «EntrarSinConexión», the code step offline (codigo-6c)

Canvas «Bitácora de metas», page «Armazón», from y=15460. 360, three states. Built in codigo-6c (#657).

- Offline send: the field's hint «Sin conexión. No se pudo enviar el código.», the button enabled, the address kept.
- Offline resend: the alert sentence «Sin conexión. No se pudo enviar el código.» under «Pedir otro código»; every
  control enabled; the countdown keeps the last send's clock.
- Offline check: the field's hint «Sin conexión. No se pudo comprobar el código.», the code kept, controls enabled.

## Boards of 2026-10-17: «EntrarTopeDiario», the daily cap says «mañana» (decidido-17)

Canvas «Bitácora de metas», page «Armazón», from y=16500. 360, two states. Built in decidido-17 (#659).

- GoalLog's own daily cap (RP-138) refuses in the failure shape of the offline boards with «Ya pediste varios códigos
  hoy. Prueba de nuevo mañana.» (`account.errors.capped`): on the address form as the field's hint, and on the code
  step as the alert sentence under «Pedir otro código», the button ready.
- Auth's own 429 keeps «Demasiados intentos… en unos minutos.»

## Decisions of 2026-10-17 (night), after the critic of codigo-6c, by the user

- **A send or a check that hangs ends at 8 s, like WordBook.** «Enviar código», «Pedir otro código» and «Entrar» that
  get no answer in 8 s say «No sabemos si se envió. Revisa tu correo antes de pedir otro.» and every control is usable
  again. Supersedes the «no timeout» line of codigo-6c M8. Needs a board. Not built yet.
- **Q3 b, same night:** «Enviar código» and «Pedir otro código» that hang say «No sabemos si se envió. Revisa tu correo
  antes de pedir otro.»; «Entrar» that hangs says «No sabemos si se comprobó el código. Espera un momento antes de
  escribirlo otra vez.» Board «EntrarSinRespuesta».

