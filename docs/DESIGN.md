# Shared fund app — design guide

Where interface decisions that outlive a single slice are written down.

## The domain leads

- Derive every interface decision from the domain, never from a pattern borrowed for its looks.
- Put the person's experience ahead of what is convenient to build.
- Give the screen to the action the person came to perform.

## Mobile first

RNF-08 sets the requirement. This is how it shows in the interface.

- Design and build every screen for the narrow viewport first.
- Write the unprefixed value of a responsive prop for the narrow viewport.
  Add `xs`, `sm`, `md`, `lg` or `xl` only for what changes above it.
- Treat the narrow viewport as the base case, never as a fallback.
- A screen is done only once it holds at the narrow viewport: no horizontal
  overflow, no overlapping controls, no tap target under 44 px on its shorter side.
- Hold the floor at 44 px (decided by the user 2026-10-15, raised from 32 px). Enforce it in the `components/ui` primitives, never in a screen.
- `TapTarget` in `components/ui` owns that floor for a link's content.

## Navigation

- Carry the mobile navigation on a fixed bottom tab bar. It is the primary pattern.
- Compose the bar from `BottomNav` in `components/ui`. Wire its state in `AppTabs`.
- Give the frequent tabs their own slots. Raise the frequent action at the center.
- Disable a tab whose slice is not built. Keep it visible, keep it non-navigable.
- Reach the secondary destinations and the preferences from the "Ajustes" panel the bar opens.
- Hold language, theme and sign out inside that panel.
- Carry the desktop navigation on the sidebar from `md` up. Hide the bar and the header there.
- Follow `private/design-desktop/SPEC-A3.md` for the sidebar. Compose it from `Sidebar` in `components/ui`.
- Open the same "Ajustes" panel from the sidebar's own row.
- Name every destination once, in `components/fund/destinations.ts`. Never list one at a surface.
- Keep the active fund visible wherever a write can happen.
- Reserve the bottom gutter on every app page.
- Compose it from `Page` in `components/ui`.
- Never write a page's padding at the page.

## Debts

- Show a card or liability with a positive balance as «A favor $ …» in `--accent-11`, never as «Debes». Add that balance to
  the available credit. Decided by the user 2026-10-08 (Q-D4, module 601).
- Keep instalments under RF-136: the next payment is the minimum, with no instalments added to it. The instalment dialog
  becomes «proponer diferir». Decided by the user 2026-10-08 (Q-D5, module 604).
- Neither has a board yet. Module 451 opens orbit's canvas with `Deudas · saldo a favor` and `Deudas · cuotas`.

## Decision of 2026-10-14: the app is called «HomeFund»

- The visible name is **HomeFund**: the title, the installed name (`short_name` too) and the metadata. It was «Fondo compartido». The folder
  and the URL keep `orbit` and `our-piggy-bank`.

## Decisions of 2026-10-14: reconciling an account, by the user

- **A reconciliation is an adjustment movement, never a new opening balance** (RF-137): the gap stays in the history.
- **One account at a time**, not a whole-fund close.
- **The adjustment is its own line, «Descuadre»** (RF-138), outside expense and income totals and budgets.
- **When:** after pulsar's s10 and the folder rename. HomeFund has no canvas yet: this slice opens it with its boards
  (the reconcile sheet, the gap, the history, «Descuadre» in reports), and names it in `AGENTS.md`.
- **The plan's questions, 2026-10-14** (the user: «elige lo mejor»; the session's picks): the adjustment carries a mark
  (`reconciliation_id`) and its kind still derives from the accounts; a reconciliation with no gap is recorded with no movement
  and reads «Cuadró»; «Neto del mes» stays income − expense with «Descuadre del mes» beside it; «Descuadre» shows on the month
  card and in reports only when not zero, and as rows in the movements list, never in the six-month chart; the history lives in
  the «Cuadrar» dialog; a reconciliation is final (no undo, no day before the latest, a mistake is corrected by reconciling
  again); the export carries adjustments as movements, like the list (decided 2026-10-15, RF-50 and RF-118); the real figure is typed as a magnitude, its sign from the account's kind.
