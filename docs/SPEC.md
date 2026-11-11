# Shared fund app — specification

> **For the implementing agent:** section 1 is the contract and section 4 fixes
> the stack. If something is not in section 1, it does not get built. This
> document makes no implementation decisions: how each requirement is satisfied
> is decided at implementation time, as long as the non-functional requirements
> hold.

---

## 1. Specification

### Context

Two people keep separate incomes but share household expenses. Today there is no
visibility into where the money goes. The app must provide it with minimal daily
recording effort.

The central unit is the **fund**: a shared pot of money with its own accounts,
members and history. Personal accounts hang off the fund, not the other way
around. The immediate use case is a household, but nothing in the model depends
on that.

Default language: Spanish. Settlement currency of a new account: COP. Time zone: `America/Bogota`.

### Scope and phases

**Phase 1 (MVP):** RF-01 through RF-48, and RF-54.

**Phase 2:** RF-49 through RF-53. Import, export and audit viewer. No model
changes required: `external_ref` exists from phase 1 so that importing is
idempotent from day one.

**Out of scope:** bank synchronisation, receipt OCR,
accounting exports, native apps. None of this gets built or left
"prepared for".

### Functional requirements

#### Authentication and fund

- [x] **RF-01** — Passwordless email login.
- [x] **RF-143** — Signing in by email refuses an address whose domain cannot receive mail, before any email is sent, and caps the sign-in links sent per address, as `apps/wordbook` does. Decided by the user 2026-10-15.
- [x] **RF-145** — Access is by invitation only. Public sign-ups are off in Supabase Auth and the app keeps a list of allowed emails; the server refuses a sign-in link for an email not on the list before any email is sent. PKCE applies: a link only works in the browser that asked for it. Decided by the user 2026-10-15.
- [x] **RF-146** — Signing in by email also sends a six-digit code: the person types it on the screen where they asked for it, in the browser or the installed app, and lands where the link would have landed them. A wrong or expired code says so; nothing verifies a code twice on the person's behalf. The invitation list, the deliverability guard and the daily caps (RF-145, RF-143) stand before the code is sent. Decided by the user 2026-10-16.
- [x] **RF-147** — On the code step, «Pedir otro código» sends a new code to the same address without typing it again, once a countdown of Auth's wait between sends has run out; the new code replaces the last. A send Auth refuses does not count against the daily caps (RF-143). Decided by the user 2026-10-17.
- [x] **RF-148** — Inviting a member by email sends the invitee a mail of its own that names HomeFund and tells them to sign in at `/login` with that address; it carries no code and no link that signs in. The address is on the invitation list (RF-145) from the moment the member is created. Decided by the user 2026-10-17.
- [x] **RF-149** — The leader adds a member from «Miembros» with an optional email; with one, the member is invited as RF-148 says. Inviting, from «Miembros» or from onboarding, an address that already has a pending invitation in the group is refused with «Ese correo ya tiene una invitación en este grupo.» and sends nothing. Decided by the user 2026-10-17.
- [x] **RF-150** — Inviting, from «Miembros» or from onboarding, an address that is a live member of the group, the leader's own included, is refused with «Esa persona ya está en este grupo.» and sends nothing. Another group is never looked at. When the invitation mail cannot be sent, the notice no longer says the person can enter this group. Decided by the user 2026-10-17.
- [x] **RF-151** — An archived invitation is not a pending one: inviting its address again adds a new pending member, and the archived row stays as history. Restoring an archived invitation whose address has a newer pending one is refused with «Ese correo ya tiene una invitación en este grupo.». Decided by the user 2026-10-17.
- [x] **RF-152** — Inviting an address whose domain takes no mail is refused with the words `/login` uses (RF-146's deliverability guard), from «Miembros» and from onboarding; nothing is written or sent. Decided by the user 2026-10-17.
- [x] **RF-153** — The leader gives an email to a member who has no login and no pending invitation, from «Editar miembro» («Correo (opcional)»); saving it invites them as RF-148 says, and refuses as RF-149, RF-150 and RF-152 do. The person who then signs in with that address becomes that member, under the name the group already gave them. Decided by the user 2026-10-18.
- [x] **RF-154** — Adding an address to a fund never puts its person in that fund on their own: the next time they sign in they see «X te invitó a su fondo · Aceptar / Rechazar», and only «Aceptar» joins them; until then the fund reads nothing of theirs. A member leaves a fund from «Salir del fondo»; what they wrote in it stays with the fund. Decided by the user 2026-10-18 (map Q2), from the 2026-10-15 decision.
- [x] **RF-155** — When a month closes, HomeFund shows «Revisar el mes»: the movements that stand out (an amount far above what is usual in its category; two equal movements on the same day in the same account; an amount quick entry read from words such as «m» or «mil»; a gap after a reconciliation). The person marks each «Está bien» or corrects it. The same list is a tool of the MCP server (RF-144), so Claude can review it in a conversation. The app calls no paid model: the rules are fixed. Decided by the user 2026-10-18.
- [x] **RF-156** — Saving an edit from a form that carries money (a movement, an account, a recurring rule, a planned payment, an instalment plan, a budget, a savings goal, a debt's terms), opened before its row changed (another form, another device, or the 00:15 run), is refused with «Esto cambió mientras lo editabas. Vuelve a abrirlo.» and nothing is saved. Decided by the user 2026-10-18 (map Q1, Q24); the forms that carry no money stay out, decided by the user 2026-10-30.
- [x] **RF-157** — A recurring rule the nightly run pauses says why on its row: «Pausada: no se pudo generar el movimiento. Revisa la regla y reanúdala.» A rule's next run can be set no earlier than 12 months before today. Decided by the user 2026-10-18 (Q16, Q17, Q24).
- [x] **RF-158** — A movement sent again after its answer was lost, with a different amount, is refused with «Ya guardamos este movimiento con otro monto; ábrelo para corregirlo.» and nothing is saved; sent again unchanged, it answers the movement already saved. Decided by the user 2026-10-18 (Q25 b).
- [x] **RF-159** — From a planned payment's reminder date (RF-74) until it is paid or archived, it shows on Inicio with its name and due date («Matrícula colegio vence el 15 dic»). Decided by the user 2026-10-18 (Q28 a).
- [x] **RF-57** — Only the group `leader` invites members, edits the group and manages the group's categories.
- [x] **RF-58** — Every member of a group can read all of its accounts (universal read); write is bounded per account — a personal account by its owner, a shared account by any member.
- [x] **RF-59** — Whoever creates a group becomes its `leader`. The role is transferable, but a group is never left without a leader.
- [x] **RF-06** — Accepting an invitation links the user to the member that already exists in the fund, if any; otherwise a member is created.
- [x] **RF-55** — By default a user's accounts are personal; a user may belong to at most one optional shared group. There is no multi-fund membership and no switching.

#### Members and accounts

- [x] **RF-07** — CRUD for members. A member need not have a user.
- [x] **RF-60** — CRUD for accounts. An account is either personal (owned by a user) or a group account.
- [x] **RF-09** — An account is either an asset (savings, cash) or a liability (card, loan).
- [x] **RF-10** — Creating an account captures its opening balance and the date that balance is true as of.
- [x] **RF-11** — Accounts and members that have movements are archived, not deleted.
- [x] **RF-61** — Archiving a member does not archive their accounts. The owner decides per account: archive it or hand it to the group.
- [x] **RF-100** — Only the group `leader` adds, renames, archives, restores and removes a member; every member renames their own row and no other.
- [x] **RF-114** — The accounts list shows each account's balance, derived from its opening balance and its movements and never stored.
- [x] **RF-121** — An account, a group and a person each declare the currency they settle in; what a person declares is what a budget, a goal or a planned payment of their own falls back to when it names no account. A movement carries its own currency, so one account holds several at once — a card bills in pesos and buys in dollars — and a balance derives one figure per account and currency. Amounts are stored as an integer number of hundredths of their currency's major unit, the same scale for every currency; how many decimals a person writes and reads comes from the currency, so one with two decimal places accepts them.
- [x] **RF-122** — A movement between two currencies carries both amounts, each an integer in the one stored scale, hundredths of its own currency's major unit, and a person confirms the second one before it is booked. The rate is their quotient: derived to be read, never stored and never multiplied back out. The app proposes an amount and never imposes one.
- [x] **RF-123** — A card purchase in a foreign currency settles later. The movement books what was spent in the currency it was spent in, and carries the amount a person confirmed it is expected to cost in the account's settlement currency, marked as an estimate. What the issuer actually billed arrives with the statement (RF-129) and replaces the estimate; from then on the two amounts are both settled and the estimate is gone.
- [x] **RF-124** — No surface sums two currencies. A balance, a total and a chart derive per currency and state which one they count.
- [x] **RF-126** — Reading a written amount into the integer a column stores accepts up to two decimals for every currency alike, never capped at fewer because the currency's own convention shows none: a bank posts a savings account's interest, a 4x1000 debit or a settled foreign purchase in centavos whether or not the peso circulates a coin that small. The cap on a typed or imported amount is the column's own stored scale, not what a currency is usually written with; display keeps each currency's own convention (RF-121, RF-125).

#### Debts

- [x] **RF-16** — Paying down a debt is recorded as a transfer from an asset account.
- [x] **RF-78** — A liability account may carry debt terms: an effective annual rate, a minimum payment as a fixed amount or a percentage of balance, a credit limit, a statement cut-off day, a payment due day and an aval.
- [x] **RF-79** — The app estimates a debt's monthly interest from its derived balance and effective annual rate; the annual-to-monthly conversion is effective, not linear.
- [x] **RF-80** — A revolving card exposes its available credit — its limit less its derived balance — its statement cut-off and payment due day, and its minimum payment for the period. Interest, when charged, is a real movement, so the balance stays derived.
- [x] **RF-83** — Consolidated debt view: total owed across all debts, each card's available credit, the summed estimated monthly interest, and the next payment due — each debt's minimum.
- [x] **RF-117** — The consolidated debt view shows the summed available credit across the liability accounts that carry a credit limit.
- [x] **RF-129** — Every account, asset or liability, keeps a statement history: one immutable record per period with its bounds, the closing balance the statement printed and the opening balance, credits and debits it printed. The difference between that closing balance and the balance derived from the account's own movements, in its own settlement currency, is derived on read and shown, never stored.
- [x] **RF-130** — A liability's statement record also carries what the statement charged for that period: interest, fees and the minimum, as printed. A closed period's statement history shows this charged figure, or that none was recorded; it never estimates a closed period. This does not change how the app estimates the current, still-open period's interest (RF-79).
- [x] **RF-131** — A liability's next payment due derives from its latest statement's cut-off and due dates when one exists; the cut-off and due days on its terms are used only until a statement exists.
- [x] **RF-136** — A purchase may be deferred into a number of instalments. Its whole amount joins the balance the month it is billed, never fractioned; what the instalment fractions is that line's contribution to the minimum payment. A payment covering the balance extinguishes the plan without penalty, and the statement publishes it already extinguished. The app never concludes on its own that a purchase was deferred: it proposes it and a person confirms.

#### Transactions

- [x] **RF-17** — Record income (destination account only), expense (source account only) or transfer (both).
- [x] **RF-18** — The type is derived from the accounts involved; the user does not choose it.
- [x] **RF-19** — Transfers are excluded from every income and expense report.
- [x] **RF-20** — Every transaction has a positive amount and at least one account.
- [x] **RF-101** — A transfer names two different accounts; a movement whose source and destination are the same account is refused.
- [x] **RF-62** — Both accounts on a transaction belong to the caller's writable scope: their personal accounts and their group's shared accounts.
- [x] **RF-22** — Quick entry: a single text field from which amount, category and description are inferred. Anything inferred stays editable before saving.
- [x] **RF-23** — Listing with filters by date range, creator, account, category and type.
- [x] **RF-89** — The transaction listing also filters by label, alongside the RF-23 filters.
- [x] **RF-127** — The transaction listing also filters by the recurring rule that generated a movement, alongside the RF-23 and RF-89 filters; a rule opens that filtered listing from its own row, and the filtered export (RF-118) carries the same narrowing.
- [x] **RF-24** — Edit and delete transactions.
- [x] **RF-25** — Every transaction records which user created it.
- [x] **RF-69** — Every income or expense splits into one or more (category, amount_cents) rows summing to its amount; a single-category income or expense is one split. A transfer has no splits and no category.
- [x] **RF-132** — A movement may name the movement that caused it. A caused charge is shown with its cause and is removed with it.
- [x] **RF-133** — A movement whose counterparty is not known is recorded with the side that is known and waits for review; it counts in every balance, and a person completes it later by naming the other account.
- [x] **RF-162** — A movement dated before the opening day of an account it names is refused, wherever it comes from (a form, the import, the nightly recurring run, a connected AI's import), with «La fecha es anterior a la apertura de la cuenta. Cambia la fecha o la apertura de la cuenta.»; an account's opening day cannot move later than a movement it already has. Movements already stored before their account's opening stay as they are. Decided by the user 2026-10-22 (Q5 a, Q11 a, Q12 a, Q13 b).
- [x] **RF-163** — An item marked «Está bien» in «Revisar el mes» can be taken back: under «Revisados» it offers «Deshacer», which drops its mark, so it waits again and counts again on Inicio's line. Only a person who may write the movement takes the mark back. Decided by the user 2026-10-28.
- [x] **RF-164** — An edit that changes a movement's amount makes the amount the person's own: «Revisar el mes» no longer lists it as an amount quick entry read from words. Decided by the user 2026-10-28.
- [x] **RF-165** — An edit that changes a movement's amount also undoes «Está bien» on it for «Muy por encima de lo usual» and «Dos iguales»: the item waits again in «Revisar el mes». A twin pair waits again when either of its movements changes amount. Decided by the user 2026-10-28.
- [x] **RF-167** *(successor of RF-166)* — An income into a fund account carries «De quién»: the fund member it is credited to. The movement form opens it empty and requires it on every income into a fund account, one Zod schema in the form and on the server; an income that arrives without a person (a quick entry, a bank notice, a recurring rule, an import) is stored without one. «Aportes del mes» counts personal-to-fund transfers (RF-139) plus the incomes into fund accounts by their «De quién», lists the incomes with none as «Sin asignar», and shows beside them the fund's spending for the month and the balance of the fund's cash account. The backup (RF-142) exports and restores the field by the member's name. Decided by the user 2026-11-08.

#### Categories

- [x] **RF-63** — CRUD for categories with one level of subcategories, scoped to a user (personal) or a group; a subcategory shares its parent's scope.
- [x] **RF-27** — Each category is either expense or income.
- [x] **RF-64** — Creating a personal space or a group seeds an initial category set in the active language.
- [x] **RF-140** — Every screen that names a category shows its scope — «Mercado · fondo» for a fund category, with no mark for a personal one — and the importer resolves a category name by the scope of the account the movement lands in. Both seeded sets (RF-64), personal and fund, stay. Decided by the user 2026-10-15.
- [x] **RF-70** — Labels, independent of category, attach to transactions through a transaction_labels join; a group's labels are managed by its leader, a user's by their owner.

#### Recurring

- [x] **RF-29** — CRUD for recurring rules with monthly, weekly or yearly frequency, and the day that matches that frequency.
- [x] **RF-30** — A daily process turns due rules into real transactions.
- [x] **RF-31** — Generated transactions are distinguishable from manual ones and are editable: the real amount of a utility bill varies.
- [x] **RF-32** — A rule can be paused or given an end date without erasing its history.

#### Budgets, planned payments and goals

- [x] **RF-71** — CRUD for budgets: a spending limit on a category for a repeating period (monthly, weekly or yearly), scoped to a user or a group, optionally narrowed to one account and/or one label.
- [x] **RF-160** *(successor of RF-72)* — A budget's spent and remaining amounts derive from the transaction splits that fall in the current period and match its category or any of that category's subcategories, and any account or label narrowing; they are never stored. Filtering movements by a parent category shows its subcategories' movements too. Decided by the user 2026-10-18.
- [x] **RF-73** — A budget carries an overspend alert threshold as a percentage of its limit; a budget is flagged once its derived spending crosses that threshold.
- [x] **RF-74** — CRUD for one-off planned payments: a future movement — its accounts, amount, category and due date — with an optional reminder date, kept distinct from recurring rules.
- [x] **RF-141** — A planned payment's reminder (RF-74) notifies the person by email on its reminder date. Decided by the user 2026-10-15.
- [x] **RF-161** *(successor of RF-75)* — Settling a planned payment records the transaction it planned, links the two, and marks the planned payment done; while that movement exists the payment cannot be settled again, and a cancelled one is never settled. Deleting the movement that settled a planned payment returns the payment to «Por pagar», unlinked, so it can be settled again. Decided by the user 2026-10-22 (Q4 b).
- [x] **RF-76** — CRUD for savings goals: a target amount and an optional target date, scoped to a user or a group.
- [x] **RF-87** — A savings goal's progress — amount saved and amount remaining — derives from its contributions (`goal_contributions`), each an amount set aside virtually with no movement required; it is never stored.
- [x] **RF-119** — A savings goal's contributions are listed with their amounts and dates and one is removed from that list; the goal's progress re-derives from what remains.
- [x] **RF-120** — A budget or a savings goal is archived instead of deleted, and restored from the archive; an archived one leaves the active list and stays readable in its own archived tab.

#### Reports

- [x] **RF-88** — Dashboard: net worth per owner (personal and group), and income, expense and net for the current month.
- [x] **RF-34** — This month's expenses by category, largest first.
- [x] **RF-139** *(successor of RF-66)* — Each member's contribution for the month: net of transfers into the group's accounts, less those flowing back to that member, plus the movements paid from that member's personal accounts that the person marked «del hogar» — a household bill paid from a personal card. The mark is on the movement and can be set and cleared. Decided by the user 2026-10-15.
- [x] **RF-35** — Six-month comparison of income and expense.
- [x] **RF-67** — In every report grouped by member, the group's shared accounts appear as their own group. Shared accounts are not split across people.

- [x] **RF-137** — A person reconciles one account at a time: they enter the money it really holds on a day, and the app shows the balance it derives for that day, the real one and the gap between them. On confirm, the gap is recorded as one adjustment movement on that account, dated that day, so the derived balance equals the real one from then on; no balance is stored (RF-114). Each account lists its reconciliations: the day, what the app derived, what was real and the gap. Decided by the user 2026-10-14.
- [x] **RF-138** — A reconciliation's adjustment reports as its own line, «Descuadre», apart from expenses and income: it counts in no expense or income total and in no budget. Decided by the user 2026-10-14.

#### Cash

- [x] **RF-68** — A cash withdrawal goes to the member's own cash account or the group's shared cash, per the group's `cash_mode`.
- [x] **RF-40** — Cash expenses come out of the matching cash account. By RF-19 the withdrawal is not an expense, so the amount is never counted twice.
- [x] **RF-41** — Handing physical cash between people is not recorded: it does not change accounts.
- [x] **RF-42** — Returning cash to a person is a transfer into one of their accounts and reduces their contribution.
- [x] **RF-56** — A group configures its cash (`cash_mode`): a single shared cash account, or one personal cash account per member.

#### Audit

- [x] **RF-43** — Every creation, change and deletion of fund data is logged with what was touched, by whom, when, and the before and after values.
- [x] **RF-44** — No user can edit or delete the log. The only permitted removal is the automatic purge in RNF-14, or a row proven to be the test harness's own: one naming a registered harness identity as its actor or its owner, or, when neither is named, one whose actor and owner are both null and whose action is `DELETE`. A null actor and a null owner together mean a connection that settled no session claims; only the harness's own connections and the recurring generator (RF-30) write without claims, and the generator only inserts, so a both-null `DELETE` row cannot be the generator's and is the harness's.
- [x] **RF-45** — Capture is automatic and no write can bypass it, including those from the recurring process, which are marked as system writes.

#### Language

- [x] **RF-46** — Interface in Spanish and English, with the language visible in the URL. Spanish by default.
- [x] **RF-47** — The preference belongs to the user and holds wherever they sign in, fund or no fund.
- [x] **RF-125** — No interface text is hardcoded. Dates and numbers follow the active language, and an amount is formatted in the currency it is in.

#### Appearance

- [x] **RF-54** — Light theme, dark theme, or follow the system, switchable from the app shell. The choice persists on the device that made it.

#### Import, export and visible audit (phase 2)

- [x] **RF-49** — Download a spreadsheet template with the expected columns and the existing accounts and categories as valid options.
- [x] **RF-118** — The transaction listing exports exactly the rows its active filters select, in the same shape the import accepts.
- [x] **RF-142** *(successor of RF-50)* — The backup exports, and the import restores, accounts, members, categories, recurring rules, transactions, budgets (RF-71), goals and their contributions (RF-87, RF-119), debts and statements (RF-78, RF-129), and labels (RF-70), in one shape. A purchase made in dollars on a peso card (RF-123) is exported and re-imported in dollars, never converted to pesos. Decided by the user 2026-10-15.
- [x] **RF-51** — Import with preview: everything is validated before anything is written, errors are reported per row, and the user confirms. All or nothing.
- [x] **RF-52** — Re-importing the same file does not duplicate: every row carries a stable external reference and, if it already exists in the fund, it is updated.
- [x] **RF-53** — Read-only audit log viewer, filterable by entity, user and date range.

#### Ingest

- [x] **RF-86** — A user issues, names and revokes per-user webhook credentials; each credential's bearer token is shown once and stored only as a hash, may carry a default account and category the ingest falls back to when the payload does not name them, and a per-credential rate limit.
- [x] **RF-90** — A webhook delivery is stored as a pending proposal, never as a movement: a person accepts it, which records the movement, or rejects it, and a re-delivery of a reference already stored changes nothing.
- [x] **RF-91** — Accepting a complete proposal records the movement in one action; an incomplete one opens the movement form prefilled with everything the delivery read.
- [x] **RF-92** — A message shape is remembered per user: a shape a person silenced arrives already rejected and never waits for review, and a shape never seen before always waits.
- [x] **RF-93** — A merchant's category prefills a delivery's proposal only once that merchant is trusted; it never records a movement on its own.
- [x] **RF-94** — A merchant becomes trusted after two consecutive approvals under the same category, and an approval under a different category marks it ambiguous, which no later consistency undoes.
- [x] **RF-128** — Quick entry and webhook ingest read a bank amount the way the importer does: thousands separators as comma or dot, in either convention, an optional zero-decimal suffix, and up to the two decimals the column stores (RF-126). A finer amount is refused, never rounded; no path drops a cent a person or a bank wrote in silence.
- [x] **RF-96** — Webhook ingest proposes income or expense only when the bank message carries a recognized direction verb; a caller-supplied direction overrides it, and an unknown verb leaves it empty.
- [x] **RF-97** — An account may store its last four digits; webhook ingest proposes the uniquely matching account named by a bank message before falling back to the credential default, while an explicit account override still wins.
- [x] **RF-98** — Webhook ingest proposes the date the bank message carries, written with a two- or four-digit year and interpreted in `America/Bogota`; a caller-supplied date still overrides it, and a message whose date is unreadable or later than the day of delivery falls back to that day.
- [x] **RF-99** — A person sees the message shapes they have silenced, each with the message that silenced it, and returns one to the queue: later messages of that shape wait for review again, and every message of that shape the silence discarded on its own comes back to the queue with it, indistinguishable from one never silenced. A message a person discarded stays discarded.
- [x] **RF-134** — A movement keeps one source reference per account leg — the statement it came from, the reference that statement gave that leg, and the line within it — so a transfer read from either side's statement is recognised as the movement already recorded, and re-importing a statement replaces exactly that statement's rows. Built 2026-10-30 and 2026-11-10: each imported leg keeps its reference or line (`transaction_sources`) and the statement it came from (`statement_id`, a statement being told apart by its account and cut-off date); a re-import or the other side's statement links instead of duplicating, and a re-import of a statement drops the lines it no longer names (the movement when that statement was its only source, else only that leg's source) while keeping and adding the rest, as the preview says beforehand.
- [x] **RF-144** — Bank statements are imported through an MCP server that Claude drives: the person hands the file to Claude in a conversation, Claude reads it and calls a preview tool, the person confirms, and then an import tool writes. No paid model runs inside the app. The preview is mandatory, and re-importing the same statement never duplicates a movement (RF-134, RF-52). Earlier statements serve as examples, never as a template. Decided by the user 2026-10-15. Built 2026-10-30: `/mcp` with `preview_statement` and `import_statement`; a key minted for Claude opens it, a webhook key never does. A transfer across currencies is imported with the amount the person confirms on the other account (the TRM).
- [x] **RF-168** — Claude on claude.ai (web, desktop or mobile) connects to HomeFund as a custom connector with the URL `https://<host>/mcp` and signs in with HomeFund through OAuth: the connector registers itself, the person is sent to HomeFund's own sign-in if signed out and then to a screen that says what Claude may and may never do, and «Permitir» hands Claude a key. That key is the `mcp` key of RF-144: «Ajustes · Correos del banco» lists it and revoking it disconnects Claude; a code is redeemed once and with its PKCE verifier, and a replayed code revokes the key it bought, and a new connection of the same client replaces that person's earlier key, so each connection shows one key; registration is open to anyone but limited to ten a caller an hour. The key made by hand for Claude Code keeps working. Decided by the user 2026-11-10. Built 2026-11-10: `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`; no refresh token, the key lasts until revoked.
- [x] **RF-169** — Claude records movements through the MCP (RF-144) from what the person hands it in the conversation (a photo of a receipt, a bank message, an invoice): `record_movement` writes an expense, income or transfer, `update_movement` and `delete_movement` fix one the person can write. Each runs the same Zod schema and the same write as the movement form (the kind derived from the accounts, «De quién» required on an income into a fund account, the category's scope against the account's, the opening date, the second amount across currencies), as the key's owner under the same policies, and answers a refusal in the form's own words in Spanish, never a stack. A tool's description tells Claude to confirm with the person what it is about to write and to look for a duplicate first. No model runs inside the app.
- [x] **RF-170** — Claude creates accounts and categories through the MCP: `create_account` and `create_category` take the fields of the account form and the categories screen, personal or in the fund, validated by the same schemas and written by the same code, with the same refusals.
- [x] **RF-171** — Claude reads what it needs to write well through the MCP: `list_categories` answers the person's categories and their fund's with kind, parent and scope, and `list_movements` the recent movements of an account or of all, filtered by dates, so a duplicate is found before a movement is written. Both run as the key's owner; a webhook key opens none of the tools.
- [x] **RF-172** — Claude edits an account through the MCP: `update_account` takes the fields of the account edit dialog with the stamp `list_accounts` returned, writes through the same schema and write as the dialog, and a stale stamp is refused.
- [x] **RF-173** — A pocket is an account inside a savings account, like a bank's pockets: it keeps its own movements and balance, shows under its parent in the list, and the parent's row carries the total of both with its own part read as «Libre». The parent is an open asset account of the same owner or group and the same currency, and is never a pocket itself; a parent with live pockets is not archived or deleted. Net worth and every total count each account once. Claude reads `parentAccountId` in `list_accounts` and sets it in `create_account` and `update_account`.
- [x] **RF-180** — A person moves one of their own accounts into the fund they belong to from its ⋮ menu, «Pasar al fondo», after a confirmation that says what changes. The account keeps its id, balance, movements, pockets, statements and debt terms; it becomes a shared fund account, written by any member, and its movements, planned payments and rules take the fund's scope. A personal category or label on them is swapped for the fund's with the same kind, name and parent name; when one has no twin, the move is refused. Also refused: a personal budget or goal pointing at the account or its movements, a cash account when the fund keeps one shared cash (RF-56) and already has it, a pocket on its own (it moves with its parent), an archived account, another person's account, and a person in no fund. An income already in the account keeps no «De quién» (RF-167); the audit log (RF-45) records the move under the person. Claude does it with `move_account_to_fund`, which asks to confirm with the person first. It replaces the refusal RF-61 made of any account with history. Decided by the user 2026-11-10.
- [x] **RF-174** — A toggle hides every amount in the app on that device until shown again: an eye button on Inicio's net worth card and in the app's header (the sidebar on a laptop, the top bar on a phone) swaps each figure for a mask that keeps the currency mark, and the choice persists in the device's storage. What a person types into an amount field stays as typed.
- [x] **RF-175** — A receipt with several products is one movement whose lines are its splits: each line carries an optional product name (`description`, up to 200 characters), its amount and its category, which may be a subcategory (shown «Mercado › Lácteos»); several lines may share a category, and the lines sum exactly to the movement's amount. Budgets and reports keep deriving from the splits by category (RF-160). The movement's detail lists the lines, the movement list keeps one row with the number of lines, the split editor takes a «Detalle» per line, and Claude sends the lines in `record_movement` and `update_movement` and reads them in `list_movements`. A discount is subtracted from the lines it applies to, never booked as a negative line.
- [x] **RF-176** — Claude cleans up a badly categorised account through the MCP, never by SQL: `list_movements` filters by category (its subcategories included) and pages with `offset`; `update_category` renames a category or moves it under another parent of the same kind, or to the top level, refusing a nesting that is not one level or a kind that differs; `merge_movements` folds 2 to 50 expenses, or incomes, of one account into one movement whose lines are the originals' (category, amount, and each one's description as the line's name; an original with lines gives each) and deletes them, all or nothing, refusing transfers, mixed accounts, kinds, currencies or contributors, other people's movements and any tied to a statement, planned payment, goal, deferral, instalment or reconciliation; `move_category_movements` moves every line of one category to another of the same kind in one statement, optionally within a date range. Each tool's description asks Claude to show the list and ask one yes before writing.
- [x] **RF-177** — Claude clears the inbox (RF-90) through the MCP: `list_inbox` answers the person's pending deliveries (or, with `status`, the accepted or rejected ones, paged) with id, date received, the message as it arrived and the proposal (amount in cents, currency, kind, account, category with its path, date, description) plus `notDetected`; `accept_deliveries` accepts 1 to 50 by the same schema and write as the «Aceptar» button (movement, audit, `created_by`, the delivery's reference against duplicates) with optional overrides per delivery (account, category or lines with their description, amount, description, date, kind, both accounts of a transfer), all or nothing in one transaction, refusing with the delivery's id and the missing field when it lacks an account, amount or category; `reject_deliveries` rejects 1 to 50 by the same write as «Rechazar», all or nothing. A delivery that is not the person's own pending one is refused as not found. Each description tells Claude to list first, show one compact list and ask ONE yes for the whole list, rejections included. Decided by the user 2026-11-10.
- [x] **RF-178** — A liability is a card or a loan (`subtype` `loan`, only under kind `liability`; the database refuses it on an asset). Cuentas lists its accounts by type, each section with its subtotal per currency: «Cuentas», «Tarjetas de crédito» and «Préstamos», the empty ones omitted. A loan reads as a debt everywhere a liability does (RF-114, debts screen, statements); only a card is created from the debts screen.
- [x] **RF-179** — The export, the import and the template share one sheet format a person reads, with no ids and no external reference: a movement's columns run date, from, to, amount, currency, description, category, then labels, whose, household, adjustment and the second amount; every sheet names its row first. Accounts, categories (by «Parent › Child» path), currencies and every closed set (category kind, account kind and class, placement, frequency, period, debt kind, yes/no) are dropdowns in the person's language and read back to their stored value. Movements are tinted by type, derived from the accounts: expense, transfer, income. A row with no key is recognised as one the fund holds by its name, or for a movement by date, accounts, amount and description, and updates it; a repeat of the file adds nothing. A goal contribution no longer names the movement it earmarks.
- [x] **RF-184** — Claude finds the person's spending patterns through the MCP: the read-only tool `spending_patterns` answers, over the person's own accounts and the fund's they see, the last `months` closed months (1 to 24, 12 by default) plus the current one: spending by category and month; the charges that repeat (the same description, without case, accents, digits or punctuation, on the same account and currency, at least three times, monthly or weekly, with their typical amount, last date, next expected date and whether they still run); the amounts above usual by RF-155's rule; and the categories whose recent closed months (three, or half the window when shorter) average over 125 % of the months before. Every figure is integer cents per currency, never summed across currencies, in one round trip. The app calls no model: the description asks Claude to look for patterns and propose actions. Decided by the user 2026-11-11.
- [x] **RF-181** *(extends RF-139; retires nothing)* — A fund account may name its holder: one member of that fund, login or not (a relative whose bank account the leader manages). The account form says «Titular» («Nadie, es de todos» by default), Cuentas names the holder on the row and filters by it, and Claude sets it through `create_account` and `update_account` (`holderMemberId`, the ids from `list_members`; `list_accounts` answers it with the name). The database refuses a member of another fund and a holder on a personal account. A held account counts for its holder like RF-139's personal accounts: a transfer from it into a fund account that has no holder is that member's contribution for the month, one back into it reduces it; a transfer between two held accounts, or between two without a holder, moves no one's contribution. A held account is its holder's own pocket and no part of the fund's pot: money into or out of it from a personal account or as an income (RF-167) is no contribution, so 100 going from a personal account through a held one into the fund counts once, for the holder, and a held account stays out of the fund's cash balance. Deleting the member leaves the account without a holder. Decided by the user 2026-11-10.
- [x] **RF-182** — A movement in a fund context (on a fund account, or marked «del hogar») says who made it: «Lo hizo», a member of that fund, login or not, a nullable reference kept inside the fund by the database and refused on a purely personal movement. It is a column of its own, apart from an income's «De quién» (RF-167: whose money came in) and from `created_by`, which stays the person who typed it. A write that names no maker credits the holder (RF-181) of the account the money leaves, else the household; empty means the household, and Reports count an expense out of a held account that names nobody for its holder. The movement form and quick entry offer it only for fund movements; the list and the detail show the name; Movimientos filters by it and Reports split the month's spending per member. The sheet (RF-179, so the backup of RF-142) carries it by name in a «Lo hizo» column after «De quién»; a blank cell is the holder of the account the money leaves, else the household, and a name outside the movement's fund refuses the row. Claude reads and writes it through the MCP as `madeByMemberId` (`record_movement`, `update_movement`, `merge_movements`, `accept_deliveries`, `list_movements`, which also returns `madeByName`) and finds the ids in `list_members`. Decided by the user 2026-11-10.
- [x] **RF-186** — An iOS Shortcut sends the inbox (RF-90) an expense the person types or a bank text message, through the same ingest route and webhook key (RF-86) as any caller: «Ajustes · Correos del banco» has an «Atajo de iPhone» card with the URL and the exact Shortcuts steps (Solicitar entrada, Obtener contenido de URL with POST, the `Authorization: Bearer` header and a JSON body). A typed expense sends `direction` `expense` and the current date as `external_ref`, so two equal expenses are two deliveries; a message automation sends the text alone, so the same message twice is one. The route changes nothing. Decided by the user 2026-11-11.
- [x] **RF-187** — A bank's notification email forwarded to an address becomes one more inbox delivery (RF-90), read by the same parser as any webhook text: `/api/webhooks/email` takes Resend Inbound's `email.received` event, signed with Svix, whose recipient or forwarding header carries a webhook key (RF-86) as `whk_…@<domain>` or `name+whk_…@<domain>`, reading the body back from Resend by the email's id; or any forwarder's `{ subject, text, html }` with the key as a bearer. The delivery's text is the subject and the body without the forward header block, quote marks or markup, cut to the ingest ceiling around its first amount. A Resend delivery's reference is the email's id, so a retry is one delivery; a body Resend does not return answers 503 so it retries. An unsigned call with no key, a forged signature and an unknown key all answer 401. Decided by the user 2026-11-11. Waits on the user: a receiving domain in Resend, its webhook, and `INBOUND_EMAIL_WEBHOOK_SECRET` and `RESEND_API_KEY` in Vercel.
- [x] **RF-188** — HomeFund installed on an iPhone opens like an app: a launch image per current iPhone (CSS size, pixel ratio, portrait) and theme, the mark on the page's own background, drawn at build time; an opaque 180 px home-screen icon; the status bar `default`, legible in both themes; the page, the sidebar and the bottom bar clear the notch and the home indicator. Safari in a tab on an iPhone or iPad shows a discreet note «Agrégala a tu inicio» with the steps (Compartir → Agregar a pantalla de inicio) until the person dismisses it on that device; the installed app, other browsers and other systems never show it. Decided by the user 2026-11-11.
- [x] **RF-183** — Inside a fund, one member owes another, with or without a login of their own: «Papá le debe a Adrian $200.000 — préstamo para la moto». Each entry is a debt or a payment of it (partial or whole), with the fund, the debtor, the creditor, the amount in integer cents, the currency, the date, a description and `created_by`. What each pair still owes per currency is derived from the entries, a payment netting against the debt and debts both ways netting into one figure, never stored; a payment larger than what is still owed is refused. The database refuses a debtor who is the creditor and a member of another fund. Any member of the fund with a login reads, writes and removes its entries; nobody outside it sees them, and nobody edits one. Planeación → Deudas shows an «Entre miembros» section: each pair with what it still owes, its entries, and «Registrar deuda» and «Registrar pago». Claude reads them with `list_member_debts` and writes one with `record_member_debt`, which asks to confirm with the person first. Decided by the user 2026-11-11.
- [x] **RF-185** — Planeación has «Suscripciones»: the charges HomeFund finds repeating by RF-184's fixed rules over the last twelve closed months plus the current one, each with its name, typical amount, how often (every month or every week), next expected charge and account. The running ones come first, soonest next charge first, and the title carries what they cost a month per currency (a weekly charge counts 52 over 12 months, in whole cents); the ones whose next charge is overdue by more than the rule's grace sit apart under «Sin cobro reciente» with their last date. The hub has its tile. The screen only reads: nothing is stored, and Claude reviews the list with the person through `spending_patterns`. Decided by the user 2026-11-11.
- [ ] **RF-189** — A person saves the numbers their bank messages name as recipients: «Destinatarios» in Ajustes, next to «Correos del banco», lists, adds, edits and removes them, each with the digits of an account or a phone, a name («Nequi de mamá», «Arriendo Don José») and what it is: one of their own accounts (with that account), a person (with their «Me debe» account, if any) or a payee (with a default category). A number is saved once per person. Ingest reads the destination or source number out of the message («a la cuenta *3203359119», «a la llave 3203359119», «de 3203359119») and keeps it on the delivery; a notice shows the whole number or a tail like `*6870`, so a saved number matches when it ends with the digits shown, and two matches are no match. A match makes the proposal: an own account, or a person with an account, a transfer between that account and the bank account the message names (into it for an expense, out of it for an income); a payee an expense in its category; a person with no account only the description. The description is the recipient's name, not the whole message, and the delivery still waits in the Bandeja for a person (RF-90). A delivery whose number is unknown offers «Guardar este número», prefilled. Claude reads each delivery's number and matched name in `list_inbox`, lists with `list_recipients`, saves with `save_recipient` (create or update) and removes with `delete_recipient`, and asks the person once what an unknown number is before saving it. Decided by the user 2026-11-11.
- [x] **RF-135** — A counterparty is remembered per user: a description pattern earns an account and a side after two consecutive agreeing completions, and a completion naming a different account marks the pattern ambiguous, which no later agreement undoes. A remembered pattern prefills the missing side and never fills it on its own.

The webhook (RF-90) reuses RF-22 (quick entry), RF-25 (created_by) and RF-45 (no write bypasses audit) unchanged: the same interpreter reads the payload text and the same insert path records the movement, so the created-by stamp and the audit hold as on any manual write. RF-52's idempotency shape is mirrored, not reused — RF-52 stays a spreadsheet-import requirement; the webhook applies the same stable-external-reference rule to its own deliveries. The review queue keeps that reuse: it runs RF-22's interpreter to propose rather than to decide, and RF-25 and RF-45 hold unchanged because an accepted proposal is still written through the same insert path.

### Non-functional requirements

| ID | Requirement |
|---|---|
| RNF-01 | **Zero operating cost.** If a technical decision implies paying, it is discarded. |
| RNF-02 | Fixed stack, the one in section 4. Every library must save a substantial amount of code. |
| RNF-03 | The browser never queries the database directly. Everything goes through the server. |
| RNF-04 | Authorisation is enforced in the database, evaluated against the real session user. Automatic system writes run with their own privileges and are identified as such. |
| RNF-05 | Money is stored as an integer number of hundredths of its currency's major unit — one scale for every currency, whatever its own minor unit is. How many decimals a person types and reads comes from the currency. Floating point is forbidden. Formatting exists only in the presentation layer. |
| RNF-06 | Movement dates carry no time and are interpreted in `America/Bogota`. |
| RNF-07 | Balances are derived from movements. They are never stored in a column that has to be kept in sync. |
| RNF-08 | Mobile-first and installable as a PWA. |
| RNF-09 | The dashboard responds in under 2 s with a year of movements loaded. |
| RNF-10 | All input is validated on the server, with the same schema that validates the form. Client-side validation is never sufficient. |
| RNF-11 | The database schema is versioned in migrations. TypeScript types are derived from the schema, never written by hand. |
| RNF-12 | The service cannot go down because of free-tier inactivity. |
| RNF-13 | No data leaves to third parties: no analytics, no bank credentials, no scraping. Reading a public figure from the server — an exchange rate — sends nothing about the fund or the person and is not an exit. |
| RNF-14 | The audit log is purged automatically after 24 months. |
| RNF-15 | Import is processed on the server and must work within the free tier's execution limits, in batches if necessary. |

### Retired

Dead codes. The number stays burned and the tick stays as it was.

- [x] **RF-75** — Settling a planned payment records the transaction it planned, links the two, and marks the planned payment done; a settled or cancelled planned payment cannot be settled again. _Retired 2026-10-22, by the user. Successor: RF-161 (deleting the movement that settled a planned payment returns the payment to «Por pagar»)._
- [x] **RF-72** — A budget's spent and remaining amounts derive from the transaction splits that fall in the current period and match its category and any account or label narrowing; they are never stored. _Retired 2026-10-18, by the user. Successor: RF-160 (a parent category's budget and its movement filter count its subcategories)._
- [x] **RF-50** — Export accounts, members, categories, recurring rules and transactions, in the same shape the import accepts. _Retired 2026-10-15, by the user. Successor: RF-142 (the backup restores everything: budgets, goals, debts, statements, labels, and a dollar purchase in dollars)._
- [x] **RF-66** — Each member's contribution for the month: net of transfers into the group's accounts, less those flowing back to that member. _Retired 2026-10-15, by the user. Successor: RF-139 (a household bill paid from a personal card, marked «del hogar», counts as a contribution)._
- [x] **RF-84** — A liability account keeps a statement history: one record per statement period with its bounds, its payment due date and the balance, minimum and interest captured at the cut-off. A statement is an immutable historical snapshot, materialised for past periods, never rewritten. _Retired 2026-09-07. Successor: RF-129._

  Retired because the built behaviour changed, not the wording. "Materialised for past periods" named
  `materialiseDueStatements`, which read the cut-off **day** off the account's terms, walked the
  calendar, and stored the balance derived from the person's own movements as the statement. So a
  stored statement was the ledger under another name and could never disagree with it. RF-129 replaces
  it with a record of what a statement printed, entered by a person, for an account of any kind — so
  the difference between the printed figure and the derived one becomes a number worth reading.

