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

## Violeta y lima

Decided by the user 2026-10-30: the recipe of Agenda Amiga (a title face with character, one strong colour and one
highlight, a white ground, pill buttons), with HomeFund's own palette and faces.

- Ground: white in light, `#110c20` in dark. Text ink: `--brand-ink` `#1a1033`.
- Accent: Radix `violet` with steps 9 to 11 replaced in `app/theme.css`. Gray: `mauve`.
- Highlight: `--brand-lime` `#c8f560`. Use it only on the ink or the violet, never as text on white.
- The net-worth card is the brand block: ink ground, its figure in lime, its content on Radix's dark tokens.
- Titles: Bricolage Grotesque 700, tracking −0.025em. Text and figures: Figtree with tabular numbers.
- Buttons and icon buttons are pills (`radius="full"` by default in `Button`).
- Success stays `jade` (paid, reached, income bars): a state, never the brand.

## Tokens

| Token | Light | Dark | Ratio |
|---|---|---|---|
| `--focus-8` (ring) | `--violet-11` `#5b2ee5` | `--violet-11` `#b8a3ff`; a control with its own colour rings at its `--accent-11` | light 7.08:1 on white; dark 8.50:1 on `#110c20` |
| `--violet-9` (primary button) | `#5b2ee5` | `#5b2ee5` | 7.08:1 with white |
| `--violet-10` (primary hover) | `#4a22c4` | `#4a22c4` | 9.06:1 with white |
| `--brand-lime` on `--brand-ink` | `#c8f560` on `#1a1033` | same | 14.31:1 |
| `--red-9` (danger button) | `#d13a3f` (Radix `#e5484d` was 3.91:1) | `#d13a3f` | 4.79:1 with white |
| `--red-10` (danger hover) | `#c42a2f` (Radix `#dc3e42` was 4.37:1) | `#c42a2f` (Radix `#ec5d5e`) | 5.65:1 with white |

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
- `Deudas · saldo a favor` is drawn (boards `DeudasAFavorMovil`, `DeudasEnCeroMovil`, `DeudasBolsilloAFavorMovil`, page «T4 ·
  pantallas», 2026-10-22, module M12): the row's figure reads «A favor $ 150.000» (`debts.inFavour` «A favor {amount}») in
  `--accent-11`; no «Pago mínimo» and no interest line for a card in credit or at zero (both are 0 and are not drawn); «Corte»
  stays; «Cupo disponible · …» adds the credit to the limit. At zero the figure is «$ 0» in the normal ink. «Deuda total» and
  «Interés mensual» never count a credit. A pocket in another currency reads by its own sign under the settlement figure
  («A favor US$ 20» under «$ 80.000»). The laptop's table uses the same figure and tone in its balance column; not drawn apart.
- `Deudas · cuotas` is built under RF-136 (2026-11-10), words only, no board: the debt's detail lists «Compras diferidas»
  in a `Panel`, one `PanelRow` per purchase linking to its movement, «Cuota 3 de 36 · $ 12.345 al mes» at the end or
  «Extinguida»; the section is absent while nothing is deferred. A purchase on a card offers «Diferir en cuotas» in a
  `Panel` on the movement's detail (phone and laptop); it opens a dialog with one field, «Número de cuotas» (2 to 72), and
  «Confirmar diferido». «Quitar diferido» replaces the button once deferred. The balance, «Deuda total» and «Pago mínimo»
  never change with it. A statement line printing «1/36» reaches the person through the MCP preview as «Diferir en 36
  cuotas»; accepting the preview confirms it.
- `Deudas · diferidos de la tarjeta` is built under RF-258 (2026-11-17), words only, no board: the debt's detail, and Deudas
  under the table, list «Diferidos de la tarjeta» in a `Panel`, one `PanelBlock` per deferral: the description with the pending
  balance at the end, «Cuota 7 de 24 · $ 335.000 al mes · 28,1 % E.A.», «Autorización …» (and «En <tarjeta>» on Deudas). One that
  charges interest adds «Interés de este mes ~$ X», «Si lo pagas hoy te ahorras ~$ X» and an amber `Callout`: «Esta compra quedó
  a 36 cuotas; te costará ~$ X de interés. Págala completa o cámbiala a 1 cuota en tu banco». The section is absent while the
  card has none; the balance and the minimum never change with it.

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
- **A household bill paid from a personal card can be marked «del hogar»** and counts as a contribution to the fund. It is a mark on the movement; the contributions report (RF-66) changes. Built 2026-10-30 (RF-139): a «Del hogar» switch on the movement form, offered on an expense from a personal account to someone with a fund; or kept visible on a movement that carries it so it can be cleared. The bill books as its account settled it, an archived member keeps their past bills, and the mark travels in the backup's «Del hogar» column.
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
  last week of that month, not the current one. Built in #613 (`lib/dates.ts:161-164`); the user closed it with no
  module on 2026-10-17 (decidido-17 Q5).

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

## Decisions of 2026-10-17, after the critic of codigo-6b, by the user