- **Boards approved by the user, 2026-10-15:** the 14 reconciliation boards (B1–B12) on the HomeFund canvas,
  https://claude.ai/artifact/UJsx2ugZgNoRFWMvNGmooj.

## Decisions of 2026-10-15, by the user («acepto todo lo que digas pendiente»)

- **Reconciliation screens (M3–M5) start before the folder rename.** The branch rebases across the `git mv` with `merge.directoryRenames=true`.
- **An invitation is accepted, never claimed on sign-in** (security review H1): a screen «X te invitó a su fondo · Aceptar / Rechazar», and a way to leave a fund. Board to draw before any worker.
- **Only the owner unshares a shared account** (security review M1).
- **Touch targets: 44 px minimum**, raised from 32 px, in `components/ui`.
- **«fondo», never «grupo»**, for the shared fund on every screen; «Propietario», never «Líder».

## Decisions of 2026-10-15: after the cuadre critic, by the user

- **The export keeps adjustments, flagged in the «Descuadre» column**, so a restored backup keeps every reconciliation. A total
  made by hand filters that column.
- **A real figure below zero is typed with a minus sign** («-5000»): an overdrawn asset or an overpaid card. No switch, no new
  control; one line of help under the field. Replaces «typed as a magnitude» above for that case. Not built yet.
- **«Gastos» and «Ingresos» in /movements leave adjustments out.** They show in «Todos» and under a fourth option «Descuadre» of
  the type filter. Not built yet.

## Decisions of 2026-10-15 (pending list), by the user

- **A dollar purchase on a peso card is exported and re-imported in dollars** in the backup (RF-50), with its currency, never converted to pesos. Not built yet.
- **A household bill paid from a personal card can be marked «del hogar»** and counts as a contribution to the fund. It is a mark on the movement; the contributions report (RF-66) changes. New requirement. Not built yet.
- **Seeded categories keep both sets, personal and fund.** Every screen that names a category shows its scope («Mercado · fondo»), and the importer resolves a category name by the scope of the account it lands in. Not built yet.
- **Each member keeps seeing the other's personal accounts and movements** (RF-58 stays).
- **A planned payment's reminder notifies by email** (RF-74's reminder date). It spends the free Auth email quota. Not built yet.
- **The backup restores everything:** budgets, goals, debts, statements and labels, beside what RF-50 exports today. RF-50 needs a successor code that exports all of it. Not built yet.
- **HomeFund gets WordBook's email deliverability guard and its sign-in link cap,** under a new RF code; it changes the surroundings of RF-01. Not built yet.
- **Bank statements are imported through an MCP server that Claude drives,** following GoalLog's MCP pattern: the person hands the file to Claude in a conversation, Claude reads it, calls a preview tool, the person confirms, then an import tool writes. No paid model runs inside the app. The preview is mandatory, and a re-import of the same statement never duplicates movements (RF-134's source reference is the key). Earlier statements serve as examples, never as a template. Not built yet.
- **Access is by invitation only.** Public sign-ups are off in Supabase Auth and the app keeps a list of allowed emails; the server refuses a sign-in link for an email not on the list before any email is sent. PKCE applies: a link only works in the browser that asked for it. Not built yet.

## Boards of T4, drawn 2026-10-17 (canvas «HomeFund», page «T4 · pantallas»)

- The words and structure are those of `private/plan-homefund-t4-2026-10-17.md` § Boards. The canvas draws 32 artboards: C1a–C1h
  (the reconcile sheet with a minus), C2a–C2e (movements' «Descuadre», with the laptop at 1280 and the sidebar at 768),
  C3a–C3i (each category with its scope, «{name} · fondo»), several split by surface and face.
- After a cuadre the sheet's «Según HomeFund» line carries the figure's sign as derived: an asset counted at −5 000 reads
  «−$ 5.000»; a card with a balance in its favour reads «$ 5.000».
- An adjustment row in the list is plain ink, not the transfer tone.
- Under «Descuadre» the meta shows only «N descuadres», with no net (the net is always $ 0 there).
- The categories settings screen names the fund with a heading, never on every row. A plain member sees neither edit,
  delete nor «Añadir categoría» on the fund's categories (decided by the user 2026-10-17).
- Quick entry's interpreter, the export, the template and the import keep the bare category names.