- [x] **RF-02** — A user can belong to several funds; they operate on one at a time and can switch. _Retired 2026-08-28. Successor: RF-55 (one optional group per user, no switching)._
- [x] **RF-38** — The fund has a shared cash account, created along with the fund. _Retired 2026-08-28. Successor: RF-56 (configurable `cash_mode`)._
- [ ] **RF-03** — Only the `owner` invites members, edits the fund and manages categories. _Retired 2026-08-28. Successor: RF-57 (group leader manages the group)._
- [x] **RF-48** — No interface text is hardcoded. Dates and numbers follow the active language; the currency is always COP. _Retired 2026-09-05. Successor: RF-125 (an amount is formatted in the currency it is in)._
- [x] **RF-04** — All members of a fund see the same data. There are no partial-read roles. _Retired 2026-08-28. Successor: RF-58 (universal read, bounded write)._
- [ ] **RF-05** — Whoever creates the fund becomes `owner`. The role is transferable, but a fund is never left without an owner. _Retired 2026-08-28. Successor: RF-59 (group leader)._
- [x] **RF-08** — CRUD for accounts. Every account belongs to the fund; linking it to a member is optional. Without a member it is a shared account. _Retired 2026-08-28. Successor: RF-60 (personal vs group account)._
- [x] **RF-12** — Archiving a member does not archive their accounts. The user decides per account: archive it or hand it to the fund. _Retired 2026-08-28. Successor: RF-61 (hand to the group)._
- [ ] **RF-13** — A liability account may carry an effective annual rate, minimum payment, credit limit and payment day. _Retired 2026-08-29. Successor: RF-78 (debt terms with kind, percentage minimum, cut-off and aval)._
- [ ] **RF-14** — The app estimates monthly interest from balance and rate. The annual-to-monthly conversion is effective, not linear. _Retired 2026-08-29. Successor: RF-79 (interest from derived balance)._
- [ ] **RF-15** — Consolidated debt view: total balance, summed monthly interest and next payment due. _Retired 2026-08-29. Successor: RF-83 (available credit and installment lines due)._
- [ ] **RF-21** — Both accounts on a transaction always belong to the same fund. _Retired 2026-08-28. Successor: RF-62 (same writable scope)._
- [x] **RF-26** — CRUD for categories with one level of subcategories. A subcategory belongs to the same fund as its parent. _Retired 2026-08-28. Successor: RF-63 (scoped to user or group)._
- [x] **RF-28** — Creating a fund seeds an initial category set in the active language. _Retired 2026-08-28. Successor: RF-64 (seed on personal space or group)._
- [ ] **RF-33** — Dashboard: balance per account, net worth per member, and income, expense and net for the current month. _Retired 2026-08-28. Successor: RF-65 (net worth per owner)._
- [ ] **RF-36** — Each member's contribution for the month: net of transfers into fund accounts, less those flowing back to that member. _Retired 2026-08-28. Successor: RF-66 (group accounts)._
- [ ] **RF-37** — In every report grouped by member, the fund appears as one more group. Shared accounts are not split across people. _Retired 2026-08-28. Successor: RF-67 (shared accounts as a group)._
- [ ] **RF-39** — A cash withdrawal goes to the member's own cash account if they have one, and to the fund's if they do not. The app neither asks nor stores a mode: the rule is derived from which accounts exist. _Retired 2026-08-28. Successor: RF-68 (per `cash_mode`)._
- [ ] **RF-65** — Dashboard: balance per account, net worth per owner (personal and group), and income, expense and net for the current month. _Retired 2026-08-30. Successor: RF-88 (net worth per owner, no balance per account on the dashboard)._
- [ ] **RF-77** — A savings goal's progress — amount saved, amount remaining and whether it is on track for its target date — derives from the movements contributed to it; it is never stored. _Retired 2026-08-30. Successor: RF-87 (derives from contributions, which may be virtual amounts with no movement)._
- [ ] **RF-85** — A signed JSON webhook creates a movement from a payload: the request carries a bearer credential that resolves it to exactly one user; the quick-entry interpreter (RF-22) infers amount, category and description from the payload's text; the movement is written under that user's writable scope so the access policies and the audit apply as if the user had recorded it; and a stable external reference makes a re-delivery idempotent, updating nothing and duplicating nothing. _Retired 2026-08-31. Successor: RF-90 (a delivery is stored as a proposal a person accepts; the webhook never writes a movement)._
- [ ] **RF-115** — A budget's spent and remaining derive for a chosen period, not only the current one; the period is browsable into the past and the derivation is unchanged. _Retired 2026-09-01. Successor: RF-72 (the browsable period was already built under RF-72; this code named it a second time, so nothing was dropped)._
- [ ] **RF-116** — A category shows how many subcategories hang off it, and a label how many transactions and how many budgets use it; every count derives and is never stored. _Retired 2026-09-01. Successors: RF-63 and RF-70 (the category and label counts were already built under those codes; this code named them a second time, so nothing was dropped)._
- [x] **RF-81** — A fixed-installment or BNPL debt carries a plan — principal, number of installments, frequency (monthly or fortnightly), interest, down payment, aval, start date and merchant — from which dated installment lines are generated. _Retired 2026-09-06. Successor: RF-136 (a deferral fractions the minimum payment, never the debt). The six card statements publish no per-instalment due dates, only `n/36`, and carry not one line at instalment 2 or higher — but that is because the balance was paid in full every cycle, which extinguishes a plan, not because the card cannot defer. What the statements refute is RF-81's dated lines that add to total owed; the deferral itself is real and `1/36` is the card naming it._
- [x] **RF-82** — A payment into a debt account is allocated to its unpaid installment lines oldest-first, marking a line paid only when the payment fully covers it and linking the paying movement; a partial remainder is left unallocated, and a plan's pending is its unpaid lines, always derived, never stored. _Retired 2026-09-06 with RF-81, whose lines it allocated against._
- [x] **RF-95** — Quick entry accepts bank amounts written with comma or dot thousands separators and an optional zero-decimal suffix in either locale, without accepting fractional pesos. _Retired 2026-09-06. Successor: RF-128 (the same reading as the importer, up to the two decimals the column stores)._
- [ ] **RF-166** — An income into a fund account carries «De quién»: the fund member it is credited to, defaulting to the person writing it and asked nowhere else. «Aportes del mes» counts personal-to-fund transfers (RF-139) plus the incomes into fund accounts by their «De quién»; an income with none stays out, and the report says so in one line. The backup (RF-142) exports and restores the field by the member's name. Decided by the user 2026-10-31 («Elige lo que recomiendas»). _Retired 2026-11-08, by the user. Successor: RF-167 (no value is presumed: «De quién» opens empty and is required on every income into a fund account made in the form; what arrives without a person is «Sin asignar»; Aportes also shows the fund's spending and the cash balance)._

