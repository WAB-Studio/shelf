# Critic · pulsar · goals in three levels + import in three steps · integracion 32d3bfe4 · 2026-10-12

## Summary
I drove pulsar on :3200 (next dev, local stack, my own harness identity) as one person. First run: /metas empty, then /metas/importar. Then the template pasted as it is, the Excel template, a foreign .xlsx, a .docx, a template with two broken lines, and one real gpt-5.5 read of roadmap-angela.md (598 lines, 82 s), taken through to «Crear». After that: /metas, the goal screens (general, large, small), Por mes, El plan, Hoy, Mes, /exportar and its print to PDF, and the create-inside, move, archive and horizon sheets. Faces: 360 and 1280, light and dark on the main screens.
Counts: Broken 1 · Hostile 9 · Hollow 3 · Thin 6.
Not repeated: anything already in tren-j1/tren-i1 VALIDATOR and MUTATOR.

## Broken
- /metas/importar/revisar, a real model read of the user's roadmap: «Crear 5 metas» fails every time with «No se pudo crear el plan. Inténtalo otra vez.», and trying again cannot help.
  - Cause: the model read the plan's «Semana tipo» as 8 commitments with `cadenceKind: times_per_week` + `cadenceWeekdays: [1]`…`[7]`. Postgres refuses that pair (`commitments_weekdays_for_weekdays`, 23514; dev log `POST /metas/importar/revisar 500`).
  - The review lets it through: `lib/import/draft.ts:820-830` validates the commitment with a schema that accepts weekdays on any kind. `app/actions/import.ts:131,182` then writes it as it is.
  - RP-90 promises «a part that cannot be written never topples the plan». Here one bad part topples all 5 goals and 66 tasks. Nothing on screen names the commitments.
  - Way out today: guess, and untick all 8 commitments.

