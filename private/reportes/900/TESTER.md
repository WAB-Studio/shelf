# Module 900 tester report (specs written red, no product code)

Logs: private/reportes/900/rojo.log (all three files), rojo-quitar.log. Run on dev :3203, HARNESS_LANE=4, workers=1.
Result: 6 failed, 1 passed (the intended guard).

| Clause | Spec | Red output | Line that makes it red |
|---|---|---|---|
| 1 | e2e/metas-unidad-hijas.spec.ts "a holder that measures nothing reads «0 min de 11 h»" | Expected "octubre · 0 min de 11 h"; Received "Junior … octubre · 0 de 660 hasta el … · 2 metas" | components/goal/goals-screen.tsx:89 `const unit = goal.measureUnit ?? undefined` (holder has null unit; children's unit not used) |
| 2 | e2e/importar-adjunto.spec.ts "picking a PDF sends nothing…" | getByText('Plan-2026.pdf') not found | import-screen.tsx:416 `onPick={(file) => void readFile(file)}` sends at pick; no attached-file state or line |
| 2b | same file "«Quitar» drops the file…" | getByRole('button',{name:'Quitar'}) not found | no «Quitar» exists (messages/es/import.json has no such key) |
| 3 | same file "after a refused type the file stays named…" | getByText('Roadmap 2026.docx') not found | readFile (:316-333) sends at pick and keeps no file; a later readText (:300-307) hits `text.trim()===""` -> import.errors.blank |
| 4 | same file "a file plus text in the box…" | line «Se lee el archivo; el texto de la caja no se envía.» not found | no such message or state; the file already left at pick, readText sends only `text` |
| 5 | e2e/crear-dentro-aviso.spec.ts "on a goal with a rhythm the sheet says…" | sheet line «El ritmo al mes de «Diseño …» deja de contar; …» not found | components/goal/create-inside-sheet.tsx: no rhythm prop, no line before SheetActions (:~140). Its second half (new goal not «esta meta no mide nada», goal-screen.tsx:350) is never reached red; it guards the unit-inheritance once the line exists |
| 5b | same file "on a goal with no rhythm the sheet draws no such line" | PASSES today (nothing draws the line) | n/a: guards the worker against drawing it for every goal |

Commit: see git log on pulsar-900-pantallas.