- **Inviting after onboarding: an optional «correo» field in the members dialog.** «Añadir miembro» with an address
  invites, and the dialog's warning becomes reachable. Level 3 (it sends mail and lists the address). Board «MiembroCorreo»
  below. Built in codigo-6c (#657), RF-149.
- **Inviting an address Auth already holds: words only.** The warning reads «…no pudimos enviar el correo; puede entrar
  ya en HomeFund con ese correo». The person gets no mail. Built in codigo-6c (#657).
- **The per-caller daily cap rises from 5 to 10** (`SIGN_IN_LINK_DAILY_CLIENT_CAP`, HomeFund and WordBook); the address
  cap stays at 3, and a refused tap still spends. Built in codigo-6c (#657).

## Boards of 2026-10-17: «MiembroCorreo», adding a member with an address (codigo-6c)

Canvas «HomeFund», page «Miembros». 360 seven states, 1280 empty. Built in codigo-6c (#657).

- «Añadir miembro»: «Nombre», then «Correo (opcional)» with the gray hint «Si lo escribes, le mandamos una invitación
  para entrar a HomeFund.», then «Cancelar» / «Guardar». With an address, «Guardar» invites.
- States: empty; invalid address (the field's error, `members.errors.emailInvalid`); saving (inputs and buttons
  disabled, spinner on «Guardar»); sent (the dialog closes, «Miembro añadido.» and the new row with «Invitación
  pendiente» and the address in gray under the name); mail not sent (the same, plus the warning «Añadimos a la persona,
  pero no pudimos enviar el correo; puede entrar ya en HomeFund con ese correo.»); already invited (the field's error
  «Ese correo ya tiene una invitación en este grupo.», from the dialog and from onboarding); «Editar miembro» shows the address field only for a member with no login and no pending invitation (RF-153, boards «MiembroCorreo · editar …» of 2026-10-18).
- Onboarding's warning toast reads the same new words.
- The address line on the row is new: today's member card shows no address.

## Boards of 2026-10-17: «Mis categorías» (C3i redrawn) and «Dónde va» (C3j) (decidido-17)

Canvas «HomeFund», page «T4 · pantallas», from y=4164. 360, seven boards. The two earlier C3i boards are in «Archivo».
Words and structure (keys are `categories.*`; sample names are data, not copy):
Data names (Gimnasio, Salidas, Cine, Restaurantes, Mercado, Verduras, Carnes, Transporte, Servicios, «Casa») are sample data, not copy.

### C3iCategoriasMiasLiderMovil (leader, in a fund)
1. `h1` «Categorías» (`title`), then the button «Añadir categoría» (`add`), then the Gastos/Ingresos toggle (`expenseTab`, `incomeTab`).
2. `h2` «Mis categorías» (`personalSection`), then own cards with a menu on every row: Gimnasio (0 subcategorías), Salidas (2: Cine, Restaurantes). `subcategoryCount`.
3. `h2` «Casa» (fund name), then the fund's cards with menus: Mercado (2: Verduras, Carnes), Transporte, Servicios. No `leaderOnly` line.

### C3iCategoriasMiasMiembroMovil (plain member, in a fund)
1. Same top: `h1`, button «Añadir categoría» (the member now has it), toggle.
2. `h2` «Mis categorías», own cards with menus (as the leader's).
3. `h2` «Casa», then the line `leaderOnly` «Pide al propietario del fondo que cree o cambie las categorías del fondo.», then the fund's cards with no menu on any row.

### C3iCategoriasSinFondoMovil (no fund)
`h1`, button «Añadir categoría», toggle, one list of cards with menus (Mercado 2, Transporte, Servicios). No section heading, no «Mis categorías», no fund name. Today's screen.

### C3iCategoriasMiasVaciaMovil (member, no own category of the kind)
1. `h1`, button «Añadir categoría», toggle.
2. `h2` «Mis categorías», then the empty state, centred: title `personalEmptyTitle` «Todavía no tienes categorías propias»; description `personalEmptyDescription` «Crea una categoría tuya para clasificar los movimientos de tus cuentas personales.»; action button «Añadir categoría» (the same `addButton` the top row holds, as today's empty state does).
3. `h2` «Casa», the `leaderOnly` line, fund cards without menus (Mercado 2, Transporte).

### C3jDondeVaLiderMovil (leader, «Añadir categoría»)
Dialog title `addTitle` «Añadir categoría». Fields in order: Nombre (`nameLabel`) · Dónde va (`placementLabel`) a Select, default «Del fondo» (`placementGroup`), drawn open with two options in this order: «Del fondo» (selected, check), «Mías» (`placementPersonal`) · Categoría principal (`parentLabel`) Select, «Sin categoría principal» (`parentNone`) · Tipo (`kindLabel`) as text «Gasto» with `kindLocked` beneath · Color (`colorLabel`) swatches · buttons «Cancelar», «Guardar» (`common.cancel`, `common.save`). Changing the placement re-reads the parent list and the default colour.

### C3jDondeVaMiembroMovil (plain member or no fund)
Same dialog with no «Dónde va» field at all: one placement offered means no Select and no line. The category goes to «Mías» by the server and the dialog says nothing. Fields: Nombre · Categoría principal (personal parents only) · Tipo + `kindLocked` · Color · «Cancelar» / «Guardar».

### C3jDondeVaEditarMovil (edit)
Title `editTitle` «Editar categoría». Fields: Nombre «Gimnasio» · Dónde va as a label with the text «Mías» and `placementLocked` «El lugar no se puede cambiar después de crear la categoría.» beneath (same pattern as the Tipo line; the labels dialog's precedent) · Categoría principal · Tipo + `kindLocked` · Color · buttons. The edit sends no `placement`.

Field order in every create dialog: Nombre, Dónde va, Categoría principal, Tipo, Color (placement before parent because it decides the parent list; name first as in the labels dialog).

Board C1h corrected the same day: a card in credit reads «Según HomeFund −$ 5.000» on line 3, the field's frame
(decision above). Built in decidido-17 (#659).

## Decisions of 2026-10-17 (night), after the critic of codigo-6c and the decidido-17 plan, by the user

- **«Mis categorías» opens no code** (Q2 a): RF-63 already scopes a category to a person or a group and RF-57 gives the
  fund's to its leader; decidido-17 makes that reachable inside a fund.
- **From onboarding, «Agregar sin correo» asks for the name alone** (Q1 a); «Añadir miembro» on «Miembros» keeps
  «Correo (opcional)». Note on board «MiembroCorreo». Built in decidido-17 M2.
- **A budget takes the place of the account it is on** (Q6 a): a personal account gives a personal budget, a fund's
  account the fund's. Today every budget inside a fund is the fund's (`app/actions/budgets.ts:76`). Level 3. Not built yet.
- **Inviting someone already in this fund is refused** (critic codigo-6c, 1 a): an address that is a live member of
  this fund, the leader's own included, is refused with «Esa persona ya está en este grupo.»; the warning for an
  address Auth already holds is reworded so it no longer promises entry into this fund. Another fund is never looked
  at. Level 3. Not built yet.
- **An archived invitation no longer blocks a new one** (critic codigo-6c, 2 a): the unique index on a group's invite
  address skips archived rows, so inviting again creates a fresh pending member; the archived row stays as history.
  A migration, level 3. Not built yet.
- **An address whose domain takes no mail is refused when inviting** (critic codigo-6c, 3 a), with `/login`'s own
  words, from the dialog and from onboarding. One DNS lookup per invitation; a domain whose DNS is down at that moment
  is refused. Level 3. Not built yet.

## Decisions of 2026-10-17 (late night), on the critic-6c plan, by the user

- RF-150, RF-151 and RF-152 opened (Q0 a).
- A budget on «Todas las cuentas» inside a fund takes its category's place (Q1 a).
- The warning when the invitation mail is not sent: «Añadimos a la persona, pero no pudimos enviar el correo. Avísale que
  entre con ese correo; si ya está en otro grupo, no se unirá a este.» (Q2 b).
- `errors.categoryNesting` is reworded to hold for depth and for place; no new string (Q4 a).
- Restoring an archived invitation whose address has a newer pending one is refused with «Ese correo ya tiene una
  invitación en este grupo.» (Q5 a).
- A DNS outage while inviting: the `/login` guard as it is; the invitation goes through (Q6 a). Supersedes «a domain whose
  DNS is down at that moment is refused» above.
- Pending invitations that already exist for a live member are left; the leader deletes them (Q7 a).
- Note on board «MiembroCorreo»: the address field also shows «Esa persona ya está en este grupo.» and `/login`'s
  no-mail refusal; from onboarding the dialog asks for the name alone.

## Decisions of 2026-10-17 (closing), after the critic of decidido-17, by the user

- **The card's gap on «Cuadrar» reads in the field's frame** (Q1 b): typed debt 400.000 against «Según HomeFund
  $ 404.900» reads «−$ 4.900», so the three figures subtract; the tone keeps saying good or bad. Level 2, board C1
  redrawn. Not built yet.
- **«Editar miembro» gains «Correo (opcional)»** (Q2 a) for a member with no user and no pending invitation; saving it
  invites, as RF-149 does from «Añadir miembro». Level 3, board «MiembroCorreo» redrawn. Not built yet.
- **The «Añadir categoría» inside «Mis categorías» opens on «Mías»** (Q3 a); the top button keeps «Del fondo». Level 2.
  Not built yet.
- **Orphaned personal subcategories** (critic-6c Q8 b): migration 0061 deletes the ones nothing uses and brings back as
  top-level categories the ones a movement, budget, payment or rule names, before it adds the cascading key.
- **«Eso ya no existe.» stays** (critic-6c Q9 a) for a write to an account the person cannot use.

## Decisions of 2026-10-18, on the cierre-d17 plan, by the user

- «Editar miembro» with an address opens **RF-153** (Q0 a); RF-149 stays as written.
- When an edit saves the address but the invitation mail is not sent, the warning is a key of its own,
  `members.editEmailFailed`: «Guardamos el correo, pero no pudimos enviar la invitación. Avísale que entre con ese correo;
  si ya está en otro grupo, no se unirá a este.» (Q1 b).
- Only the phone's empty-state button inside «Mis categorías» opens «Añadir categoría» on «Mías» (Q2 a). A button under a
  non-empty «Mis categorías» and an empty state at 1280 do not exist and are not planned.
- Boards drawn 2026-10-18 on the HomeFund canvas. Page «T4 · pantallas»: C1i (a card owing $ 404.900, typed 400000,
  «Descuadre −$ 4.900» in the good tone), C1j (owing $ 120.000, typed 130000, «+$ 10.000» in the plain dark tone), C1k (the
  history in the field's frame: «−$ 4.900», «−$ 5.000», «−$ 20.000»); C1h moved to «Archivo». Page «Miembros»: «Editar
  miembro» on «Abuela», a member with no login and no invitation: empty with the hint «Si lo escribes, le mandamos una
  invitación para entrar a HomeFund.», saving, done («Miembro actualizado.», the row «Invitación pendiente» with the address
  in gray), mail not sent (`members.editEmailFailed` as a warning toast), and the three refusals on the field
  («Esa persona ya está en este grupo.», `errors.domainUndeliverable`, «Ese correo ya tiene una invitación en este grupo.»).
  No desktop board: the same dialog opens from the 1280 row menu. A note on C3iCategoriasMiasVaciaMovil: the empty state's
  button opens on «Mías».

## Decisions of 2026-10-18, after the critic of critic-6c, by the user

- «Editar presupuesto» offers only the accounts of the budget's place (Q1 a): a personal category's budget the person's own
  accounts, a fund category's the fund's; the scope refusal reads on its field inside the dialog, at 360 too. Level 2. Built
  (respuestas-18, M1).
- A delete blocked by a subcategory in use (Q2 a): `errors.categoryInUse` reads «Esta categoría, o una de sus subcategorías,
  está en uso y no se puede eliminar.», for the parent and the subcategory alike; no query names the child.
- Q-A (a), 2026-10-18: the label list of «Nuevo presupuesto» and «Editar presupuesto» is cut by the budget's scope too, as the
  accounts are.
- Q-B (b), 2026-10-18: toasts hidden under an open dialog at 360 across HomeFund are fixed in the next train by the toast
  primitive itself, for every dialog; this train moves only the budget dialog's scope refusal onto its field.
- Boards: C3k «Editar presupuesto · cuentas de su ámbito» and C3l «Editar presupuesto · rechazo en el campo» (HomeFund
  canvas, page «T4 · pantallas», 2026-10-18); no desktop face, the dialog is the same.

## Decisions of 2026-10-18, on the dependency map of the open findings, by the user

- **A stale edit is refused** (Q1 a): when a money form was opened before the row changed (another form, or the 00:15
  cron), saving reads «Esto cambió mientras lo editabas. Vuelve a abrirlo.» and nothing is saved.
- **An invitation is accepted** (Q2 a): RF-154 opened. Not built yet. Boards on the HomeFund canvas, page «Miembros»,
  2026-10-18:
  - «Invitación» (six boards): on signing in, before Inicio, a card «Invitación» · «Carlos te invitó a su fondo «Casa»» ·
    «Si aceptas, los miembros de «Casa» verán tus cuentas y movimientos personales, y tú verás los suyos y los del
    fondo.» (RF-58 reads a member's personal accounts) · «Si rechazas, sigues con tus cuentas solo para ti. Puedes unirte
    más tarde si Carlos te invita otra vez.» · «Aceptar» (primary, full width) over «Rechazar» (ghost). While accepting
    both wait («Aceptando…»). Accepted: Inicio with «Ya eres parte de «Casa».». Declined: Inicio with «Rechazaste la
    invitación de Carlos.». Gone: «Esta invitación ya no está vigente» · «Carlos la retiró o ya pasó. Si quieres unirte a
    «Casa», pídele que te invite otra vez.» · «Ir a mis cuentas». Already in another fund (RF-55): «Ya estás en el fondo
    «Familia Ruiz»» · «Se puede estar en un solo fondo. Para unirte a «Casa», sal primero de «Familia Ruiz» desde
    «Grupo».» · «Ir a mis cuentas». No invitation: the screen does not exist.
  - «Salir del fondo» (five boards): a last card in «Grupo», «Salir del fondo» · «Lo que escribiste en «Casa» se queda con
    el fondo. Tus cuentas personales vuelven a ser solo tuyas.» · a soft «Salir del fondo» button. It opens «¿Salir de
    «Casa»?» · «Lo que escribiste en el fondo se queda con el fondo: sus cuentas, sus movimientos y lo que anotaste en
    ellas.» · «Tus cuentas personales vuelven a ser solo tuyas: los miembros de «Casa» dejan de verlas.» · «Cancelar» and
    the red «Salir del fondo»; while leaving «Saliendo…». Done: Inicio with «Saliste de «Casa». Tus cuentas siguen
    contigo.» and the fund leaves the shell. The leader with other members: «No puedes salir todavía» · «Eres el líder de
    «Casa». Antes de salir, pasa el liderazgo a otro miembro desde «Miembros».» · «Entendido» (RF-59). A leader alone in
    the fund leaves like anyone. No desktop face for either.
- **A planned payment's reminder mails its author** (RF-141): at 7:00 Bogotá on the reminder date, one plain-text mail
  «Recordatorio: <nombre> vence el <fecha>» with the amount and a link to «Pagos». A fund payment mails its author only
  while they are in the fund; moving the reminder date mails again; a payment past its due date is not mailed.
- **The five open debt cases** of the 2026-10-15 audit (Q7 a) are settled one by one in a question session before their
  module; the rest of the debt fixes do not wait.
- **Deleting what an ingest rule learned from keeps the rule** (Q8 a), its target set to null: the next delivery proposes
  no account or category.
- **Quick entry reads thousands and millions** (Q12): «mil» and «k» are a thousand; «m», «millón» and «millones» are a
  million. «mil» never means a million («mil pesos» is a thousand). Refined the same day (Q12-b, c, d): «m» is a million
  only right after the number («5m») or as the amount's last word («2 m»), never when text follows («5 m de cable»);
  «millon» without the accent is a million; «mil» alone proposes 1.000. When the «m» has words after it («3 M arriendo»), the sheet asks «¿Cuánto es «3 M»?» with the bare number and the
  million as two choices, and saves nothing until one is picked or an amount is typed (Q12-e; boards C3m, C3n); «un millón»
  with no number before it proposes 1.000.000 (Q12-f a).
- **Contrast** (Q6 a): every token under WCAG is darkened to the nearest same-hue value that passes, and this file's token
  table follows. Not measured yet.
- **Shared packages** (Q11 a): `@repo/sign-in` and `@repo/caller` are promoted once GoalLog's call wrapper and WordBook's
  sign-in settle their shapes.
- **Region** (Q13 b): HomeFund's and WordBook's Vercel region is measured with `vercel inspect` before anything is pinned.
- **«Revisar el mes»** (2026-10-18, the user's idea): RF-155 opened. A screen and an MCP tool list the month's anomalies
  by fixed rules; Claude does any AI review through MCP. The screen ships in oleada-7; the MCP tool `review_month`
  lands with RF-144's server, reading the same query, and RF-155 stays open until then (O7-Q4 a, 2026-10-24). Built 2026-10-30: `review_month` on `/mcp`, closed months only.
  Shipped on oleada-7: `/reports/review` (from «Reportes» and Inicio's «Revisar <mes> · N movimientos», which counts
  movements, a twin pair as two) and quick entry's `amount_from_words`. The MCP tool still waits for RF-144.
- **Quick entry, lowercase «m»** (critic C2 b, later the same day): a lowercase «m» is never a million; only «M» or
  «millón/millones» multiply. «25 m» is 25, «5 m de cable» is 5; «3 M arriendo» asks. Supersedes the «m» lines above.
- **Fund labels read «· fondo»** in the budget forms (critic C1 a), as categories do.
- **RF-156 and RF-157 opened** (Q24 a): the stale-edit refusal, and the paused rule's reason with the 12-month limit on a
  rule's next run (Q16 a, Q17 a).
- **A foreign purchase estimated on a debit account is confirmed on the account in «Cuentas»** (Q18 a). Boards C4a–C4d
  (HomeFund canvas, page «T4 · pantallas», 2026-10-18): the account card gains a section «Compras en otra moneda», one
  line per pending purchase («Netflix · 12 oct», what was spent in its currency, «Estimado ≈ $ …») and a «Confirmar
  monto» button for whoever can write the account. The button opens «Confirmar monto» with the debt screen's body:
  «Gastado», «Estimado», the field «Monto facturado» (hint «Lo que el banco cobró en pesos.») and «Tasa»; «Cancelar» and
  «Guardar monto». M54's refusal («Ya cuadraste esta cuenta después de esa compra: confírmala desde el cuadre.») shows
  under the field and the dialog stays open. Saved: «Monto facturado guardado. Reemplaza el estimado.» and the line
  leaves the card. No pending purchase: the card is as today (no board). No desktop face.
- **A second «efectivo» stays allowed** (Q23 a); the first withdrawal's race is closed by a lock, with nothing visible.
- **A resend with another amount is refused** (Q25 b, RF-158): «Ya guardamos este movimiento con otro monto; ábrelo para
  corregirlo.» and nothing is saved. Not built yet.
- **One send never changes scope** (Q26 a): the same send to a personal account and then to a fund account books two rows;
  the form keeps one scope per opening, so no cross-scope check is built.
- **Quick entry asks on a lowercase «m» too** (Q27 b, later the same day): «25 m» and «5m arriendo» ask «¿Cuánto es «25 m»?»
  with $25 / $25.000 / $25.000.000 and save nothing until one is picked or an amount is typed; «M» and «millón» keep
  asking as before. Supersedes «a lowercase «m» is never a million» for what is saved without a question. Not built yet.
- **«Recordarme el» shows on Inicio** (Q28 a, RF-159): from the reminder date until it is paid or archived, the planned
  payment shows on Inicio. Boards C5a, C5b (HomeFund canvas, page «T4 · pantallas», 2026-10-18): a card «Por pagar» above
  «Movimientos», one row per payment: its name, «Vence el 15 dic» (or «Venció el 15 oct» in red once the due date has
  passed) and its amount; oldest due first; at most three, the link reads «Ver los 5» when there are more, else «Ver
  pagos». A row leaves when the payment is paid or archived; a payment with no reminder, or whose reminder date has not
  come, is not shown; none, and the card does not exist. A row opens that payment in «Pagos». RF-141's email goes out the same morning.
- **A sign-out Auth refuses leaves this device signed out** (Q30 a): the session is never restored; the login says
  «Cerraste sesión aquí, pero no pudimos cerrarla en tus otros dispositivos.»

## Decisions of 2026-10-18, on plan oleada-4, by the user

- **A parent category's budget and its movement filter count its subcategories** (Q1 a): RF-72 retired, RF-160 opened.
  Not built yet.
- **«Ajustes del fondo» on the phone** (Q8 a): a row «Ajustes del fondo» at the top of «Ajustes», for the leader only. M1
  measured it unreachable at 360 px (only the desktop rail's chevron leads there). Board and level-2 module in the slice
  after oleada-4.

## Decisions of 2026-10-22, on plan oleada-5, by the user

- **«Ajustes del fondo» on the phone is for every member of a fund** (Q1 a), like the desktop rail's chevron; it replaces
  the 2026-10-18 Q8 «leader only» above. A member leaves the fund from that page (RF-154). Module M13. Boards
  `AjustesFondoMiembroMovil` and `AjustesSinFondoMovil` (page «Miembros», 2026-10-22): below `md`, «Ajustes del fondo»
  (`nav.fundSettings`, the gear icon) is the first row of the «Ajustes» list, on the screen and in the bottom bar's sheet,
  emphasised over the rows under it, and leads to `/settings/group`. No fund: no row (and no «Miembros», as today). From `md`
  up there is no such row: the chevron beside the fund name owns it, so the desktop board was not drawn.
- **Deleting a movement that settled a planned payment puts the payment back to «Por pagar»** (Q4 b): RF-75 is retired
  and RF-161 opens when the module is built (migration 0069). Next train.
- **A movement dated before its account's opening day is refused** (Q5 a), on save and on import, in words. Next train.
- **Where and how it is refused** (Q11 a, Q12 a, Q13 b, Q14): the database refuses it on every path; an account's opening
  cannot move past one of its movements; movements already stored before their opening stay, and the main session counts
  them read-only in production before the deploy. The words:
  - Deleting a movement that settled a payment: «Este movimiento saldó «{name}». Al eliminarlo, el pago vuelve a «Por
    pagar».» With no name: «Este movimiento saldó un pago planeado. Al eliminarlo, el pago vuelve a «Por pagar».»
  - Saving a movement before the opening: «La fecha es anterior a la apertura de la cuenta. Cambia la fecha o la apertura
    de la cuenta.»
  - An import row: «Fecha anterior a la apertura de su cuenta.»
  - Moving the opening past a movement: «Hay movimientos antes de esa fecha. La apertura no puede quedar después de ellos.»
- **A card in credit with a dollar purchase still to bill reads both, apart** (Q9 a): «A favor $ 8.000 · Debes US$ 25
  (≈ $ 105.000 por facturar)». Currencies never sum (RF-124).
- **Boards of oleada-6** (HomeFund canvas, page «T4 · pantallas», 2026-10-22):
  - `MovimientoEliminarSaldoPagoMovil` (M4): the delete confirmation of a movement that settled a payment names it, or says
    «un pago planeado» when it has no name; one that settled nothing keeps «Esta acción no se puede deshacer.» Pending: both
    buttons disabled, a spinner on «Eliminar». Refused: the action's own toast, the dialog stays. Done: the payment is under
    «Por pagar» in Planeación. The laptop detail and the list row use the same dialog: no 1280 board.
- **Decided by the user 2026-10-23, after oleada-6's critic:**
  - Toasts draw above dialogs in the whole app, so a refusal raised from a dialog is seen. RF-162's refusal also shows inside
    the movement form, beside the date, and inside the account form, beside the opening day.
  - «Abonar» on a card whose pesos are in credit while another pocket owes reads the row's whole line: «A favor $ 8.000 ·
    Debes US$ 25,00 (≈ $ 105.000 por facturar)», under the card's name (fourth state of `DeudasAbonarAFavorMovil`).
  - A bank notice in the Bandeja dated before its account's opening is incomplete: «Anotar» opens the form with the date
    showing, never the one-tap save.
  - `DeudasAbonarAFavorMovil` (M5): the dialog's balance beside the debt's name. Owing: the amount in ink. In credit: «A favor
    $ 150.000» whole in the accent, no sign. At zero: «$ 0» in ink.
  - `DeudasProximoPagoSinDeudaMovil` (M5): with only cards in credit or at zero, «Próximo pago» reads «—» and has no note.
  - `DeudasAFavorPorFacturar` (M5, Q9 a): «A favor $ 8.000» in the accent, then «· Debes US$ 25» in ink, then «(≈ $ 105.000 por
    facturar)» muted. At 360 it wraps only at « · » or before the parenthesis; at 1280 it sits right-aligned in «Saldo». A
    billed purchase drops the parenthesis. Pesos that owe keep today's drawing. Each « · » closes the figure before it and
    takes its ink, so a wrap never opens a line with it: accent after «A favor», muted after «por facturar».
- **Decided by the user 2026-10-24, on oleada-7 and the short critic of oleada-6's fixes:**
  - «Revisar el mes» (O7-Q1 a): from the 1st, Inicio shows one line «Revisar septiembre · 4 movimientos» while last month
    has unmarked items; the screen opens from it and from «Reportes» for any closed month.
  - «Muy por encima de lo usual» (O7-Q2 a): an expense split more than three times the median of the same category's splits,
    same currency, over the six months before, counted only when that history holds at least three splits.
  - «m / mil» (O7-Q3 a): migration 0072 adds `transactions.amount_from_words`, true when quick entry saved the amount its
    interpreter read from words («25 mil») and the person did not retype it. Months before the deploy show no such item.
  - The phone debt card (Q17 a): the Q9 line sits under the card's name, never beside it; the name keeps the row's whole width
    and wraps between words. Each card grows about 40 px. Supersedes the side-by-side drawing of `DeudasAFavorPorFacturar` at 360.
  - The debt detail's «Saldo» tile (Q18 a): it reads the row's whole Q9 line, as the row and «Abonar» do: «A favor $ 8.000 ·
    Debes US$ 25,00 (≈ $ 105.000 por facturar)»; a card that only owes reads «Debes US$ 20,00».

- **Decided by the user 2026-10-28, on oleada-7's critic** (not built yet; each opens the next free RF when planned):
  - «Está bien» is undoable: a reviewed row under «Revisados» offers «Deshacer», which drops its mark and brings it back
    to Inicio's count. A delete policy and a migration; RF-155's own behaviour stays.
  - A reader in «Revisar el mes» sees the fund's items with neither «Está bien» nor «Corregir», and one line naming who
    can fix them.
  - A movement's `amount_from_words` clears when an edit changes its amount: a typed amount is the person's own.
  - Still to fix from the same critic, no decision needed: the row names the movement's description; «Corregir» comes back
    to the review; the debt detail's header reads the Q9 line as its «Saldo» tile does (Q18 left the header in pesos).

## Decision of 2026-11-17: «Revisar el mes» flags only real surprises, by the user

- «este no es nada inteligente» (RF-239): a whole grocery trip and a 3 kg purchase each read «¿Es correcto este monto?» because the rule
  compared each with three times the median of the category's split lines, and the household writes groceries as many small lines.
  The rule now compares the whole movement with the earlier ones of its description, else of its category; see RF-239 for the numbers.
  Supersedes O7-Q2 a above.
- The line under «¿Es correcto este monto?» says what the amount was set against, in words a person says aloud: «Tus gastos en
  «Mercado en Ara» suelen ser de $ 40.000 a $ 80.000, según 12 veces en los últimos 6 meses.» A category reads «Tus gastos en Mercado
  suelen ser de … según 20 movimientos de los últimos 6 meses.» Never «mediana». One figure when both ends are equal.

## Decisions of 2026-11-11: HomeFund from an iPhone, by the user

- «Ajustes · Correos del banco» has an «Atajo de iPhone» card under «App para Android»: one line on what it does, then
  «Gasto escrito» (six numbered steps) and «SMS del banco» (three), pointing at the URL of «Cómo enviar un movimiento»,
  and a gray line saying a delivery waits in the Bandeja. Steps name the Shortcuts actions as iOS names them.

## Decisions of 2026-11-11: HomeFund's widget on the iPhone, by the user

- «Ajustes · Correos del banco» has a «Widget del iPhone» card under «Atajo de iPhone»: one line on what it shows, then
  six numbered steps (install Scriptable, copy the script, create the key, paste the key on the script's first run, add
  the widget and choose the script, hide the amounts), and a gray line saying a tap opens the Bandeja and revoking the key stops it.
- Step 2 carries the script in a copy block and its address in another; step 3 carries «Crear clave para el widget» and
  shows the key once under the same warning as a webhook token. A widget key opens the widget's summary and nothing else;
  in the key list it wears the badge «Widget».
- The widget reads «Disponible» large, the month as what is left (medium «Te quedan $X este mes · $Y por día»; small and lock screen «$Y/día» over «quedan $X»; red «Te pasaste $X» once the budget is passed; «Gastado $X» with no budget) and the Bandeja's count
  («N por revisar», «Bandeja al día» at zero) in amber. The medium widget adds one line per credit somebody else pays,
  up to three and then «y N más», like «John: pagó ✓ · cuota en 6 días» (amber while the payment is missing).
- The widget has a private mode: its Parameter «privado» or «oculto» (any case or accent) draws every amount as «$ •••••»,
  and «visible» always draws them; with no parameter the menu of the script in Scriptable («Ocultar montos» / «Mostrar
  montos», and «Cambiar llave») decides. The Bandeja's count, the ✓ and the days to the installment still show. A sixth
  step on the card says so. Pesos have no cents («$1.234.567»). Small and medium on the home
  screen; rectangular and inline on the lock screen. Offline it shows the last figures with «Sin conexión».

## Decisions of 2026-11-11: Gmail's bank emails from the PC, by the user

- «Ajustes · Correos del banco» has a «Correos del banco» card above «Cómo enviar un movimiento»: one line on what it does, six
  numbered steps for a member who is not technical (step 4 carries «Crear credencial», which opens the same dialog as the
  table's), and «Datos de Google» with the `<id> <secreto>` line in a copy block, or one gray note when the server has no
  such data.

## Decisions of 2026-11-11: HomeFund installed on an iPhone, by the user

- The launch image is the app's mark, a third of the screen's width, centred on `#ffffff` or `#110c20`: what the page
  paints first, so opening reads as one surface.
- «Agrégala a tu inicio» is a card at the top of the screen, above its content: a Share icon, the title, one gray line of steps and an
  «×». Dismissed once, it never returns on that device.

## Decisions of 2026-10-30: a bank statement through Claude, by the user («dejala ya funcional»)

- «Ajustes · Webhooks» has a «Conectar con Claude» card: the `/mcp` address and «Crear clave para Claude». The key opens
  `/mcp` alone and shows once, under the same warning as a webhook token. A webhook key never opens `/mcp`.
- Claude imports in two calls: `preview_statement` writes nothing and names each line «new», «matches», «already_imported»
  or «invalid»; `import_statement` quotes the preview's key and writes all or nothing. The person confirms in the
  conversation between the two.
- «Bandeja» lists «Por completar (n)» under the deliveries: one card per movement with one side known. The card reads
  the description, «Salió de / Entró a <cuenta> · <fecha>» and the amount; one account select («¿A qué cuenta fue?» or
  «¿De qué cuenta vino?») and «Completar». A remembered account prefills the select with «Sugerida: la usaste antes con
  esta descripción.»; it never completes on its own.
- The Bandeja's card and row work without opening the form (the user, 2026-11-17):
  - **The date is the movement's**, as the message prints it («Fecha: 14 nov 2026»), never the hour it arrived; a delivery that
    prints none shows the day it arrived. The laptop table's first column reads the same day.
  - **The category is chosen on the card**: below the account, a one-line select labelled «Categoría» lists the categories of the
    account's scope and kind (a child as «Padre › Hijo»); with none, an amber line «Falta la categoría» sits above it and the select reads «Elegir la categoría». Choosing one makes the
    card ready, so «Anotar» saves it in one tap with that category (the same way «Para quién» rides on «Anotar», RF-242). A
    transfer shows no category.
  - **«Descartar» is on the card**, a soft red button beside «Anotar» (or «Completar y anotar»), not inside the ⋮ menu, which keeps
    only «Olvidar el comercio» and is absent when there is nothing to forget. It still asks first and still offers «Descartar y no
    volver a preguntar».
  - **Several at once**: each ready card and each ready row carries a checkbox named «Elegir <comercio>». Above the list a quiet
    bar reads «Elegir las listas (n)» with nothing chosen; with some, «n elegidas», «Anotar n» (primary) and «Quitar la selección». A
    delivery that is not ready has no checkbox. «Anotar n» records them all in one write: if any is refused, none is recorded and
    the toast says so; when it succeeds the toast reads «n movimientos anotados» and the cards leave the list.
  - **«Ya registrado»** (RF-246): the card leads with a red «Descartar como repetido», one tap with no confirmation, and keeps
    «Anotar igual» as a gray text button; the row's menu leads with the same item.
- A transfer between two currencies is imported at the rate the person confirms (the user, 2026-10-30: «deben ser por
  trm, se confirma con el usuario cuánto le llegó»). The preview marks it `needs_counter_amount` and names the other
  account's currency; Claude asks how much arrived or left there and confirms the resulting TRM. It is booked in the
  statement's currency with that amount as `counter_amount_cents`, and the other account's statement links to it.
- Choosing a category when noting an expense is a grid of the person's most frequent categories (`CategoryTile`, one tap
  selects, «Más» shows all); splitting across several categories sits behind «Dividir» and opens the split editor. No
  validation message shows before a submit attempt. Frequency is the count of the person's movements per category, read
  in the form options' one fan-out (the user, 2026-10-30).
- **Decided by the user 2026-11-10** («Cuando te mande una factura que sea grupal por mcp quiero que haya separación de cada
  producto en solo un movimiento, o sea movimiento y sub movimientos»; «sub clasificación de cada sub movimiento»): a receipt is
  one movement and its lines are sub-movements. The split editor gives each line an optional «Detalle» (the product) under its
  category and amount; a line's category may be a subcategory, read «Mercado › Lácteos». The movement's detail lists the lines
  under it, each with its name, its category path and its amount. The movements list keeps one row and adds «N líneas» beside the
  account. A discount is subtracted from the lines it applies to.
- A fund category's name is bare, except where two can share it: a selector that lists both scopes puts them under
  «Categorías del fondo» and «Mis categorías», and Reportes and Inicio's month glance write «· fondo» after the fund's
  (the user, 2026-11-08, over 2026-10-30). A personal account (and a personal category where a component, not a string,
  draws it) wears a small `User` glyph with an aria-label. Another member's personal row wears the owner's name beside
  the glyph («De Andrea») and offers no action (the user, 2026-11-08).
- The phone's bottom bar reads Inicio · Movimientos · [+] · Bandeja · Ajustes (the user, 2026-11-11, over 2026-11-08): the
  Bandeja is used daily, so it holds a tab again, carrying the count of pending deliveries plus «Por completar» (hidden at
  zero), and the Ajustes tab carries none. Planeación is reached from Inicio's «Planeación» button and from the first row of
  the Ajustes list (screen and sheet), where Bandeja no longer appears. The desktop sidebar is unchanged.


## Decisión del 2026-10-31: ronda 3 de la crítica

Elegidas por el crítico; el usuario puede cambiarlas («Elige lo que recomiendes»).

- De 768 a 1279 px la barra lateral es un riel de 88 px: el ícono con su etiqueta debajo, sin depender del hover. Desde 1280 px
  vuelve la de 248 px.
- Inicio de escritorio va a dos columnas: a la izquierda la marca, el mes y los movimientos; a la derecha, fijos, «Por pagar»,
  los tres presupuestos más cerca del límite, la meta y el próximo pago de deuda. Sus lecturas viajan en el mismo
  `Promise.all` (RNF-09).
- El ancho máximo es 1440 px, con tres columnas desde 1600 px donde la pantalla las tiene.
- Gráficas: el gasto en violeta, el ingreso en jade y el rojo solo para lo «Superado».
- Cada pantalla tiene un solo margen izquierdo de 32 px, sea de la página o de sus bandas (`--band-gutter`).
- Planeación es un mosaico (presupuestos grande, meta con anillo, deudas en tinta con la cifra en lima, pagos ancho) y las
  pestañas de escritorio que repetían la barra lateral se quitan.
- Una cifra titular bajo el título: Presupuestos «Quedan $ X de $ Y», Movimientos el neto del mes, Metas lo apartado.
- «Aportes del mes»: el usuario eligió el campo «De quién» en el ingreso al fondo (ver RF de aportes).
- Ocultar montos (RF-174), decidido por el usuario 2026-11-10: «crea un botón para ocultar el dinero». Un ojo (`Eye` /
  `EyeOff`, «Ocultar montos» / «Mostrar montos») arriba a la derecha de la tarjeta «Patrimonio neto» de Inicio y en el
  encabezado de la app (la barra lateral en laptop, la barra superior en el teléfono): un solo estado por dispositivo.
  Oculto, cada cifra queda como «$ ••••••», con la marca de la moneda y la misma altura de línea; los porcentajes siguen
  visibles y lo que la persona escribe en un campo de monto no se oculta.

## Decisión del 2026-11-10: bolsillos en Cuentas, por el usuario

Un bolsillo es una cuenta dentro de otra, como los de Bancolombia: «Bolsillo Dinero» vive dentro de «Ahorros Bancolombia 3397». En la lista de Cuentas la cuenta madre muestra el total de ella y sus bolsillos; debajo, sangrada, la línea «Libre» con lo que queda en la madre misma, y luego cada bolsillo con su propio saldo, también sangrado. En el celular el bolsillo es una tarjeta sangrada bajo la de su madre y la madre muestra el total con «Libre» debajo. El formulario de la cuenta, al crear y al editar, trae un campo opcional «Dentro de» con las cuentas de ahorro de la misma persona o fondo y la misma moneda, y «Ninguna». Pasar dinero a un bolsillo es una transferencia normal entre las dos cuentas.

## Decisión del 2026-11-17: Cuentas sin lo que se repite ni lo que está vacío, por el usuario

«Esto es un mierdón de cantidad de cosas.» Cada fila de Cuentas decía «Personal» con un ícono de persona aunque todas lo fueran,
repetía el titular en el nombre y en una línea, dejaba una columna «Últimos cuatro» con «—» en casi todas y ponía una fila «Libre»
bajo cada cuenta con bolsillos. Una cosa se dice una vez y en el lugar donde informa; lo vacío no se dibuja.

- **El ámbito se dice en la banda, no en la fila.** Sale el ícono de persona y sale la línea «Personal» / «El fondo» de cada fila.
  Si la lista mezcla cuentas personales y del fondo, la banda de cada tipo ya dice «Cuentas · Personal» y «Cuentas · <fondo>». Si
  todas son del fondo, la banda lo nombra («Cuentas · <fondo>»). Si todas son personales, no se escribe «Personal» en ninguna parte.
  Solo la cuenta personal de otro miembro lleva su dueño («De Andrea»), porque ahí sí distingue.
- **El titular tiene un solo lugar: el campo «Titular» de la cuenta del fondo (RF-181).** El nombre de la cuenta dice el banco o el
  producto («BBVA»), no a quién pertenece. Un nombre que ya trae al titular («Mamá — BBVA») no se reescribe, y su fila no repite
  «Titular: Mamá»: la línea del titular solo sale cuando el nombre no lo dice.
- **Una línea de detalle bajo el nombre**, en gris, con lo que tenga y nada más, separado por « · »: la entidad, «terminada en 3397», el
  titular, el dueño ajeno. Una cuenta sin nada de eso es una sola línea. Salen las columnas «Entidad» y «Últimos cuatro»: la tabla
  queda en Nombre, Saldo y el menú, y el filtro «Entidad» sigue donde está. En el celular la tarjeta usa la misma línea en vez de
  tres.
- **Sin fila «Libre».** La cuenta con bolsillos muestra el total de ella y sus bolsillos, y los bolsillos debajo, sangrados. Lo que
  queda en la madre se escribe como una nota gris bajo el total («Libre $ 249.816») solo cuando es distinto del total, es decir,
  cuando algún bolsillo tiene dinero; si no, no se escribe. La tarjeta del celular sigue la misma regla.
- **Los filtros que no filtran no se dibujan.** «Propietario» solo aparece cuando hay cuentas personales y del fondo; «Entidad», solo
  cuando hay dos entidades o más.
- Estados: lista vacía, lista filtrada vacía, archivadas (solo «Restaurar» y «Eliminar») y quien lee la cuenta de otro (sin menú) siguen
  como estaban.

## Decisión del 2026-11-10: Cuentas por tipo, por el usuario

«Me molesta que las tarjetas sean cuentas, entiendo que todos van en el mismo pero puede ser que lo separemos por tipos.» La lista de Cuentas se parte en secciones, cada una con su título y su subtotal por moneda: «Cuentas» (bancarias y efectivo, con sus bolsillos como hasta ahora), «Tarjetas de crédito» y «Préstamos» (subtipo `loan`, RF-178, decidido el mismo día). Una sección sin cuentas no aparece, y dentro de cada una las cuentas personales y las del fondo siguen separadas. Un préstamo cuenta como deuda donde cuenta cualquier pasivo (deudas, extractos); desde Deudas solo se crea una tarjeta. Salen la insignia «Lo que tengo / Lo que debo» de cada fila, la columna Tipo y el filtro Tipo, porque la sección ya lo dice. Encima de la lista (no en Archivadas), tres cifras: lo que tengo, lo que debo (con signo: una tarjeta a favor sale en negativo) y el neto, por moneda y sin sumar monedas distintas; un tipo vacío muestra 0; respetan el botón de ocultar montos. En el celular son las mismas secciones, con tarjetas.

## Decisión del 2026-11-11: «Suscripciones» en Planeación, por el usuario

Los cobros que se repiten (RF-185), encontrados con reglas fijas, sin guardar nada. Bajo el título, la cifra titular: lo que
cuestan al mes, una por moneda. Dos grupos con su rótulo: «N activas», con el próximo cobro primero, y «N sin cobro reciente».
Cada cobro es una tarjeta: a la izquierda el disco de la fecha (el próximo cobro, o el último si ya no se cobra), el nombre
como llegó en el último movimiento, «Cada mes · Cuenta · Categoría» y el monto típico; debajo, «Próximo cobro estimado: 12 de
diciembre · 4 cobros vistos». Una columna en el celular, dos desde `md` y tres desde `xl`, sin tabla. Abajo, una nota gris dice
cómo se encuentran y que son estimados, e invita a revisarlas con Claude. Sin cobros, un estado vacío dice cuándo aparecerán.
En el mosaico de Planeación, una ficha pequeña: «N activas · $ X al mes».


## Decisión del 2026-11-11: «Lo paga <persona>» en el crédito, por el usuario

Un crédito a nombre de la persona que otro paga: ese otro le manda el dinero y ella paga la cuota al banco. Se sigue en
la pantalla del crédito (Planeación → Deudas → el crédito), sin pantalla aparte y sin tablero previo; se refina con lo
construido.

- **Sin vínculo.** El encabezado del crédito ofrece, junto a «Abonar», el botón «Lo paga otra persona» (solo quien puede
  escribir la cuenta). Abre un diálogo: «Persona», «Cuenta "Me debe"» (por defecto «Crear una nueva»; o una cuenta de
  ahorro o efectivo que ya tenga), y, si es nueva, «Lo que debe hoy» (lo que falta del crédito, editable) y «Desde» (hoy);
  luego, opcionales, «Cuota del banco» y «Día de pago». El botón dice «Guardar». La cuenta nueva se llama «Me debe <persona>».
- **Con vínculo**, bajo las cifras del crédito, un bloque con el título «Lo paga <persona>» y, a su derecha, «Registrar pago
  de <persona>» y un menú «Editar» · «Dejar de seguir» (confirma, y dice que las cuentas y los movimientos se quedan).
  - Tres fichas: «Falta del crédito» (con la nota «Cuota $150.000 · vence el día 15» si la hay), «<Persona> ya pagó» y
    «<Persona> todavía debe» (con el nombre de la cuenta «Me debe» como nota). Cada una, por moneda del crédito.
  - «Este mes · noviembre de 2026», una tarjeta con dos filas, cada una con su estado en palabras y nunca solo en color:
    «<Persona> te pagó» → «Llegó $150.000 · 5 nov» (jade), «Llegó una parte: $50.000 de $150.000» o «Aún no llega» (gris);
    «Pagaste al banco» → «Pagado $150.000 · 6 nov», «Pagaste una parte: …» o «Aún no pagas». Sin cuota declarada, cualquier
    pago cuenta como hecho.
  - «Mes a mes», una tarjeta con una fila por mes, el más reciente primero, hasta 24: el mes y, debajo, las dos cifras
    («Llegó $150.000» · «Pagaste $150.000»); un mes sin movimientos dice «No llegó nada» y «No pagaste». Un mes sin nada
    sigue siendo una fila: es la cifra que se vino a leer.
- **Registrar pago de <persona>** abre un diálogo con «Llegó a» (las cuentas de la persona, sin la «Me debe»), «Monto»
  (la cuota, si hay) y «Fecha» (hoy); guarda una transferencia de «Me debe <persona>» a esa cuenta, nunca un ingreso. El
  pago al banco es el «Abonar» de siempre.
- En el celular, una columna: las fichas se apilan y los botones pasan bajo el título.
- Estados: sin cuota ni día, las notas desaparecen; guardando, los controles se bloquean con un indicador; un rechazo sale
  junto al campo o en el aviso con sus palabras; quien no escribe la cuenta lee el bloque sin ningún botón.

## Decisión del 2026-11-11 (segunda): el crédito lleva «Lo paga <persona>» y no se ve ninguna cuenta de más, por el usuario

«Pensé que ponías un boolean en el crédito y ya con eso se le destinaba a un nombre, no literalmente que me crea una
account de mentira.» Lo que debe la persona sigue guardándose como una cuenta de activo (los saldos se derivan de
movimientos y su pago es una transferencia, nunca un ingreso), pero nadie la ve: es interna.

- **Ninguna lista la ofrece.** No sale en Cuentas ni en sus conteos, ni en los selectores de cuenta (formulario de
  movimiento, Bandeja, traspasos, retiro de efectivo, abono a una deuda), ni en los widgets, ni en `list_accounts` del
  MCP. Los totales no cambian: el neto es lo que tengo, menos el crédito, más lo que la persona todavía debe.
- **La fila del crédito en Cuentas** se lee «Crédito Trabajo Lulo (John)» y, como línea secundaria bajo el dueño, «Lo
  paga John · le falta $2.680.980» (lo que la persona todavía debe); si ya no debe nada, «Lo paga John · no debe nada».
  En el celular, la misma línea en la tarjeta. Ninguna otra fila aparece. Las tres cifras de arriba cuentan lo que la
  persona debe dentro de «Lo que tengo» y del neto.
- **El diálogo «Lo paga otra persona»** pide solo «Persona» y, opcionales, «Cuota del banco» y «Día de pago»; sin elegir
  cuenta, sin «Lo que debe hoy» ni «Desde». La cuenta interna nace sola con lo que falta del crédito hoy. El botón dice
  «Guardar».
- En la pantalla del crédito, la ficha «<Persona> todavía debe» ya no lleva el nombre de la cuenta como nota.
- **«Dejar de seguir»** quita el vínculo y archiva la cuenta interna, que pasa a Archivadas con sus movimientos; la
  confirmación lo dice.

## Decisión del 2026-11-17: el plan de pagos en el crédito, por el usuario

El banco imprime un «plan de pagos» con cada cuota; el crédito lo guarda y lo lee contra lo que ya se pagó. Se construye
con estas palabras, sin tablero previo, y se refina con lo construido.

- **Sin plan** el crédito no cambia: ningún bloque, ninguna ficha, ningún aviso.
- **Con plan**, bajo las fichas del saldo (y bajo «Lo paga <persona>» si la hay), el bloque «Plan de pagos»: cuatro fichas,
  «Próxima cuota» (el valor, con «Cuota 4 de 12 · 5 mar 2027»; «Todas pagadas» al final), «Cuotas por pagar» («de 12»),
  «Falta pagar» («Con intereses y seguro») y «Termina» (el mes y el año, con el día debajo). Encima de ellas, un aviso
  ámbar si alguna cuota sin pagar se aleja más de 5 % de la usual: «En noviembre 2027 la cuota es $619.285; la usual es
  $194.679.», y «Otras 2 cuotas más se alejan más de 5 % de la usual.» si hay más.
- **«Cuotas»**, una tarjeta con una fila por cuota: «Cuota 3 · 5 feb 2027» y, debajo, «Capital · Interés · Seguro»; a la
  derecha el total, una insignia con el estado en palabras (verde «Pagada», ámbar «Parcial · $X», roja «Vencida», gris «Por
  pagar») y «Saldo $X», el capital que queda. Un estado nunca es solo color.
- **«Lo paga <persona>»**: la ficha «Falta del crédito» cambia su nota por «A John le faltan 14 cuotas: $4.200.000 con
  intereses» («le falta 1 cuota» en singular); y un aviso ámbar bajo las fichas, «En agosto 2027 la cuota es $356.789; John
  suele mandar $327.000.», más «Otras 2 cuotas más tampoco la cubren.» si hay más. Sin cuotas por pagar la nota vuelve a la
  cuota y el día de pago del banco.
- En el celular, una columna: las fichas se apilan y cada fila de cuota baja el total y la insignia bajo sus cifras.

## Decisión del 2026-11-17 (segunda): «le falta» dice de dónde sale, por el usuario

«¿Cómo sé que John me debe este dinero? No veo de dónde pones eso.» Sin tablero previo; se refina con lo construido.

- **Dónde.** En Cuentas, la cifra de «Lo paga John · le falta $ 2.680.980» es un botón (tinta de texto, sin caja). En el
  crédito, la ficha «John todavía debe» lleva la nota «Ver cómo se calcula», también un botón.
- **El diálogo «Cuánto le falta a John»**: «Deuda cuando se unió (10 nov 2026)» y su cifra; «Pagos de John» y, debajo, una
  línea por pago con el día y el monto en negativo, el más viejo primero (sin pagos: «John todavía no ha pagado nada.»);
  «Otros movimientos de la cuenta» solo si el saldo guarda algo más; y, tras una línea, «Le falta» en negrita con la cifra.
  Con plan de pagos, una última línea gris: «Con intereses y seguro, le faltan 14 cuotas: $4.200.000». Un botón «Cerrar».
- **El crédito mismo relaciona a quien lo paga.** «¿Por qué el crédito mismo no relaciona a John?» Bajo las fichas del saldo,
  «Lo paga John» abre con tres líneas: «Este crédito lo paga John. Él te manda la cuota y tú le pagas a Lulo.» (el prestamista
  es la institución del crédito; sin ella, «al banco»), «Le falta $30.000 (capital) · con intereses $33.300 · 3 cuotas» y, en
  gris, «Deuda cuando lo uniste: $3.007.980 el 10 nov». A la derecha del título, tres botones a la vista: «Registrar pago de
  John», «Cambiar persona» y «Desunir» (rojo, confirma); ya no hay menú. Un aviso ámbar mientras el mes no ha recibido nada:
  «John aún no manda la cuota de diciembre (vence el 15).».
- **«Mes a mes»** es una tabla: «Mes», «John te mandó» y «Pagaste a Lulo» (monto y, debajo, el día), «Diferencia» (lo que
  John mandó menos lo que pagaste al banco: el 4x1000 y el colchón); un mes sin movimientos lleva rayas. En el celular cada
  mes es un bloque con sus cuatro líneas.
- **Deudas.** La fila de un crédito que paga otra persona dice «Lo paga John» en gris bajo el nombre, en la tabla y en las
  tarjetas.
- **Estados.** Desde Cuentas el diálogo lee al abrirse: «Leyendo los pagos…» con un indicador, «No pudimos leer el detalle.»
  con «Reintentar» si falla; desde el crédito ya tiene los datos y no espera.

## Decisión del 2026-11-17: «Para quién», por el usuario

«Cuando gasta a nombre de otra persona… Ángela es mi pareja y no le cobraría dinero a menos que te diga.» Un gasto hecho por
otra persona sigue siendo gasto de quien lo paga: «Para» dice de quién fue, y no crea deuda ni cuenta por cobrar. Sin
tablero previo; se refina con lo construido.

- **Las personas viven en «Etiquetas»** (RF-242), con su propio botón «Añadir persona» junto a «Añadir etiqueta», en el celular y
  en el escritorio. Una persona es una fila más, con su color, y lleva una insignia: «No se le cobra» (gris) o «Se le cobra»
  (ámbar); nunca solo color. El diálogo de una persona tiene el nombre, el interruptor «Se le cobra» con su línea de ayuda («Apagado,
  lo que gastas para esta persona es solo gasto tuyo y no te debe nada. Encendido, se te recuerda cobrárselo; una deuda nunca se
  crea sola»), el color y dónde va. Apagado desde el primer día.
- **El campo «Para quién»** (no «Para»: ese nombre ya lo lleva el destino de un traspaso) del formulario de movimiento, de la anotación rápida y de la tarjeta de la Bandeja es opcional, un selector
  de una sola persona con «Nadie» como primera opción, bajo las etiquetas; sale en cualquier movimiento, un traspaso incluido, y solo
  con las personas del mismo ámbito que la cuenta. En la tarjeta de la Bandeja el selector va sobre el botón «Aceptar», para que
  el toque único también guarde para quién fue.
  Si la persona elegida «se le cobra», una línea bajo el selector dice «Se le cobra: este gasto sigue siendo tuyo hasta que
  registres lo que te debe.» Sin personas, el campo no sale.
- **En la lista** el movimiento lleva una etiqueta discreta «para Ángela» en gris, junto a su categoría, y nunca dentro de la
  descripción; el detalle la repite bajo las etiquetas.
- **Filtros.** Movimientos suma el filtro «Para quién» (una persona o «Nadie»), y el total de arriba cuenta lo que el filtro deja:
  «Ángela · este mes». Informes suma, bajo el gasto por categoría, la tarjeta «Para quién»: una fila por persona con lo que se gastó
  para ella ese mes, por moneda, y un toque abre Movimientos ya filtrado. Sin gasto para nadie, la tarjeta no aparece.
- Estados: guardando, los controles se bloquean; una persona borrada deja sus movimientos sin «para» (el borrado de una etiqueta
  ya dice cuántos movimientos suelta).

## Decisión del 2026-11-17: «Cuadrar todo», por el usuario

Cuadrar once cuentas una por una, desde capturas, tomó docenas de pasos y dos errores: se usó la deuda a la fecha de corte de
una tarjeta en vez de la de hoy, y se escribió una deuda con el signo contrario. Una sola pantalla, sin diálogos, para contar
todas las cuentas a la vez.

- **Dónde.** `/settings/accounts/reconcile`, con la flecha de volver a Cuentas. Cuentas la ofrece con «Cuadrar todo» junto a «Añadir»,
  y la línea de Inicio (abajo) también lleva a ella. Título «Cuadrar todo»; bajo él: «Escribe lo que dice el banco hoy. Lo que dejes
  vacío no se toca.»
- **Qué lista.** Toda cuenta abierta que la persona puede escribir, con sus bolsillos, y ninguna de otro miembro, archivada ni
  «Me debe» de un crédito ajeno. Primero lo que se tiene, luego tarjetas y préstamos; dentro, por nombre. Una tarjeta del celular
  y una del escritorio son la misma, una sobre otra, en el ancho de la página.
- **La fila** es una `Card`: el nombre y debajo, en gris, la entidad y «terminada en 3397»; a la derecha «Según HomeFund» con la cifra
  de hoy. Una línea gris dice cuándo se cuadró: «Cuadrada hace 12 días», «Cuadrada hoy» o «Nunca cuadrada». Debajo, el campo.
- **El campo** lleva su etiqueta visible: «Lo que dice el banco hoy» en una cuenta; en una tarjeta o un préstamo, «Lo que debes hoy
  (cupo total − disponible)» y, como ayuda, «No uses la deuda a la fecha de corte». Una deuda se escribe en positivo, lo que se debe;
  un menos solo si se pagó de más.
- **Ayuda del cupo.** Solo en tarjetas y préstamos, un enlace «Calcular con el cupo» abre dos campos, «Cupo total» y «Cupo disponible»;
  lo que se escribe en ellos llena «Lo que debes hoy» con la resta y se puede corregir a mano. Plegado por defecto.
- **La diferencia sale en vivo**, en cuanto hay una cifra válida: «Diferencia +$ 150.000», en el tono del saldo (a favor en verde, en
  contra en gris fuerte, nunca solo color: lleva el signo); en cero, «Cuadra. No se registra ningún movimiento». Una cifra con el signo
  contrario al saldo dice «Tiene el signo contrario al saldo. Revísala» junto a la diferencia, sin bloquear. Una cifra que no se lee
  dice por qué, bajo el campo.
- **Un solo botón al final**, «Cuadrar 4 cuentas» (singular con una), que escribe todo o nada. Sin cifras escritas está desactivado y
  encima dice «Escribe lo que dice el banco de al menos una cuenta». Mientras escribe, «Cuadrando…». Al terminar vuelve a Cuentas con
  «4 cuentas cuadradas». Si el saldo de una cambió mientras tanto, no se escribe ninguna: bajo esa fila dice «Los movimientos de esta
  cuenta cambiaron. Revisa la diferencia y vuelve a cuadrar.», las cifras se leen de nuevo y lo escrito se conserva.
- **Vacío:** sin cuentas que cuadrar, «No hay cuentas para cuadrar» y un enlace a Cuentas.
- **El aviso «Cuádrala».** Una cuenta que no se cuadra hace más de 30 días lleva, en Cuentas, una marca gris «Cuádrala» (un botón de
  texto bajo el nombre que abre el cuadre de esa cuenta); una cuenta que nunca se cuadró cuenta los 30 días desde que se añadió. En
  Inicio, a lo sumo una línea en la columna de al lado, «3 cuentas sin cuadrar hace más de un mes · Cuadrar todo»; sin cuentas así, nada.
- **Inicio no muestra los «Descuadre»** (2026-11-17). Las últimas del listado de Inicio son lo que pasó; la diferencia de un cuadre sigue en
  Movimientos y en el historial de la cuenta.

## Decisión del 2026-11-17: Inicio en líneas cortas, por el usuario

Las palabras primero. Quien abre Inicio contesta en voz alta, sin saber cómo está hecha la app: ¿cuánto tengo?, ¿qué pago este mes?,
¿en qué se me fue?, ¿hay algo por arreglar?, ¿qué viene? Cada línea es una frase corta con su cifra y cada cifra dice de dónde sale.

- **Tienes.** La cifra grande de la tarjeta oscura dice «Tienes en tus cuentas» y es lo que hay en las cuentas que la persona ve (un
  bolsillo cuenta una vez con su cuenta; lo que otros le deben no entra). El patrimonio va debajo, pequeño, como un botón «Patrimonio
  $4.894.500 · ver la resta» que abre «Cómo sale tu patrimonio»: lo que tienes en tus cuentas, lo que te deben (solo si algo), lo que
  debes en tarjetas y créditos, y el patrimonio. Dos monedas, dos cifras: nunca se suman.
- **Este mes pagas $X.** Una tarjeta con título y debajo una línea por cada pago, la más próxima primero, cada una un enlace: «Visa
  $3.148.800 el 20 nov (mínimo $310.000)». La tarjeta que no tiene extracto de este mes dice «Mastercard el 25 nov: falta su extracto» y
  una nota gris «Sin contar lo que pidan los extractos que faltan». En el celular y en el escritorio por igual. Sin pagos: «Este mes no
  tienes pagos por hacer.»
- **Te deben.** Un lugar entre «Este mes pagas» y «En <mes> gastaste», que dibuja otro carril; mientras no lo dibuja, no hay nada.
- **En noviembre gastaste $X.** Con las tres categorías más grandes en una línea gris, «Arriendo $1.400.000 · Mercado $478.000», y el
  enlace «Ver reportes». Reemplaza la barra «El mes de un vistazo».
- **Por arreglar.** Una tarjeta solo con lo que existe, cada línea un enlace a su arreglo: «Emergencias gastó $150.000 más de lo que
  tenía» (a Cuentas, donde está «Pasar $150.000 desde Ahorros»), «Nequi está por debajo de cero: −$16.000», «2 avisos por revisar en la
  Bandeja», «Lulo: 2 cuotas quedaron cortas por $7.612» y «3 cuentas sin cuadrar hace más de un mes · Cuadrar todo». Sin nada raro no se
  dibuja. «Revisar el mes» abre el mes en curso con esta misma lista arriba.
- **Viene.** El próximo ingreso esperado y el próximo gasto, «Ingreso de $800.000 (Cliente) el 28 nov», «Arriendo $1.400.000 el 5 dic».
  Sin ninguno de los dos no se dibuja.
- **Ajuste por cuadre.** Así se llama, en toda la app, lo que antes se llamaba «Diferencia» al cuadrar. La cifra del mes en Inicio es un
  botón que abre cada cuenta con lo que su cuadre movió: «Nequi +$28.000», «Efectivo −$17.000». No sale en los últimos movimientos.
- **Cuentas.** «Lo que tengo» es la suma de las filas que se ven. «Libre» nunca es mayor que el total y no se dibuja mientras un
  bolsillo esté en negativo. Un bolsillo en negativo dice, en rojo, «Gastó $150.000 más de lo que tenía» y un botón «Pasar $150.000 desde
  Ahorros» que lo mueve de un toque. En el celular, «Saldo inicial … el 1/10/2026» dice su fecha en la primera tarjeta de cada fecha.
- **Chicos.** Sin fondo no hay «Aportes del mes». «Crear cuenta» de un Inicio vacío abre el formulario. «Crear un fondo» lleva debajo
  «Un fondo es una cuenta compartida: invitas a otras personas y llevan juntos los gastos del hogar.»