---

## 2. Data model

```mermaid
erDiagram
    groups ||--o{ group_members : "has"
    groups ||--o{ accounts : "holds (optional)"
    groups ||--o{ categories : "defines"
    groups ||--o{ labels : "defines"
    groups ||--o{ transactions : "groups"
    groups ||--o{ recurring_rules : "groups"
    groups ||--o{ budgets : "groups"
    groups ||--o{ planned_payments : "groups"
    groups ||--o{ savings_goals : "groups"
    groups ||--o{ audit_log : "records"

    app_users ||--o{ audit_log : "acts"
    app_users ||--o{ categories : "defines (personal)"
    app_users ||--o{ labels : "defines (personal)"
    app_users ||--o{ accounts : "owns (personal)"
    app_users ||--o{ transactions : "owns (personal)"
    app_users ||--o{ recurring_rules : "owns (personal)"
    app_users ||--o{ budgets : "owns (personal)"
    app_users ||--o{ planned_payments : "owns (personal)"
    app_users ||--o{ savings_goals : "owns (personal)"
    app_users ||--o{ webhook_credentials : "issues"
    app_users ||--o{ ingest_deliveries : "owns"
    app_users ||--o{ ingest_shapes : "decides"
    app_users ||--o{ ingest_merchants : "learns"
    app_users ||--o{ ingest_counterparties : "learns"

    accounts ||--o| webhook_credentials : "default"
    categories ||--o| webhook_credentials : "default"
    webhook_credentials ||--o{ ingest_deliveries : "delivers"
    app_users ||--o{ oauth_codes : "approves"
    oauth_clients ||--o{ oauth_codes : "asks"
    webhook_credentials ||--o| oauth_codes : "bought by"
    transactions ||--o| ingest_deliveries : "records (once accepted)"
    categories ||--o{ ingest_merchants : "remembers"

    accounts ||--o{ ingest_counterparties : "remembers"
    accounts ||--o| debt_terms : "if liability"
    accounts ||--o{ installment_plans : "schedules"
    accounts ||--o{ account_statements : "closes"
    accounts ||--o{ account_reconciliations : "reconciles"
    account_reconciliations ||--o| transactions : "adjusts (one-legged, when the gap is not zero)"
    app_users ||--o{ account_reconciliations : "counts"
    transactions ||--o{ transaction_sources : "references"
    account_statements ||--o{ transaction_sources : "names"
    installment_plans ||--o{ installment_lines : "generates"
    accounts ||--o{ transactions : "source"
    accounts ||--o{ transactions : "destination"
    accounts ||--o{ recurring_rules : "source"
    accounts ||--o{ recurring_rules : "destination"
    accounts ||--o{ budgets : "narrows (optional)"
    accounts ||--o{ planned_payments : "source"
    accounts ||--o{ planned_payments : "destination"
    accounts ||--o{ savings_goals : "holds (display)"

    categories ||--o{ categories : "parent of"
    categories ||--o{ transaction_splits : "classifies"
    categories ||--o{ recurring_rules : "classifies"
    categories ||--o{ budgets : "limits"
    categories ||--o{ planned_payments : "classifies"

    labels ||--o{ budgets : "narrows (optional)"

    transactions ||--o{ transaction_splits : "splits into"
    transactions ||--o{ transaction_labels : "tagged by"
    transactions ||--o| planned_payments : "settles"
    transactions ||--o{ goal_contributions : "contributes"
    transactions ||--o{ installment_lines : "pays"
    transactions ||--o{ transactions : "causes"
    labels ||--o{ transaction_labels : "tags"

    recurring_rules ||--o{ transactions : "generates"
    group_members ||--o{ transactions : "puts in (De quién)"
    transactions ||--o| deferrals : "deferred into instalments"
    accounts ||--o{ deferrals : "its liability leg"
    groups ||--o{ member_debts : "holds"
    group_members ||--o{ member_debts : "owes or is owed"
    app_users ||--o{ recipients : "saves"
    recipients ||--o{ ingest_deliveries : "names the number of"
    transactions ||--o{ transaction_reviews : "reviewed once per rule"
    app_users ||--o{ transaction_reviews : "marks"
    planned_payments ||--o{ reminder_mails : "mailed once per date"

    savings_goals ||--o{ goal_contributions : "collects"

    app_users {
        uuid id PK
        text locale "es | en"
        timestamptz created_at
        timestamptz updated_at
    }

    groups {
        uuid id PK
        text name
        text currency "ISO 4217 shape; default COP"
        text cash_mode "shared | per_member"
        timestamptz created_at
        timestamptz updated_at
    }

    group_members {
        uuid id PK
        uuid group_id FK
        uuid user_id FK "null if they never sign in"
        text name
        text role "leader | member"
        timestamptz archived_at
        timestamptz created_at
        timestamptz updated_at
    }

    accounts {
        uuid id PK
        uuid owner_user_id FK "null = group account"
        uuid group_id FK "null = personal account"
        boolean is_shared "group account any member may write"
        text name
        text kind "asset | liability"
        text subtype "bank | cash | card"
        text institution
        text last_four "nullable; exactly four digits"
        text settlement_currency "ISO 4217 shape; default COP"
        bigint initial_balance_cents "hundredths of settlement_currency"
        date initial_balance_on
        timestamptz archived_at
        timestamptz created_at
        timestamptz updated_at
    }

    debt_terms {
        uuid account_id PK,FK
        text debt_kind "revolving | installment"
        numeric annual_rate "effective annual"
        bigint minimum_payment_cents "fixed amount XOR pct"
        numeric minimum_payment_pct "fraction 0..1"
        bigint credit_limit_cents
        smallint statement_cut_off_day
        smallint payment_due_day
        bigint aval_cents
        timestamptz created_at
        timestamptz updated_at
    }

    installment_plans {
        uuid id PK
        uuid account_id FK
        text description
        bigint principal_cents
        smallint n_installments
        text frequency "monthly | fortnightly"
        numeric interest_rate
        bigint down_payment_cents
        bigint aval_cents
        date start_date
        text merchant
        timestamptz created_at
        timestamptz updated_at
    }

    installment_lines {
        uuid id PK
        uuid plan_id FK
        smallint seq
        date due_date
        bigint amount_cents "aval folded in"
        uuid paid_transaction_id FK "null until paid in full"
        timestamptz created_at
    }

    account_statements {
        uuid id PK
        uuid account_id FK
        date period_start
        date cut_off_date
        date payment_due_date "nullable; an asset owes no payment"
        bigint opening_balance_cents "nullable; as printed"
        bigint closing_balance_cents "signed like the account"
        bigint credits_cents "nullable; as printed"
        bigint debits_cents "nullable; as printed"
        bigint minimum_payment_cents "nullable; as printed"
        bigint interest_charged_cents "nullable; as charged, never estimated"
        bigint fees_charged_cents "nullable; as printed"
        text source "recorded | imported"
        timestamptz closed_at
    }

    account_reconciliations {
        uuid id PK
        uuid account_id FK
        date reconciled_on
        bigint counted_balance_cents "a person's input, signed like the account"
        uuid created_by FK
        timestamptz created_at
    }

    categories {
        uuid id PK
        uuid owner_user_id FK "null = group category"
        uuid group_id FK "null = personal category"
        uuid parent_id FK
        text name
        text kind "expense | income"
        text color
        text seed_key "salary; which seeded category this is, null on one a person made"
        timestamptz created_at
        timestamptz updated_at
    }

    transactions {
        uuid id PK
        uuid owner_user_id FK "null = group movement"
        uuid group_id FK "null = personal movement"
        uuid from_account_id FK "null if income"
        uuid to_account_id FK "null if expense"
        bigint amount_cents "hundredths of currency"
        text currency "ISO 4217 shape; from the accounts when unset"
        bigint counter_amount_cents "null unless an account settles elsewhere"
        boolean counter_is_estimate "true until the statement confirms it"
        text kind "income | expense | transfer (generated)"
        date occurred_at
        text description
        uuid recurring_rule_id FK "null if manual"
        timestamptz reviewed_at "null until a generated movement is reviewed"
        boolean awaiting_counterparty "true until the ingest-unknown side is named"
        boolean amount_from_words "quick entry read the amount from words and the person did not retype it"
        uuid contributed_by_member_id FK "null unless an income into a fund account names who put it in"
        text external_ref "import reference"
        uuid caused_by_transaction_id FK "null unless another movement caused this one"
        uuid reconciliation_id FK "null unless it is a reconciliation's adjustment"
        uuid created_by FK
    }

    transaction_splits {
        uuid id PK
        uuid transaction_id FK
        uuid category_id FK
        bigint amount_cents
    }

    deferrals {
        uuid id PK
        uuid transaction_id FK "unique: one deferral per purchase"
        uuid account_id FK "the purchase's liability leg"
        smallint instalments "2 to 72"
        uuid created_by FK "auth.uid() by default"
        timestamptz created_at
    }

    member_debts {
        uuid id PK
        uuid group_id FK
        text kind "debt or payment"
        uuid debtor_member_id FK "with group_id: a member of this fund"
        uuid creditor_member_id FK "with group_id; not the debtor"
        bigint amount_cents "above zero"
        text currency
        date occurred_on
        text description "optional, 1 to 200"
        uuid created_by FK "auth.uid() by default"
        timestamptz created_at
    }

    recipients {
        uuid id PK
        uuid owner_user_id FK
        text identifier "digits only, 4 to 20, unique per owner; matched by its last digits"
        text name "1 to 80"
        text kind "own_account | person | payee"
        uuid account_id FK "own_account or person; set null on delete"
        uuid category_id FK "payee only; set null on delete"
        timestamptz created_at
        timestamptz updated_at
    }

    transaction_sources {
        uuid id PK
        uuid transaction_id FK
        uuid account_id FK
        uuid statement_id FK "null once the statement is gone"
        text source_ref "the bank's own reference for this leg"
        integer source_seq "line ordinal; null once a real reference exists"
        timestamptz created_at
    }

    labels {
        uuid id PK
        uuid owner_user_id FK "null = group label"
        uuid group_id FK "null = personal label"
        text name
        text color
        timestamptz created_at
        timestamptz updated_at
    }

    transaction_labels {
        uuid transaction_id PK,FK
        uuid label_id PK,FK
    }

    recurring_rules {
        uuid id PK
        uuid owner_user_id FK "null = group rule"
        uuid group_id FK "null = personal rule"
        uuid from_account_id FK "null if income"
        uuid to_account_id FK "null if expense"
        bigint amount_cents
        uuid category_id FK
        text description
        text frequency "monthly | weekly | yearly"
        smallint interval_n "every N periods"
        smallint day_of_month "null for weekly"
        date next_run_on
        date ends_on "null = open-ended"
        boolean is_active
        uuid created_by FK
        timestamptz created_at
        timestamptz updated_at
    }

    audit_log {
        bigint id PK
        text entity
        text record_id
        text action "INSERT | UPDATE | DELETE"
        uuid actor_user_id "null = system"
        uuid owner_user_id "null = group or unscoped"
        uuid group_id "null = personal or unscoped"
        jsonb before_data
        jsonb after_data
        timestamptz occurred_at
    }

    budgets {
        uuid id PK
        uuid owner_user_id FK "null = group budget"
        uuid group_id FK "null = personal budget"
        uuid category_id FK
        uuid account_id FK "null = any account"
        uuid label_id FK "null = any label"
        text period "monthly | weekly | yearly"
        bigint limit_cents
        smallint threshold_pct "overspend alert, 1..100"
        text name
        timestamptz archived_at
        timestamptz created_at
        timestamptz updated_at
    }

    planned_payments {
        uuid id PK
        uuid owner_user_id FK "null = group payment"
        uuid group_id FK "null = personal payment"
        uuid from_account_id FK "null if income"
        uuid to_account_id FK "null if expense"
        bigint amount_cents
        uuid category_id FK
        date due_date
        date remind_on "null = no reminder"
        text description
        text status "pending | done | cancelled"
        uuid settled_transaction_id FK "null until settled"
        uuid created_by FK
        timestamptz created_at
        timestamptz updated_at
    }

    savings_goals {
        uuid id PK
        uuid owner_user_id FK "null = group goal"
        uuid group_id FK "null = personal goal"
        text name
        bigint target_amount_cents
        date target_date "null = no deadline"
        uuid account_id FK "display only"
        timestamptz archived_at
        timestamptz created_at
        timestamptz updated_at
    }

    goal_contributions {
        uuid id PK
        uuid goal_id FK
        uuid transaction_id FK
        bigint amount_cents
    }

    webhook_credentials {
        uuid id PK
        uuid owner_user_id FK
        text name
        text token_hash "sha-256 hex, stored never shown"
        uuid default_account_id FK "null = payload must name it"
        uuid default_category_id FK "null = payload must name it"
        text purpose "ingest | mcp; what the key opens, fixed when minted"
        integer rate_limit_per_min "default 60"
        timestamptz rate_window_started_at "resolver-managed"
        integer rate_count "resolver-managed"
        timestamptz last_used_at
        timestamptz revoked_at
        timestamptz created_at
        timestamptz updated_at
    }

    oauth_clients {
        uuid id PK
        text client_name "1 to 80 characters"
        text_array redirect_uris "1 to 5, each https or loopback"
        timestamptz created_at
        timestamptz last_active_at "moved when a code is issued; idle for 30 days, it is swept"
    }

    oauth_codes {
        uuid id PK
        uuid owner_user_id FK "who said yes"
        uuid client_id FK
        text code_hash "sha-256 hex, stored never shown"
        text code_challenge "PKCE S256"
        text redirect_uri
        timestamptz expires_at "ten minutes"
        timestamptz used_at "a second redemption revokes credential_id"
        uuid credential_id FK "the mcp key the code bought"
        timestamptz created_at
    }

    oauth_calls {
        text bucket PK "register"
        text source PK "sha-256 of the caller address"
        timestamptz window_start PK
        integer calls "ten registrations an hour per caller"
    }

    ingest_deliveries {
        uuid id PK
        uuid owner_user_id FK "credential owner"
        uuid credential_id FK
        text external_ref "unique per owner"
        text raw_text "message as received"
        text shape_hash "masked-message sha-256"
        text merchant_key
        text merchant_label
        text status "pending | accepted | rejected"
        boolean silenced_on_arrival "the shape memory resolved it, never a person"
        uuid transaction_id FK "null until accepted"
        bigint proposed_amount_cents
        uuid proposed_account_id FK
        uuid proposed_category_id FK
        text category_source "merchant | interpreter | credential_default | recipient"
        text proposed_direction "income | expense | transfer"
        uuid proposed_to_account_id FK "a transfer's destination; proposed_account_id is then its source"
        text extracted_identifier "the number the message names, digits"
        uuid recipient_id FK "the saved recipient it matched uniquely; set null on delete"
        date proposed_occurred_at
        text proposed_description
        timestamptz resolved_at "null while pending"
        timestamptz created_at
        timestamptz updated_at
    }

    ingest_shapes {
        uuid id PK
        uuid owner_user_id FK
        text shape_hash "unique per owner"
        text decision "approved | rejected"
        text sample_text
        timestamptz created_at
        timestamptz updated_at
    }

    ingest_merchants {
        uuid id PK
        uuid owner_user_id FK
        text merchant_key "unique per owner"
        text merchant_label
        text state "learning | trusted | ambiguous"
        uuid candidate_category_id FK
        smallint streak "0..2"
        uuid trusted_category_id FK "only while trusted"
        timestamptz created_at
        timestamptz updated_at
    }

    ingest_counterparties {
        uuid id PK
        uuid owner_user_id FK
        text pattern_key "unique per owner and side"
        text pattern_label
        text side "from | to"
        text state "learning | trusted | ambiguous"
        uuid candidate_account_id FK
        smallint streak "0..2"
        uuid trusted_account_id FK "only while trusted"
        timestamptz created_at
        timestamptz updated_at
    }

    transaction_reviews {
        uuid id PK
        uuid transaction_id FK
        text rule "the «Revisar el mes» rule it answers; one per movement and rule"
        uuid marked_by FK "set from the session, never sent"
        timestamptz marked_at
    }

    allowed_emails {
        text email PK "lowercased and trimmed; who may ask for a sign-in link"
        timestamptz added_at
    }

    sign_in_claims {
        text client_key PK
        date day PK "Bogotá day"
        integer count "sign-in links sent, 1..1000"
    }

    reminder_mails {
        uuid id PK
        uuid planned_payment_id FK
        date remind_on "the reminder date it was mailed for; unique with the payment"
        timestamptz mailed_at
    }
```

