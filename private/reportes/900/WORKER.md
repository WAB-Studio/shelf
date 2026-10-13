# Module 900 worker

Files: components/goal/goals-screen.tsx (reads goal.monthUnit), lib/queries/goal.ts (MetasOpenGoal.monthUnit = rolled-up unit when the goal holds goals, else its measure), components/goal/goal-screen.tsx (rhythm prop), components/goal/create-inside-sheet.tsx (rhythm prop, line before the buttons), components/import/import-screen.tsx (pick attaches; Quitar; read sends the file; file + text line), messages/es/{import,tree}.json.
Applied from private/tableros-f1/f1.patch (minus the proto page).

Logs (private/reportes/900/):
- verde.log: tester specs. 6 green, 1 red: crear-dentro-aviso test 1 second half (`esta meta no mide nada` still shown) = 898's createGoal unit inheritance; the sheet line, its position above «Abrirla» pass (reaches line 54).
- existentes.log: grep of existing specs, 240 passed, 22 failed:
  - 20 are import specs that pick a file and expect the read at once (importar-archivo-vivo x12, importar-excel x4, importar-lista-viva:306, importar-revisar:367, importar:131/191/254). Stale against the approved contract (pick only attaches); they need a «Leer el plan» click after the pick. Not edited.
  - metas-arbol:240 passed on rerun (dos.log): flake under load.
  - varias-metas:16 fails on `/`: Next dev overlay intercepts the Metas tab click (dos.log); that screen is not touched here.
- dos.log: rerun of the two.
