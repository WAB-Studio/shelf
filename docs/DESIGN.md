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
  accounts, a fund category's the fund's; the scope refusal reads on its field inside the dialog, at 360 too. Level 2. Not
  built yet.
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
- **An invitation is accepted** (Q2 a): RF-154 opened. Boards «X te invitó · Aceptar / Rechazar» and «Salir del fondo»
  are drawn before any worker. Not built yet.
- **Planned payments promise no notice** (Q4 a): «Son recordatorios: aparecen aquí en su fecha, y tú registras el gasto
  cuando lo pagas.» «te avisan» comes back with RF-141.
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
  by fixed rules; Claude does any AI review through MCP. Its own train with its board, after wave 2. Not built yet.