### Invariants

Rules the model must always guarantee, regardless of how they are implemented:

- An account belongs to exactly one of a user or a group (XOR): a personal
  account names its `owner_user_id`, a group account names its `group_id`. Never
  both, never neither.
- A group account may be `is_shared` so any member can write it. A personal
  account is written only by its owner and is never `is_shared`.
- Read is universal inside a group: every member sees every group account and
  every member's personal account. Write is bounded to own-or-shared: the owner
  writes their own account, any member writes one marked shared.
- A member is a person, with or without a login. Only a member with a user can
  be `leader`. A member with a user belongs to at most one group.
- A debt is a liability account, not a separate entity. Its balance comes from
  the same calculation as a savings account's.
- A balance is never stored: it derives from the opening balance plus movements.
- A movement is never dated before the opening day of an account it names, and an
  account's opening day never moves past one of its movements. The database refuses both.
- An account's opening balance is signed the way the account is worth: an asset's is zero or
  positive, a liability's is zero or negative. The sign comes from `kind`, never from the
  user.
- Null `from` and `to` define the type: destination only is income, source only
  is expense, both is a transfer. Never both null.
- The amount is always positive; direction supplies the sign.
- A transaction's scope (`owner_user_id` XOR `group_id`) is derived from the
  accounts it touches, never chosen by the user.
