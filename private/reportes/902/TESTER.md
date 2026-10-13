# Module 902 tester report (written red, no product code)

Spec: apps/pulsar/e2e/importar-revision-larga.spec.ts (10 tests). Log: private/reportes/902/rojo.log (dev :3201, lane 2, workers 1): 8 failed, 2 passed.
Fixture: built in the spec from rawGoal/rawTask + stored(): general + 4 goals, 51 tasks, 58 sub-tasks, 6 commitments, source of ~440 lines with 333 out lines under 5 `##` sections. No model, nothing written to the database (draft lives in sessionStorage; "Crear" never pressed).

| Clause | Test | Red because (today) |
|---|---|---|
| 1 | long draft under 3 000 px at 360 | scrollHeight 40 364 |
| 2 | goal rows carry "12 tareas / 1 compromiso / 3 meses / N por revisar" | row reads "Caso unometa grande · hasta el ..." only |
| 2 | "Sus partes" opens months, month opens tasks | tasks of a goal are drawn with no fold |
| 3 | only the goal with corrections arrives open | no "Sus partes" button exists (count 0, expected 5) |
| 4 | child goals visible, +16 px, general's "Sus partes" shut | no "Sus partes" |
| 5 | one folded group per section heading with count; counts sum to out; lines hidden until opened | no group buttons; lines flat |
| 6 | untick a folded goal: Crear 4 metas, count total unchanged | red at its folded precondition (tasks drawn); the untick itself works today |
| 6 | shut/reopen a goal, decline a correction, "por revisar" drops by 1 | no "Sus partes" (30 s timeout) |
| 7 | short plan (template example, planText) | GREEN today by design: guards classes, 16 px steps, "Crear 3 metas", count line adds up |

Existing specs: importar-arbol + importar-revisar: 28 passed today (log existentes.log).
Which must change: not decidable before the build. Any test that reads a task, month, phase or commitment row of a goal right after toReview (arbol "three levels..." line 55 and the x-offset steps for PHASE/WEEK/TASK_A/SUB_A; most of revisar's tests that tick or amount-edit a month/task) will need "Sus partes" (and the month fold) opened first, IF a short plan folds like a long one. Clause 7 says a short plan "reads as today"; DESIGN says every goal is a row with "Sus partes" folded. Contradiction: ask the user whether goals of a short plan arrive folded (specs change) or flat (no change). My short-plan tests assert only what is true under both.
Assumptions in the tests (worker may tell me they are wrong): a goal row's summary sits in the same label as its checkbox; the goal's fold button is named "Sus partes..." and each goal has one (general too, via its phase); month fold buttons start with the month name; "N por revisar" counts undecided corrections and falls on decide; group buttons start with the section heading and carry its count; out-line groups use `##` headings, heading lines themselves are plan lines in the fixture.
Mutations: none applicable (no code yet); redness above is the proof. Source files untouched.
