# Canvas

The main session reads this before a screen is dispatched. The why: `docs/agentes/historia.md` § Design.

## The rule

- Draw a screen on its app's canvas before any worker writes it. The canvas is the artifact; the app's `DESIGN.md`
  is the law it obeys.
- Dispatch the worker once the board is drawn. Never wait for the user to approve it; show it in the report.
- Apply it to a new screen, a new state of one, and a change a person can see. Never to work behind the screen.
- Draw every state the screen really has (empty, loading, failed, full), not the happy one.
- Draw one board per state, on the app's primary face. Add a second face only where the design really changes: a
  different layout, control or order. Never where only colours or padding change: the token table already says
  what dark is.
- Say in the board's own note what it takes for granted. A face nobody drew must read as a face nobody needed.
- Write the board's words and choices into the app's `DESIGN.md` the day it is drawn, and a user's decision the
  moment they take it, with its date. The canvas shows what was drawn; only `DESIGN.md` says what was chosen.
- When a board and its `DESIGN.md` disagree, the file wins.
- Say in `DESIGN.md` which boards do not exist. A gap nobody wrote down reads as a gap nobody noticed.
- Move a superseded board to the canvas's «Archivo» page the same day. Never leave it beside the live one.
- Update the canvas in place, at its own URL. Never publish a second canvas for the same app.
- Group pages by area of the app, one page per area, light and dark side by side. Open no page for a single module.
  Split a crowded canvas into pages, never into a second canvas.

## The canvases

- `apps/homefund` (HomeFund): «HomeFund», https://claude.ai/artifact/UJsx2ugZgNoRFWMvNGmooj (created 2026-10-14).
- `apps/wordbook` (WordBook): «Diccionario de lectura», https://claude.ai/artifact/K9acY69gRz13JPtAn7GWwz (the old
  `claude.ai/code/artifact/92f7…` link opens the same canvas).
- `apps/goallog` (GoalLog): «Bitácora de metas», https://claude.ai/artifact/5ZNtobfQDzeBNFcEMs38Qp
- `apps/portal`: «Universo», https://claude.ai/artifact/RqkVpe5eP47Qu4S9YbC3GZ
- The roadmap, «Hoja de ruta del Universo»: https://claude.ai/artifact/BvxPYpkcqSDerHBXrNhUwF. Questions to the user go in its
  «Te toca a ti», never the terminal; read the answers from its db collection `respuestas`.
- Add the URL here the day a canvas is created. A canvas nobody can find is a canvas nobody uses.

## Reading and dispatching

- Read a canvas from the main session, never from a subagent. It comes back as one 2.7 MB page whose head is the
  editor's stylesheet, not the design.
- Grep the saved file for `\.dc\.html` to get the board names. Never read the page in twice.
- Escape `</script` when you rebuild a canvas page. `JSON.stringify` does not, and the truncated page looks empty
  rather than broken. See `docs/TRAPS.md`.
- Name the board in the dispatch. A module that draws a screen cites its board or it is not ready.
- Paste the board's words and its structure (card or bare section, which line sits where) into the dispatch. A
  board's name alone is not enough. The worker never opens the canvas.