- Every income or expense has at least one split, whose amounts sum to the
  transaction's amount and whose category shares the transaction's scope and
  kind, except a reconciliation's adjustment. A transfer and an adjustment have
  no splits and no category.
- A movement may name the movement that caused it; deleting the cause deletes
  the charge, and a movement is never its own cause.
- A category belongs to exactly one of a user or a group (XOR), mirroring an
  account's owner: a personal category names its `owner_user_id`, a group
  category names its `group_id`. Never both, never neither.
- A label is scoped like a category (user XOR group), and a transaction's labels
  share the transaction's scope.
- A budget, a planned payment and a savings goal each belong to exactly one of a
  user or a group (XOR): never both, never neither.
- A budget limits an expense category that shares its scope. Its spent and
  remaining derive from the splits in its current period window that match its
  category and any account or label narrowing; they are never stored.
- A planned payment's scope derives from the accounts it touches, never chosen by
  the user. A settled planned payment links the transaction it recorded and is
  never re-settled while that transaction exists; deleting the transaction
  returns the payment to pending, unlinked. A cancelled one is never settled.
- A recurring rule belongs to exactly one of a user or a group (XOR), derived
  from the accounts it touches, never chosen by the user — mirroring transactions.
- A recurring rule names exactly one account and exactly one category and is
  always an income or an expense, never a transfer.