## Hostile
- **/metas, every face (360/1280, light/dark), any goal that holds goals with no measure of its own: the month line shows bare minutes.**
  - «Carrera en IA · octubre · 0 de 660» and «IA aplicada · octubre · 0 de 660». The same goal's own screen reads «0 min de 11 h».
  - Cause: `components/goal/goals-screen.tsx:89` uses `goal.measureUnit` (the goal's own unit). The goal screen uses the rolled-up unit.
  - Every holder an import creates from the app's own template or its .xlsx has no measure: the template puts `medida` on the leaf only. So the first plan a person brings in shows its headline figure as «660».
- **Hoy, «Product Designer…» group (360 and 1280) and the goal screen: model-read commitments carry English units.**
  - Hoy reads «1 hours · 0 de 1 esta semana», «90 minutes», «10 minutes».
  - `lib/units/time.ts:21` (`HOUR_UNITS` = horas/hora/h) does not know «hours», so `draft.ts:558` keeps it raw. The values are stored as `unit='hours'`/`'minutes'`, and they are not time to the goal that measures in minutos.
- **Hoy, Monday 12 Oct, after the import: the day is gone from «Lunes…Domingo» commitments.**
  - All 7 day-blocks ask for something today: «Domingo · Inglés pasivo · 0 de 1 esta semana» shows on a Monday.
  - The review showed «1 vez por semana» for each and offered no way to change a cadence.
  - The plan said «Domingo». The model wrote it as times_per_week 1, which cannot keep a day.
- **/metas/importar/revisar, «SIN LUGAR EN EL PLAN»: 20 lines say «la nota de «Product Designer junior…» ya está llena». They are false.**
  - The note holds 7 599 of 100 000 characters, and it does contain the «pilares» text.
  - Cause: `lib/import/coverage.ts:36-41` (`lineCount`) counts a line as in the note only if the note ends with the source lines verbatim. A note the model reworded reads as «full».
  - The person cannot act on that reason, and the «288 fuera» count is wrong by at least those 20.
- **Goal screen → «Agregar meta pequeña» on «Diseño de producto con IA» (rhythm 15 h 10 min/month): one tap of «Abrirla» erases the month target.**
  - The large goal goes from «9 h 47 min» to «Sin monto este mes.». The general goes from «27 h 56 min» to «18 h 09 min».
  - The sheet says nothing about it. The new small goal reads «esta meta no mide nada»: the sheet asks only name and weeks.
  - Getting the target back means adding a measuring commitment to the child and planning a rhythm there.
- **/metas/importar, first real read (90 KB paste): «No pudimos leer el plan.» after ~1 s, with 0 tokens, settled `failed`.**
  - It still cost one of the 10 daily reads (`spend.ts:1` counts failed reads too).
  - It did not happen again: the same request answered 200 in a probe, and the retry took 82 s.
  - `lib/import/model.ts:326` (`!response.ok`) and `:331` (`catch {}`) drop the status and the error, so neither the person nor whoever runs the app can say why.
- **/metas/importar, after any upload error (.docx 415, foreign .xlsx 415): pressing «Leer el plan» again swaps the right sentence for «No pegaste nada. Pega tu plan o sube un archivo.»**
  - The person did upload something. The picked file is gone, and the sentence is not true.
- **/metas/importar: picking a PDF or an image sends it to OpenAI at once.**
  - `components/import/import-screen.tsx:416` calls `readFile` on pick, and `:316-333` posts it. There is no press.
  - A wrong file costs a paid read and one of the 10 daily reads.
- **/metas/importar/revisar with the real plan: the page is 63 934 px tall at 360 (about 86 screens) and 47 427 px at 1280.**
  - It holds 375 checkboxes and 268 «SIN LUGAR» rows, one per markdown table row and source link.
  - «Revisa antes de crear» cannot be done by a person at that length.

## Hollow
- **RP-96 «an import loses nothing», on the plan the slice was built for: «598 líneas: 161 en el plan, 149 en notas, 288 fuera». 48 % is out.**
  - What is out: «Pasos para convertirlo en el caso #1 … Oct, 2 h · Escribir el problema en 3 líneas», the Nutria and Fleurance steps, «Riesgos del plan», «Qué cuesta de verdad», «Semana tipo» and «Presupuesto de horas por mes».
  - RP-95 says context goes to the goal's note, but nothing places a line the model skipped.
  - `app/importar/leer/route.ts:126-138` sends the draft as the model wrote it. `coverage.ts` only counts.
  - The tick holds the count, not the keeping. The user's words were «que no pierda nada».
- **The tree the model built cannot work under RP-80:**
  - All 66 tasks sit on the general goal, which as a holder has no plan of its own.
  - The 4 pillar goals have a rhythm (15 h 10, 8 h 40, 13 h, 6 h 30 per month) and 0 tasks. Their rows read «Ritmo al mes · las tareas van al plan», and there are no tasks.
  - Hoy draws 4 empty pillar headers that ask for nothing. Their «reached» can only stay 0.
  - The general plans 27 h 56 min for October against the plan's 37 h, because its own 38 h of October weeks are not planned.
  - English is counted twice: tasks «Inglés de enero 13 h»… on the general and a 13 h rhythm on «Inglés A2→B1».
  - The check step (`lib/import/check.ts`) says none of this.
- **The app's own template example, pasted untouched, does not add up:**
  - It raises a correction «Octubre: 12 h → 11 h» and a phase moved («tu plan la ponía antes de abrir la meta»).
  - Its two holders have no measure, so /metas reads «0 de 660».
  - This is the first plan a person tries, and the AI instruction tells other AIs to copy it.

## Thin
- **Review sheets: only goal and commitment names can be changed.**
  - Missing: a goal's horizon, a commitment's amount or cadence, a phase's dates.
  - The model errs exactly there (cadence above). To be worth it: a cadence and an amount field on the commitment sheet, and the horizon on the goal sheet.
- **Imported notes keep markdown and drop «done».**
  - Mes and El plan show «- [ ] **1 h · EF SET (línea base de inglés).** ✅ HECHO el 9 oct 2026…» as raw text, and the task is created pending.
  - To be worth it: strip `- [ ]`/`**`, and carry «HECHO» as a done task or at least leave it out of the note's head.
- **/exportar to PDF: 22 A4 pages for 8 goals.** The board's own question («¿tope o una página por meta grande?», tableros-jerarquia NOTAS) is still open.
- **«mover el final» on a general whose 4 large goals end the same day:**
  - It names one goal («Mueve primero su final»), so the person repeats it for each child.
  - The date carries no year («termina el 30 de septiembre») on a 51-week plan.
  - To be worth it: offer to move the branch's ends with it.
- **1280 rail «METAS ABIERTAS» lists the goals flat** (Carrera en IA, IA aplicada, Evals y harness at one level). It ignores the tree the page beside it draws.
- **/metas/importar at 360 is 3 078 px:** the template is printed twice, once alone and once inside the «PARA OTRA IA» instruction. One copy button over one block would do.

## Questions for the user

**1. What a goal that holds goals and measures nothing shows on /metas**
- What it is: every import makes its general and large goals with no measure. /metas then shows their sum as «0 de 660», raw minutes with no unit.
- Options:
  - (a) The row takes its goals' unit, as the goal screen already does. One line of code, and nothing stored changes.
  - (b) Every goal is given a measure at creation and import. A new field on the sheet, the template and the .xlsx, and a migration of the holders that exist.
  - (c) Holders show «3 de 5 metas» instead of a figure. This loses the hours sum RP-80 was built for.
- My pick: (a).

**2. What «loses nothing» (RP-96) means for lines the model does not place**
- What it is: on the real plan, 288 of 598 lines end «fuera» with a reason. Some are context (sources, tables), some are plan steps.
- Options:
  - (a) Every line the model leaves out goes verbatim into the general goal's note, before the review. A 90 KB plan fits the 100 000 cap; the note becomes the document.
  - (b) Keep listing them as out. This retires RP-96's wording for a weaker promise, which is your call under the retire rule.
  - (c) A second model pass places them. Spend goes from about USD 0.36 to about 0.70 per read, plus the time.
- My pick: (a).

**3. The tree the model builds when a plan has pillars and dated weeks**
- What it is: the model put all tasks on the general and gave the pillars rhythms with no tasks, so nothing ever adds to the pillars.
- Options:
  - (a) The prompt says tasks go under the goal they serve. Free, but not proven until measured.
  - (b) The check step flags «a goal with a rhythm and no tasks while the goal above holds tasks». Code, and the person decides.
  - (c) Leave it. The person rebuilds by hand, and there is no screen to move a task between goals.
- My pick: (a) + (b), measured on roadmap-angela.md again.

**4. Creating a goal inside one that has a rhythm**
- What it is: RP-80 keeps the parent's rhythm «stored and unread». In practice one tap drops the parent's target and the child measures nothing.
- Options:
  - (a) The sheet says it in one line before «Abrirla». Words only.
  - (b) The child takes the parent's measure at creation, so its rhythm can carry the sum. Needs a change to `createGoal`.
  - (c) Both.
- My pick: (c).

**5. A picked PDF or image goes to the paid model with no press**
- Options:
  - (a) Picking only attaches the file, and «Leer el plan» sends it. One more tap, and no read is spent by mistake.
  - (b) Keep sending on pick. Faster, and a wrong file costs one of 10 daily reads.
- My pick: (a).

## What I could not reach, and why
- RP-85 (MCP tree tools): needs an OAuth-connected client. Not driven.
- A PDF or image through the real model: the read budget was spent on the text plan.
  - Reads used: 2 in the browser (the first failed with 0 tokens, the second took 82 s).
  - Plus 2 probes I stopped right after OpenAI answered 200, one with a tiny text and one with the full plan; its input may have been billed.
- Loading skeletons and the ends-today edges under `PULSAR_CLOCK`.
- Archive and move carried out to the end: I opened both sheets and cancelled.
- To get past the Broken item I edited the stored draft to drop the 7 weekday arrays. Everything after «Crear» rests on that.

## Footprint
- Harness identity `harness-pulsar-e893eec6-…@example.invalid` under seed run `47f66b87-…`, left open for `harness:reap`.
- 9 goals on it.
- Session file `apps/pulsar/private/session-critic.json`.
- Logs: `dev.log`, `dev2.log` in this directory.
- Captures in the critic's scratchpad, not copied.
- Port 3200 freed with `fuser -k`.
- No code edited.
