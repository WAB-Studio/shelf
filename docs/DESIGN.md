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

## Decisions of 2026-10-17, after the T4 critic (#649), by the user

- **Your own categories inside a fund.** The phone's categories screen gains «Mis categorías» beside the fund's, and
  «Añadir categoría» asks where it goes: «Mías» or «del fondo», the second only for the fund's leader. Today nobody in a
  fund can create a personal category (`app/actions/categories.ts:34-36` writes every new one into the fund). Needs a
  board (C3i redrawn) and the action taking a scope. Not built yet.
- **«Según HomeFund» on a card uses the field's frame.** Line 3 of the reconcile sheet writes a debt as a positive amount and
  a balance in the card's favour with a minus, like the field and, since T4, the history (Visa Nu «$ 315.000»; a card in
  credit «−$ 5.000»). Line 3 redrawn on board C1. Not built yet.
- **Category selects follow the account's scope** in payments, budgets and webhook credentials, as recurring rules already do:
  once an account is picked, only the categories of its scope are offered; with no account, or «Todas las cuentas», both.
  Not built yet.

## Boards of 2026-10-17: sign in with a six-digit code (RF-146 / RL-73 / RP-136)

Board «LoginCódigo», HomeFund, 360 and 1280, inside the existing `Card`. Decided by the user 2026-10-17 (D1–D9). Not built yet.

- **Sent (`LoginCódigo`):** `MailCheckIcon` 24 centred; h2 «Revisa tu correo»; gray centred «Enviamos un código de seis
  números a {email}. Escríbelo aquí para entrar.»; `Field` label «Código del correo», `TextField` size 3, numeric
  keyboard, one-time-code autofill, 6 characters, autofocus; primary `Button` «Entrar» (the form's sizes); gray centred
  «El correo también trae un enlace: ábrelo en este navegador. Si no llega en unos minutos, revisa la carpeta de
  spam.»; outline `Button` «Usar otro correo».
- **Pending (`LoginCódigoComprobando`):** field and «Usar otro correo» disabled; «Entrar» becomes spinner + «Comprobando el código».
- **Incomplete (`LoginCódigoIncompleto`):** field invalid; `FieldMessage` «Escribe los seis números del correo.»
- **Refused (`LoginCódigoInválido`):** field invalid, code kept; `FieldMessage` «Ese código no vale o ya venció. Usa el
  del último correo o pide otro.»
- **Our side (`LoginCódigoSinRespuesta`):** `FieldMessage` «No se pudo comprobar el código. Vuelve a intentarlo; si no
  entra, pide otro.»
- **Too many (`LoginCódigoDemasiados`):** `FieldMessage` «Demasiados intentos con el código. Espera unos minutos.»
- **Done:** no board; the page navigates where the link lands.
- **Around the board:** login hint «Te enviamos un código para entrar sin contraseña.»; button «Enviar código»; pending
  «Enviando el código».
- **English:** «Check your email» / «We sent a six-digit code to {email}. Type it here to sign in.» / «Code from the
  email» / «Sign in» / «Checking the code» / «Type the six digits from the email.» / «That code is wrong or expired. Use
  the one in the latest email or ask for another.» / «We could not check the code. Try again; if it fails, ask for
  another.» / «Too many tries with the code. Wait a few minutes.» / «The email also has a link: open it in this
  browser. If nothing arrives in a few minutes, check your spam folder.» / «Send code» / «Sending the code» / «We send
  you a code to sign in without a password.»
- **The mail is shared by HomeFund, WordBook and GoalLog:** one template, no app name. Subject «Tu código para entrar:
  {{ .Token }}». The code is drawn with the example 482913 in place of `{{ .Token }}`. The link beside the code is
  `{{ .ConfirmationURL }}`, the PKCE link: it works only in the browser that asked. The text part carries the link as a
  bare URL. The subject is painted by the mail client and is not part of the body.
- **Member invitation mail:** keeps the shared template; it will show a code.
- **An interrupted code step comes back:** the address is kept on the device for the code's hour and the screen reopens on
  the code step; «Usar otro correo» or a code that lands clears it.

## Decisions of 2026-10-17, after the critic of the six-digit code (#651), by the user

- **Another code: a «Pedir otro código» button on the code step, with a countdown.** It sends a new code to the same address without typing it again; a send that Auth refuses gives the daily send back. Its boards are not drawn yet.
- **The member invitation gets its own path (supersedes the 2026-10-17 «keeps the shared template» line above).** Inviting adds the invitee to the invitation list and sends its own mail in its own words; the invitee signs in by asking for a code at `/login`. Its boards are not drawn yet.
- **The code mail names its sender and carries one English line.** One shared template still; a sender name and a short English line under the code. Its board is not drawn yet.

## Decisions of 2026-10-17 (afternoon), by the user

- **A past month's weekly budget shows that month's last week.** Navigating to a past month, the weekly budget reads the
  last week of that month, not the current one. Not built yet.

## Boards of 2026-10-17: «Pedir otro código» and the mails (codigo-6b)

Canvas «HomeFund», page «Entrar con código», from y=2100. Not built yet.

- **«LoginCódigoOtro»** (360 five states, 1280 waiting), inside the code step's `Card`: under the gray hint «El correo
  también trae un enlace…» and above «Usar otro correo», a soft `Button` at the form's sizes.
  - Waiting: disabled «Pedir otro en {seconds} s», counted from the last send (60 s).
  - Ready: «Pedir otro código».
  - Pending: spinner + «Enviando otro código»; the field, «Entrar» and «Usar otro correo» disabled.
  - Done: a status line above the field, «Te mandamos otro código a {email}. Usa el del último correo.»; the field
    empty and focused; the wait restarts.
  - Refused: the send's toast (where the app's toaster puts it), the button ready again.
- **Words of the cap toasts:** «Ya pediste varios códigos hoy. Usa el último que te llegó o vuelve mañana.» and «Pediste
  demasiados códigos seguidos. Espera un momento y vuelve a intentarlo.» The page description: «Entra con un código
  enviado a tu correo, sin contraseña.»
- **«CorreoV2»** (HTML and text): the code mail gains a muted English line after the code, «Your sign-in code: type it
  on the screen where you asked for it. It expires in one hour.», and the sender name «Acceso a tus apps» (decided by the user 2026-10-17; one name for the three apps, since they share the template and the Supabase project). The name shows only with the hosted project's own SMTP; the local stack's mailpit does not draw it. It
  supersedes the 2026-10-17 «no app name» line above for the sender only; the old mail boards moved to «Archivo».
- **«CorreoInvitación»** (new): subject «Te invitaron a HomeFund»; «Te agregaron a un fondo compartido en HomeFund, para
  llevar juntos las cuentas de la casa.»; «Para entrar, abre HomeFund (link to `/login`) y escribe este correo: te
  mandaremos un código de seis números. No hay contraseña.»; muted English «You were invited to a shared fund on
  HomeFund. Open the link above and type this email to get a sign-in code.»; muted «Si no esperabas esta invitación,
  ignora este correo.» No code, no sign-in link, no inviter or fund name.
- No board for the members dialog's warning; it waits on the user's answer.