- A savings goal's progress derives from its contributions and is never stored.
- A goal contribution shares its goal's scope with its transaction, and counts a
  movement toward a goal at most once.
- A debt's terms belong to a liability account and carry no scope of their own:
  the account's scope gates them.
- A debt's minimum payment is a fixed amount XOR a percentage of the balance,
  never both.
- A debt's monthly-interest estimate derives from its balance and effective
  annual rate and is never stored; actual interest enters as a real movement.
- An installment plan schedules an existing liability balance into dated lines
  and never adds to total owed.
- A payment into a debt account allocates to its unpaid installment lines
  oldest-first; a line is paid in full or not at all, and the paying movement is
  linked. A partial remainder is left unallocated.
- A plan's pending derives from its unpaid lines and is never stored.
- An account statement is an immutable snapshot captured at its cut-off: the one
  persisted balance figure, never kept in sync with later movements. Every
  printed figure but the closing balance is optional, and an absent one is not a
  zero. The difference between a statement's printed closing balance and the
  balance derived from movements, in the account's own settlement currency, is
  computed on read and never stored.
- A movement carries at most one source reference per account leg; a
  statement's rows are replaced as a unit.
- A reconciliation is immutable; its adjustment is the one movement marked with
  it, one-legged, in the settlement currency, with no split, and counts in no
  income or expense total and no budget.
- The counted figure is a person's input; the derived balance is never stored.
- A group's `cash_mode` is `shared` (a single group cash account) or
  `per_member` (one cash account per member).
- Money is an integer number of cents.
- The audit log cannot be bypassed from any write path.
- The audit log is append-only: no write path bypasses capture, and only the
  RNF-14 purge ever removes rows.
- `external_ref` is unique within a scope (a user's personal movements or a
  group's movements).
- `app_users` hangs off no fund: the language preference belongs to the
  user and holds wherever they sign in (RF-47).
- A webhook credential belongs to exactly one user; only a hash of its bearer
  token is stored, never the token; an ingest through it writes under that user's
  scope, so RLS and audit apply as if the user recorded the movement; a
  per-credential fixed-window rate limit bounds its request rate.
- A delivery belongs to exactly one user, the one its credential resolved to,
  and never to a group.
- A delivery becomes a movement only through a person's acceptance; nothing
  writes one from a delivery on its own.
- A delivery's `external_ref` is unique within its owner, so a re-delivery of a
  stored reference writes nothing whatever its status.
- A delivery the shape memory discarded on arrival is marked as such and is the
  only kind a restore returns to the queue; a delivery a person discarded is
  never returned.
- A merchant's remembered category is earned by two consecutive agreeing
  approvals and lost for good on the first disagreement; only an explicit
  forget clears it.
- A counterparty's remembered account and side are earned by two consecutive
  agreeing completions and lost for good on the first disagreement; only an
  explicit forget clears it.
- A movement recorded with only the side an ingest could read is marked
  awaiting its counterparty; naming the other account clears the mark.

---

## 3. Architecture

A Next.js application deployed on Vercel over Supabase (Postgres and
authentication), both on free plans.

Principles, not recipes:

- **The server is the only door to the data.** The client holds no database
  credentials and issues no queries. Pages render on the server and writes go
  through server actions.
- **Authorisation lives in the database.** The server being the only door is not
  enough: access policies are evaluated in Postgres against the real user, so
  that an application bug cannot expose another fund's data.
- **Scheduled work runs inside the database**, not as an external task. Applying
  recurring rules (RF-30) and purging the log (RNF-14) are transactional
  operations and must not depend on an outside service answering; both stay in
  the database. The single exception is the keepalive that holds inactivity off
  (RNF-12): a job inside the database cannot revive a project that is already
  paused, so that one call has to arrive from outside.
- **Auditing is captured in the data layer**, not the application layer. It is
  the only way RF-45 holds.
- **Cost is a design constraint, not an outcome.** Any component that could
  generate a charge is discarded before it is judged on other merits.

---

## 4. Stack

| Need | Choice | What it saves |
|---|---|---|
| ORM and migrations | **Drizzle** (`drizzle-orm ^0.45.2`) | Schema, access policies and types declared once in TypeScript. |
| Auth | **Supabase Auth** | Passwordless login, email delivery, sessions, and the identity the access policies read. |
| Components | **Radix Themes** (`@radix-ui/themes ^3.3.0`) | Layout, typography, controls and theming as components with props, one stylesheet, no build step. |
| Validation | **Zod** (`^4.4.3`) | One schema serves the form, the server and the types. |
| Server actions | **next-safe-action** (`^8.6.1`) | Validation, typed errors and loading state on every mutation. |
| Forms | **React Hook Form** (`^7.86.0`), with **@hookform/resolvers** (`^5.9.1`) | State, errors and submission wired to the validation schema; the resolver binds Zod to React Hook Form. |
| Table | **TanStack Table** (`@tanstack/react-table ^9.2.4`) | Sorting, filtering, pagination and selection for the transaction list. |
| Charts | **Recharts** (`~3.10.0`) | Declarative React charts with full React 19 and App Router SSR support. |
| Toasts | **sonner** (`^2.0.8`) | Notifications; Radix Themes ships no toast. |
| Icons | **lucide-react** (`^1.34.0`) | An icon set, chosen independently of the component library. |
| Environment | **@t3-oss/env-nextjs** (`^0.13.11`) | Fails at build time on a missing variable, not in production. |
| Language | **next-intl** (`^4.13.7`) | Locale routing, server-side translations, date and number formatting. |
| Spreadsheets (phase 2) | **ExcelJS** (`exceljs ^4.4.0`) | Reading and writing `.xlsx` with valid options in the template. |
| Framework | **Next 16.4.1** and **React 19.2.8** (`next`, `react`, `react-dom`, pinned) | Routing, server actions and rendering; the versions the three apps share. |
| Mail | **Nodemailer** (`nodemailer ^7.0.13`) | RF-141's reminder through the Gmail account Auth already sends from. |
| AI door | **mcp-handler 2** (`^2.2.0`) over **@modelcontextprotocol/server 2** (`^2.3.1`) | RF-144's `/mcp`, at GoalLog's versions: the Streamable HTTP transport and the 401 without a JSON-RPC server written here. |
| Postgres client | **postgres** (`^3.4.9`) | The driver Drizzle runs on, over the Supabase pooler. |
| Supabase clients | **@supabase/supabase-js** (`^2.112.4`) and **@supabase/ssr** (`^0.12.5`) | The cookie session and the one-time-code check against Auth; `supabase-js` also gives the retryable-error test sign-in uses. |
| Shared auth | **@repo/supabase-auth** (workspace `*`) | The cookie session and claim verification the apps share, already written and proved. |
| Spreadsheet guard | **@repo/zip-guard** (workspace `*`) | Refuses a zip bomb before ExcelJS inflates an import. |
| Harness registry | **@repo/harness-registry** (workspace `*`, dev) | Records every identity and run a suite creates, so a purge names only its own rows. |
| Types and lint | **TypeScript** (`^5`), **@typescript/native-preview** (`^7.0.0-dev.20260707.2`), **eslint** (`^9`), **eslint-config-next** (`16.4.1`), **@types/node**, **@types/react**, **@types/react-dom** (dev) | `tsgo` checks the project in seconds; the lint rules are the framework's own. |
| Migrations | **drizzle-kit** (`^0.31.10`, dev) | The schema versioned in the repository, with a journal of its own. |
| Script runner | **tsx** (`^4.23.12`, dev) | Runs the TypeScript checks and harness scripts under `node --import tsx`. |
| Browser verification | **Playwright** (`@playwright/test ^1.62.1`, dev) | Drives a real browser for the interface facts no server-side check reaches: clicks, dialogs, the mobile sheet, tap-target size and the narrow viewport. |
| Local database and Auth for the suites | **Supabase CLI `2.119.0`** | The same Postgres image and GoTrue the project runs, on each machine and each CI runner, so no suite shares the remote. |

Playwright is a development dependency: it never reaches the bundle, ships in no deployment and costs nothing to run, so RNF-01 and RNF-02 hold.

The Supabase CLI is invoked as `npx --yes supabase@2.119.0` from `scripts/supabase-local.sh` alone. It is in no `package.json`, never reaches a bundle or a deployment, needs Docker and costs nothing to run, so RNF-01 and RNF-02 hold.

StrykerJS (`@stryker-mutator/core`, `@stryker-mutator/tap-runner`) is a development dependency of `apps/goallog` alone. Decided by the user 2026-10-14: it mutates the pure `lib/` files a train changed (`npm run mutate:pure`), through the command-style `tap` runner because the repo tests with `node --test`. It never reaches a bundle or a deployment and costs nothing to run, so RNF-01 and RNF-02 hold.

### Do not install

| Library | Use instead |
|---|---|
| Prisma | Drizzle: no binary engine, better cold starts. |
| NextAuth / Auth.js | Supabase Auth: it is where the identity the policies evaluate comes from. |
| rrule | `lib/dates.ts` arithmetic covers monthly, weekly and yearly. |
| Dinero.js | Native browser formatting and integer arithmetic. |
| tRPC | Server actions are already type-safe. |
| Zustand / Redux | State lives on the server. |
| SheetJS `xlsx` | ExcelJS: the npm package has gone years without an update and carries unpatched vulnerabilities. |
| next-i18next | next-intl: the former is tied to the Pages Router. |
| An auditing library | A database trigger. |
| shadcn/ui, Tailwind | Radix Themes. |
