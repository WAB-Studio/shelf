# Goal log — specification

> **For the implementing agent:** section 1 is the contract and section 4 fixes
> the stack. If something is not in section 1, it does not get built. This
> document makes no implementation decisions: how each requirement is satisfied
> is decided at implementation time, as long as the non-functional requirements
> hold.

> The app's name is `pulsar` throughout. It is the user's to change; nothing but
> a directory name and this word depends on it.

---

## 1. Specification

### Context

A person keeps goals that are won over weeks and lost in single days. The plan
says what counts and how often. Only the day says what actually happened.

Every tool for this asks the person to do the thing and then to say they did it.
The day saying it costs more than doing it, they stop saying it; a week later
they stop doing it. So the app's first duty is to cost nothing: what another app
already knows is never asked for again.

The central unit is the **fact**: something that happened, at a moment, from a
source. A fact is **declared** — the person says so, in one tap — or **derived**
— another app already recorded it and this one reads it where it lies.

Nothing is ever stored as done. What today asks for, what it got and what it is
still missing are derived from the facts against the goal's commitments, the way
`apps/orbit` derives a balance from movements and never holds one in a column.

Interface language: Spanish. A person reads only their own log.

### Scope

A generic engine from the first slice: a person defines any goal, with any
cadence, and satisfies it by tapping or by evidence another app leaves. Taken by
the user 2026-09-22 over a version written for one plan alone.

The engine holds a plan of three phases and a plain errand with the same four nouns; a model that
needs a second shape for «call the bank» is not generic, it is one plan with a hobby.

`plan-ingles-dev.md` is the goal the engine must hold whole — a fixed daily
block of four commitments, a different commitment per weekday, three phases and
a measure reviewed every four weeks. A model that cannot express that plan is
not generic.

**Out of scope:** reminders and notifications, streaks and scores, sharing a goal
with another person, offline use, and any write into another app's tables. None
of this gets built, and no schema, table or column is "prepared for" it.

### Functional requirements

#### The day

- [x] **RP-01** — The app opens on today: what today asks for, what is already satisfied, and what is not. No tap, no choice, no screen before it.
- [x] **RP-02** — A commitment is satisfied in one tap. No form, no field, no confirmation.
- [x] **RP-03** — A commitment that measures something takes its number in the same gesture, offered with the number the plan expects, and is satisfied by accepting it. **The number carries its unit** — minutes, pages, kilometres, repetitions, cards — named once on the commitment and never typed again.
  - Widened 2026-09-22, the day it was written, when the user asked whether the app served anything beyond one plan. A quantity with no unit cannot be summed into a goal's measure and cannot be drawn. The code was unticked and nothing had been verified against it, so no tick is invalidated.
- [x] **RP-04** — A fact can carry one line the person writes — the two mistakes from today's monologue, what the conversation cost. It is offered, never required, and the day shows it.
- [x] **RP-05** — A declared fact can be undone. A derived one cannot: it belongs to the app that recorded it.
- [x] **RP-06** — A fact can be written for a day already past. It keeps the day it happened and the moment it was written, and the two are never shown as one.
  - Widened 2026-09-28, unticked, by the user's decisions after the critic: a past day lists only what existed that day, and its oldest reachable day (seven back) says why there is no step further.

#### The evidence another app leaves

- [x] **RP-07** — A commitment can be satisfied by evidence another app already records, with no act from the person. **A source is declared, never built in**: it names where the rows live, what one row means and what the person sees it called. The reading app's searches are the first one; the app names no source in its schema, its screens or its types.
  - Widened 2026-09-22, same day and same question. Written as "the reading app's searches", a second source — a movement in `apps/orbit`, a commit, an import — cost a migration instead of a reader.
- [x] **RP-08** — A commitment satisfied by evidence says **how much** of it satisfies the day, in the source's own unit, and the person sets it. **The reading app's source is offered at one search**: opening the dictionary and looking something up is reading. Taken by the user 2026-09-22, over ten and over forty, on the ground that the copy does not yet start on its own (RL-30) and a high threshold would make a working feature read as a broken one. A source that only ever happens once satisfies at one and offers no choice.
- [x] **RP-09** — Evidence names its source wherever it is drawn. A day marked by the reading app never reads as a day the person said they did.
- [x] **RP-10** — Evidence is read where it already lives and is never copied into this app. Emptying the record in the reading app empties the evidence here too: there is one truth and it has one home. Decided by the user 2026-09-22.

#### The goal and its plan

- [x] **RP-11** — A person creates a goal with a name and a horizon, and the app holds more than one at a time.
- [x] **RP-12** — A goal holds commitments. A commitment names what counts and how often: every day, named weekdays, a number of times a week, every N days, or a number of times a month.
  - Widened 2026-09-22 from the three cadences one plan needed. A habit measured by the month — a haircut, a deep clean, a call home — had nowhere to live.
  - Bounded 2026-09-28 by the user: at most 7 times a week, every 365 days at most, 31 times a month; the message says so, and a commitment already stored outside the bounds still reads.
  - **«Every N days» counts from the day the commitment was created.** Decided by the user
    2026-09-22, when module 8 found the engine asking for an anchor the table does not hold. The
    anchor is `commitments.created_at`, read as a civil day: no column, no field on any screen, and
    nothing for a person to get wrong. The price they took knowingly — a commitment typed on a
    Tuesday night is anchored to that Tuesday for good, and `commitments` accepts UPDATE on
    `retired_at` alone, so the only correction is to retire it and open another.
- [x] **RP-13** — A commitment is retired, never deleted. The facts it explains stay explained and the weeks it governed keep reading as they did.
- [x] **RP-14** — A goal names **one** measure that predicts its progress — minutes spoken, pages read — and every fact that carries a quantity **in that measure's unit** feeds it. A quantity in any other unit satisfies its commitment and is not summed: a goal measured in minutes is not advanced by forty searches.
  - Settled 2026-09-22, when the engine asked whether evidence feeds the measure. It does, when it shares the unit, and by the same rule as any other quantity — the measure never knows which app a quantity came from. Written before any screen read it, so no tick is invalidated.
  - **Decided by the user 2026-09-22: sum it by reading the source, never draw a permanent zero.** RP-05
    says evidence never writes a fact — deliberately — so a goal whose only *measuring* commitment is
    evidence-satisfied has nothing in `goals.facts` for its unit to ever match, and summing facts alone
    reads `0` today, tomorrow and forever, indistinguishable from a goal nobody touched no matter how
    much the person really did. The two cheaper answers — draw no figure at all for such a goal, or
    keep the `0` and write it into this spec — were offered and declined. `loadGoal` opens a second,
    concurrent transaction (RNP-03's own fan, the shape `loadDay`/`loadWeek` already use) that reads the
    evidence source directly for every evidence-satisfied commitment whose own unit matches the goal's,
    over the goal's own span, and adds that count to the declared sum. RNP-04 still governs it: a source
    that cannot be read that moment degrades to the declared total alone, never a blank goal.
- [x] **RP-15** — A goal holds phases: a span of weeks with its own single aim. The day says which phase it is in.

#### The thing that happens once

- [x] **RP-19** — A person writes down something that happens **once** — call the bank, renew the passport, finish chapter three — with no cadence, no goal and no plan behind it. It takes a day when it has one and sits in the day's list beside the commitments; done, it leaves the list and stays in the log as the fact it produced. Left undone, it carries to every day after its own, showing the day it belonged to, until it is done or deleted. Asked for by the user 2026-09-22: a log of goals that cannot hold a plain errand is not the app they asked for. The carry was added by the user 2026-09-28.
  - Widened 2026-09-28, unticked, by the user: done, it stays on the day it was done in a list of what was done, and a second tap undoes it; it is written with a day, today by default, or with none.
- [x] **RP-20** — A one-off can belong to a goal or to nothing at all. Belonging to one, it counts toward that goal's week; belonging to nothing, it is still a fact with a day, and the week still shows it.
- [x] **RP-22** — A one-off written by mistake can be deleted, and nothing survives it: it never happened, so there is no fact to keep. The act says, where it is offered, how it differs from marking the thing done — done leaves a record, deleted leaves nothing. Asked for by the user 2026-09-22, after the grant layer was measured refusing it: «llamar al banko» with a typo is a first-week problem and today it stays forever.
- [x] **RP-23** — A goal can be renamed. Its facts, weeks and commitments keep reading as they did. Asked for by the user 2026-09-27.
- [x] **RP-24** — A goal can be archived. It leaves the day and the week; its facts and the weeks it governed stay, and it can be opened again from the goals list. Nothing is deleted. Asked for by the user 2026-09-27.
- [x] **RP-25** — A goal's horizon can be moved from the goal. Its facts, weeks and phases keep reading as they did, and a horizon never ends before a phase does. Asked for by the user 2026-09-28, to keep «Se puede mover después» true.
- [x] **RP-47** — Goals, a goal's commitments and its tasks keep the order of the plan they came from: an import writes them in the order the plan gives, and that order is kept wherever they are listed — every screen, the export and a connected AI. A goal, a commitment or a task created later, by hand or by a connected AI, goes after every one the person already has. On Hoy alone, the goals that ask something that day come first, in that order, then the rest. Decided by the user 2026-10-05.
- [x] **RP-50** — A goal that has a measure carries a **rhythm**: how much of its measure it takes per calendar month, in its unit — twelve hours a month. A month with its own planned amount (RP-28) takes that amount instead. The goal's month tasks are **one ordered list**, and the app gives each task not fixed to a month (RP-51) its month by filling each month's rhythm in order, from the current month on. A task with no estimate takes no room. A goal with tasks and no rhythm gives them no month and says so, offering to set one. A goal's first rhythm returns its pending fixed tasks to the plan, after saying how many will move. Decided by the user 2026-10-06 (`RoadmapPlan.dc.html`, `RoadmapSinRitmo.dc.html`).
- [x] **RP-51** — The person can **fix** a task not yet done to a month of its goal's span that has not ended, with its sub-tasks; a fixed task keeps its month whatever the plan does, and the rest of the list fills around it. Fixing is undone the same way, and the task goes back to the plan. The AI can fix and unfix a task too. Decided by the user 2026-10-06 (`RoadmapFijar.dc.html`), succeeding RP-42.
- [x] **RP-52** — **The plan moves by itself.** Whenever what fills a month changes — a month that closed with less done than its rhythm, a task added, removed, done or re-estimated, a rhythm or a month's amount changed — every month from the current one on is filled again by RP-50. Nothing asks to be accepted. When a closed month's shortfall moves the projected end (RP-53), Hoy says once, until dismissed, how far the plan moved, why, and where it now ends. What a closed month did is the sum of the estimates of the tasks done in it. Decided by the user 2026-10-06 (`RoadmapHoyMovido.dc.html`), succeeding RP-48.
- [x] **RP-53** — The goal's plan says when it ends at its rhythm: the day the last task's hours are filled, set against the goal's end (its horizon). When it passes the end, it says by how much and offers to raise the rhythm — naming the rhythm that would meet the end — or to move the end to the plan's; the tasks past the end are listed apart. Decided by the user 2026-10-06 (`RoadmapPasaElFinal.dc.html`).
- [x] **RP-54** — A task whose estimate does not fit in what is left of a month starts in that month with the hours that fit and goes on in the next, read «empieza aquí con N y sigue en <mes>» and «viene de <mes>». Its hours count in each month for the part that falls there; it is still one task, done once. Decided by the user 2026-10-06 (`RoadmapPlan.dc.html`).
- [x] **RP-55** — Tapping a task's name opens its sheet: its name, its estimate and its month (RP-51), with «Borrar la tarea» at the sheet's foot, offered only when RP-22 allows it. A done task's name can be changed and nothing else. Tapping the name never deletes. Decided by the user 2026-10-06 (`RoadmapFijar.dc.html`).
- [x] **RP-56** — An AI connected to a person's log writes through the app's own acts and nothing else. It annotates: marks a commitment or a task done, logs a quantity, writes a one-off, a month task or a sub-task. It reorganizes: fixes a task not yet done to a month and returns a fixed task to the plan (RP-51), gives a one-off a day, renames a goal, moves a goal's last day, sets an open month's amount, adds a phase or a commitment, retires a commitment to change it (RP-12). It creates a goal. It never changes a goal's rhythm (RP-50). **It never deletes, never archives, never undoes a mark, never removes a month's amount and never reopens an archived goal.** What the app refuses the person, it refuses the AI, with the same reason in Spanish. Decided by the user 2026-10-06, succeeding RP-40.
- [x] **RP-58** — The report's current week says what was done against what was planned for it: the month's planned amount spread evenly over the month's days, summed over the week's days that fall inside the goal (a week across two months takes each part from its own month), in whole minutes. A week with no planned amount says what was done alone. No score, no colour (RP-16). Decided by the user 2026-10-06.
- [x] **RP-59** — A one-off that belongs to no goal and has no day is not lost. It waits in a list of its own, off the day's screen, and is given a day whenever the person wants one. A one-off written for a later day waits in the same list, with its date, and can be moved, done or deleted there. A goal's task with no day waits in its goal's plan (RP-50), never in that list. Decided by the user 2026-10-06, succeeding RP-21.
- [x] **RP-60** — claude.ai, on the web and on the phone, connects to a person's log through an authorization the person grants on a screen of the app that names the assistant **and the address it returns to — its host, with its port when it has one, never its path —** and says what it may do and what it never does. The app is its own authorization server, and an assistant is recognised by registering itself or by the address of its own metadata. The authorization is listed beside the keys and revoked the same way. Decided by the user 2026-10-05; the address added 2026-10-08, succeeding RP-41.
- [x] **RP-61** — Tapping the name of a one-off that belongs to no goal opens the same sheet as RP-55, with its name alone: the person renames it, done or not, and «Borrar la tarea» sits at its foot only when RP-22 allows it. On Hoy, the sheet of a one-off not yet done also offers «Darle otro día»: the step «lo que espera» offers (RP-59), from the day it has — today or one it was carried from — to any day from today on. Decided by the user 2026-10-08, succeeding RP-57.
- [x] **RP-62** — A goal measured in a unit other than time (RP-35) carries no rhythm and no plan (RP-50–RP-54): «El plan» is not offered to it, and the act that sets a rhythm refuses one. A goal measured in time, or with no measure, keeps its plan (user, 2026-10-09). A goal measured in any other unit keeps its month amounts (RP-28) and its month lists (RP-31): each of its tasks is fixed, when written, to the month it is written for — the current month when none is named. Narrows RP-50, which stands. Decided by the user 2026-10-08.
- [x] **RP-27** — A goal past its end says the day it ended and is listed apart among the goals. Its commitments leave the day. Through the Sunday of the week it ended in, the day and the week still name it with the day it ended and a way to open it; after that it leaves both. It can be archived or have its end moved. Nothing is deleted. Decided by the user 2026-09-30, succeeding RP-26.
- [x] **RP-45** — A task — a month task, a sub-task or a one-off — holds an optional note the person writes and changes at any time, done or not: plain text of at most 2000 characters, line breaks kept, no formatting, never stored empty (emptied, it has none). The month's lists and «lo que espera» (`/sueltas`) show it; Hoy shows only that one exists and opens it. The template carries it as `nota:` lines (`docs/pulsar/PLANTILLA.md`) and an import writes it; the model import proposes none. A connected AI reads it, writes it and replaces it (RP-56), and never empties it. The PDF prints it under every task it lists (decided by the user 2026-10-05, once the report lists this month's tasks). It is not the line a fact carries (RP-04). Decided by the user 2026-10-05.

#### The plan by month

- [x] **RP-28** — A goal that has a measure can carry a planned amount for any calendar month of its span, in its measure's unit — twelve hours of «IA aplicada» in October. It is set, changed and removed from the goal. The goal and Hoy say how much of this month's amount the measure has reached: «llevas X de Y». The amount is the plan's; what was reached is derived from the facts, the evidence and the tasks done (RP-36), never stored. A month with no amount says nothing, and a goal with no measure takes no amount. Asked for by the user 2026-09-30.
- [x] **RP-29** — From the 20th of a month, a goal whose reached amount is under 60 % of that month's planned amount says so, on Hoy and on the goal, in figures: what was reached, what was planned, the day. It never says it before the 20th, never for a month with no amount or an amount of zero, and never as a score, a reproach or a colour of alarm (RP-16). Asked for by the user 2026-09-30, from the roadmap's own rule.
- [x] **RP-68** *(successor of RP-30)* — A one-off that belongs to a goal measured in time (RP-35) can carry an estimated amount in that measure's unit, and a one-off planned for a month can hold one-offs of its own, one level deep. One that holds others has no amount and no day of its own: its amount is the sum of theirs, and it is done when every one of them is done. Asked for by the user 2026-09-30.
- [x] **RP-31** — A one-off that belongs to a goal can be planned for a month instead of a day. The goal shows each month's list. Left undone when its month ends, it opens the next month's list, first, showing the month it came from and the amount it still owes, until it is done or deleted. Nothing is written when a month turns: the carry is read. Asked for by the user 2026-09-30, from the roadmap's «regla de arrastre».
- [x] **RP-32** — A goal is read month by month, from its first month to its last: the amount planned, the amount reached, and, for a month already over, the share carried out of it — the amount its list still owed when it ended over the amount its list held when it began. Asked for by the user 2026-09-30.
- [ ] **RP-71** *(successor of RP-70)* — A person exports how every goal is going **as a PDF**: a read-only page of the report, and «Descargar PDF», which hands that page to the browser's own print-to-PDF — on a phone, the share or print menu. It says how many goals it holds and how many of them have ended. For each goal not archived: its measure against this month's planned amount and against the planned amount to date, its phases, **this month's tasks** — those carried in first, with the month they came from and what they owe, then the month's own — **done and not**, each with its estimate and its sub-tasks, and its months (RP-32): on paper, a month not yet begun with no planned amount does not print, a line under the goal's months names the ones left out («noviembre y diciembre: sin monto») and says nothing when none is, and the count of months counts the printed ones; on screen and to a connected AI every month stays; **on screen each month holds its weeks, folded under it; on paper only the months print** (RP-17). Every date it prints carries its year. On paper a goal's measure names both its name and its unit («mide Práctica, en horas y minutos»). The export writes nothing, installs nothing and generates nothing on the server; a source that cannot be read is said so in it (RNP-04). Decided by the user 2026-10-10, succeeding RP-70, on the board `ReporteImpresoMesesFuera`.
- [x] **RP-35** — A quantity in a unit of time reads in hours and minutes wherever it is drawn — «12 h 30 min», «45 min», «2 h» — on Hoy, in the quantity sheet, on the goal, in the review, the months, a month's list, the export and the import's review. The app knows a unit of time from a short catalogue of the words for a minute (minutos, minuto, min, mins, in any case); a unit named any other way reads as it does today. What is stored stays whole minutes. A field that asks for a new amount of time — a month's amount, a task's estimate — takes hours and minutes; the commitment's target and the quantity sheet's own field keep taking minutes. Decided by the user 2026-09-30.
- [x] **RP-66** — A measure written in hours — horas, hora or h, in any case — is stored as minutes, and the amounts written with it are multiplied by sixty: a goal whose first quantity commitment is «2 horas» measures in minutos with a target of 120, and a template or a model import whose measure is in hours writes minutes. Nothing stored changes. RP-35 stands: what is stored in minutes reads in hours and minutes. Decided by the user 2026-10-09.
- [x] **RP-65** *(successor of RP-36)* — A one-off with an estimated amount (RP-30) in a goal measured in time (RP-35), once done, adds that amount to its goal's measure on the day it was done — to the total, the week, the month and the export — and undone, takes it back. A one-off that holds others adds nothing of its own; each of them adds its own. In a goal measured in any other unit a task carries no figure: its sheet and the month's form ask none, the acts refuse one, an import drops one and says so, and Hoy says nothing in its place; a figure already stored adds nothing. **The same hours can count twice:** a task done inside a day's block also counts in that block's quantity (RP-03), and the app does not tell the two apart. Decided by the user 2026-10-09, succeeding RP-36.

#### The month across goals

- [x] **RP-43** — «Mes» reads this month across every open goal: for each, the amount planned and reached (RP-28), and its
  month's list — the tasks carried in first, with the month they came from and what they owe (RP-31), then the month's
  own — where a task is marked done in one tap. A goal that measures nothing shows its tasks with no amount. Reading it
  writes nothing. Decided by the user 2026-10-05.

#### Bringing a plan in

- [x] **RP-37** — A person brings a plan in by pasting its text or uploading a file — Markdown, text (CSV and JSON included), PDF or an image; any other kind is refused, and the screen says so. A plan written in the app's documented template is read with no model call. Anything else is sent to OpenAI, and the screen says so, in one line, before it is sent: the plan leaves for OpenAI. The model proposes goals, their phases, their month amounts, their commitments and their tasks with estimates and sub-tasks. **Nothing is written from the model's answer alone:** the person reviews the proposal, unmarks what they do not want, can change an amount, and confirms; what cannot be written — a month outside the goal's span — says why and is left out. An import creates new goals and never changes an existing one. Decided by the user 2026-09-30: «si se sube algo random también debería poder».
- [x] **RP-72** — A plan in the template with mistakes is answered in one reading: every line that cannot be read is listed at once, in the text's order, each with its number, its text and what it should say, under a line that counts them («3 líneas por corregir»). A goal measured in a unit other than time accepts that unit written on every line that carries its amount — a month and a commitment («8 km») — and a line written in another unit names the unit that goes. Decided by the user 2026-10-10, on the board `ImportarTodosLosErrores`.
- [ ] **RP-73** — A goal measured in a unit other than time (RP-62) says on its own screen, under this month's amount, how many of this month's tasks are done and how many its list holds — «1 de 3 tareas hechas». «Por mes» names beside each month how many tasks its list holds, for every goal with a measure except one in time with a rhythm, which counts them in its plan (RP-50); a goal measured in time with no rhythm names them too. A month with no task says nothing of tasks. A goal with no measure counts them in its month block. Decided by the user 2026-10-11, succeeding RP-69.
- [x] **RP-63** — The template (`docs/pulsar/PLANTILLA.md`) carries a goal's rhythm as `ritmo:`, after its measure and only with a measure in time (RP-62); an import writes it, and the review shows it before the person confirms. A template without it reads as before. The model import proposes none. Decided by the user 2026-10-08, beside RP-37.
- [x] **RP-67** — An import whose goal carries a rhythm (RP-63) puts each of its tasks into the goal's plan (RP-50) instead of fixing it to its month: the month a task is written for only orders it, earlier months first, and the plan gives it its month. The review lets the person change the rhythm as it lets them change any other amount, before confirming. A goal without a rhythm imports its tasks fixed to their months, as before. Decided by the user 2026-10-09.

#### An AI at the person's side

- [x] **RP-38** — A person connects an AI assistant to their log with a key they create and name in the app, on a screen of its own reached from the goals. The key is shown once, when it is created, with what to paste into the assistant, and never again. The person sees each key's name, when it was created and when it was last used, and revokes it; a revoked key opens nothing, at once. A key reaches its person's log and no one else's. Claude Code and Claude Desktop connect this way. Decided by the user 2026-10-05.
- [x] **RP-39** — An AI connected to a person's log (RP-38, RP-60) reads what the app's own screens read, in the same figures: the goals, each goal's phases, commitments, months, tasks and measure, one month's list with what it carried, today, the one-offs waiting for a day, and the report (RP-49). Months read as YYYY-MM, days as YYYY-MM-DD, amounts as whole numbers in their unit. Decided by the user 2026-10-05: «lee tal proyecto».

#### The week and the review

- [x] **RP-16** — The week is drawn as it was: the days with facts and the days without. No streak, no score, no praise and no reproach. A deliberate rest day is a plan's instruction, not a failure. Decided by the user 2026-09-22.
- [x] **RP-17** — A goal's measure is read week by week, as the one table its review needs, from the first week to the current one.
- [x] **RP-44** — The week is read for any past week, one step back or forward at a time, from the week the first goal was
  opened to this one. A past week draws as it was lived (RP-16): the goals that were open in it, its facts and its evidence,
  a goal archived since still in the weeks it governed (RP-24). It is read-only: a day in it opens its own screen only
  within the seven days a fact may still name (RP-06). Decided by the user 2026-10-05.

#### The account

- [x] **RP-18** — A person signs in with a link sent to their address, with the session and the claim verification `apps/voyager` already uses. The log is theirs and reaches every device they sign in on.

### Non-functional requirements

- [x] **RNP-01** — Every string a person reads comes from the message catalogue. The interface is Spanish.
- [x] **RNP-02** — A declared fact costs one tap and lands in under five seconds from the app being open. This is the requirement the product lives or dies by; when it conflicts with another, it wins.
- [x] **RNP-03** — The day's screen pays a bounded number of round trips to Postgres, every one of them fanned out together, the evidence query included. Never a chain of awaits.
- [x] **RNP-04** — The evidence is never a condition of the day. When the reading app's rows cannot be read, the day draws its declared facts and says that one source could not be read. Never a blank day, never an error page.
- [x] **RNP-05** — A person reads and writes only their own facts. The access policies in the database decide it, not the query, and they are proved by driving them. No service path evades them.
- [x] **RNP-06** — The day is the person's day, in their own zone, never UTC. A fact at 23:40 belongs to that day; the same fact read from another zone still belongs to it.
- [x] **RNP-07** — The app holds at a 360 px viewport: no horizontal overflow, no overlapping control, no tap target under 32 px on its shorter side. It is used with one thumb, in the minute the thing was finished.
- [x] **RNP-08** — The person chooses light or dark and the choice is remembered on the device. The app opens in the system's mode until a choice is made.
- [x] **RNP-10** — A second evidence source costs a reader and a row of configuration, never a migration and never a screen. The shape a source answers in is fixed — a day, a quantity, a unit, a name for the person — and nothing downstream of it knows which app it came from.
  - Limits that remain, 2026-09-30, written and not built: (1) `withReadingDb` in `lib/session.ts` fixes `search_path` to `reading`, so a source in another schema needs a qualified reader plus that app's own grants and RLS. (2) Every reader runs in one transaction, so one failing source makes every source unreadable.
  - What a second source costs today: one reader in `lib/evidence/registry.ts`, one entry in `lib/evidence/source-rows.ts`, two keys in `messages/es/sources.json` (`<name>` and `<name>Unit`), then `npm run source:add -w apps/pulsar`.
- [x] **RNP-09** — Every `auth.users` row a script of this app creates is registered through `@repo/harness-registry`. No automated check ever submits the sign-in form with a typed address: it sends a real email from the user's own account and mints a real row.
- [x] **RNP-12** — The goal's months, a month's list, the export and the import's confirmation each pay a bounded number of round trips to Postgres — never one per month, per task or per item imported — fanned out together with the evidence query where they read it, never a chain of awaits; the goal screen and Hoy keep the four statements RNP-03 already measures.
- [x] **RNP-13** — A call to a paid model is claimed in the person's own record before it is made and refused past ten a day per person; the record keeps the day, the model and, once answered, the tokens and the outcome. With no key the import says it is not available and offers the template — never an answer with nothing in it, never a 204. No automated check or spec reaches the paid model: they run with no key, or against a stub that a deployed build ignores. Decided by the user 2026-09-30.
- [x] **RNP-14** — A call from a connected AI resolves its person in one statement to Postgres and never through the Auth server, so no call spends an Auth request. A read pays the round trips of the screen loader it reuses plus that one; a write pays its act's plus that one. Every statement after the first runs under the person's own policies (RNP-05).
- [x] **RNP-15** — A key, an authorization code and a token are stored only as their SHA-256 fingerprint; none of them appears in clear after the response that created it — never in a log, a URL, an error or a check's output. No automated check reaches a real assistant: `check:mcp` drives the app's own door with keys it mints for registered harness identities.
- [x] **RNP-16** — Below 1024 px four tabs — Hoy, Semana, Mes, Metas — stay on screen on every signed-in page, clear of the
  device's home area; they never cover a screen's content or a sheet's controls. Every screen carries one header: its
  title and, except the four tabs' own screens, one way back. Decided by the user 2026-10-05.
- [x] **RNP-17** — From 1024 px the app has a desktop face: a left rail names Hoy, Semana, Mes, Metas and each open goal;
  a screen that has a list shows it beside the open item; the week, the review and the export take the full width; every
  sheet is a centred dialog; nothing overflows from 1024 to 1440. Between 700 and 1023 the phone face holds, centred
  (RNP-07, RNP-16). Successor of RNP-11. Decided by the user 2026-10-05.
- [x] **RNP-18** — «Mes» pays two transactions fanned with `Promise.all` — the goals and the evidence — whatever the number
  of goals; a past week pays what this week pays. The rail's goal names cost one statement per page, read beside the
  screen's own.
- [x] **RNP-19** — The app's own authorization server answers one address past ten registrations an hour, or past thirty
  token requests in five minutes, with 429 and the seconds to wait. It keeps at most one hundred registered assistants that
  nobody has used, dropping the oldest.
- [x] **RNP-20** — A key or an authorization that goes ninety days without use opens nothing, as if revoked, and the
  connections screen says so; one in use never lapses. Use is a call through the key, or a refresh of the authorization.
  Decided by the user 2026-10-08.
- [x] **RP-64** — The connections screen names, for each authorization, the host it returns to, as the consent does (RP-60), and folds every key and authorization that has stopped opening for more than thirty days under one line that counts them; the thirty days count from when it stopped entering (lapsed or revoked). Nothing is deleted (RP-38). A lapsed key offers to create another. Decided by the user 2026-10-08.

---

### Retired
- [x] **RP-69** — A goal measured in a unit other than time (RP-62) says on its own screen, under this month's amount, how many of this month's tasks are done and how many its list holds — «1 de 3 tareas hechas» — and «Por mes» names beside each month how many tasks its list holds. A month with no task says nothing of tasks. A goal measured in time counts them in its plan (RP-50); a goal with no measure, in its month block. Decided by the user 2026-10-09.
  - Retired 2026-10-11 by the user: a goal measured in time with no rhythm has no plan to count its tasks in, so «Por mes» names them too. Successor: **RP-73**.
- [x] **RP-21** — A one-off with no day is not lost. It waits in a list of its own, off the day's screen, and is given a day whenever the person wants one. A one-off written for a later day waits in the same list, with its date, and can be moved, done or deleted there.
  - Retired 2026-10-06 by the user: a suelta is a task with no goal; a goal's task with no day waits in its goal's plan, never on `/sueltas`. Successor: **RP-59**.
- [x] **RP-40** — An AI connected to a person's log writes through the app's own acts and nothing else. It annotates: marks a commitment or a task done, logs a quantity, writes a one-off, a month task or a sub-task. It reorganizes: moves a month task to another month (RP-42), gives a one-off a day, renames a goal, moves a goal's last day, sets an open month's amount, adds a phase or a commitment, retires a commitment to change it (RP-12), accepts a shift (RP-34). It creates a goal. **It never deletes, never archives, never undoes a mark, never removes a month's amount and never reopens an archived goal.** What the app refuses the person, it refuses the AI, with the same reason in Spanish. Decided by the user 2026-10-05: «él mismo pueda reorganizar y hacer cosas».
  - Retired 2026-10-06 by the user: a task's month is derived by the plan, so the AI fixes and unfixes a task instead of moving it, and the shift it accepted is gone. Successor: **RP-56**.
- [x] **RP-48** — When a month of a goal ends having carried out more than half of what its list held (RP-32), and — for a goal with an amount planned that month (RP-28) — having reached under 60 % of it, that month's screen proposes, through the whole month after it, to move the goal's plan one month later. A month that reached its planned amount is never offered the move, whatever its list left. The person accepts in one sheet that says what moves: every month amount from the month after the closed one on, every one-off planned for those months and not yet done, and every phase not yet begun (a phase already begun stays); and the horizon, when something moved would pass it. The month after keeps no amount of its own until the person sets one. Nothing moves without that acceptance, nothing moves in another goal, and a proposal accepted is not made again for that month. Decided by the user 2026-10-06, succeeding RP-34.
  - Retired 2026-10-06 by the user: the plan is a roadmap that moves by itself, in proportion to what a month left short, instead of one whole month on acceptance. Successor: **RP-52**.
- [x] **RP-42** — A month task not yet done moves to another month of its goal's span that has not ended, with its sub-tasks; a sub-task moves only with its parent. Nothing else about it changes. Only the AI moves it: the month's own screen does not change. Decided by the user 2026-10-05.
  - Retired 2026-10-06 by the user: the person also fixes a task to a month, from its sheet, and the plan fills the rest. Successor: **RP-51**.
- [x] **RP-46** — A person exports how every goal is going **as a PDF**: a read-only page of the report, and «Descargar PDF», which hands that page to the browser's own print-to-PDF — on a phone, the share or print menu. It says how many goals it holds and how many of them have ended. For each goal not archived: its measure against this month's planned amount and against the planned amount to date, its phases, **this month's tasks** — those carried in first, with the month they came from and what they owe, then the month's own — **done and not**, each with its estimate and its sub-tasks, and its months (RP-32), **each month holding its weeks** (RP-17). Every date it prints carries its year. The export writes nothing, installs nothing and generates nothing on the server; a source that cannot be read is said so in it (RNP-04). Decided by the user 2026-10-05, succeeding RP-33.
  - Retired 2026-10-06 by the user, after the UX review: the report printed six A4 pages for three open goals, page one half blank, because every month printed its weeks. Successor: **RP-49**.
- [x] **RP-34** — When a month of a goal ends having carried out more than half of what its list held (RP-32), that month's screen proposes, through the whole month after it, to move the goal's plan one month later. The person accepts in one sheet that says what moves: every month amount from the month after the closed one on, every one-off planned for those months and not yet done, and every phase not yet begun (a phase already begun stays); and the horizon, when something moved would pass it. The month after keeps no amount of its own until the person sets one. Nothing moves without that acceptance, nothing moves in another goal, and a proposal accepted is not made again for that month. Decided by the user 2026-09-30, from the roadmap's «el tema técnico del mes siguiente se corre un mes entero».
  - Retired 2026-10-06 by the user. A month that beat its planned amount was offered the move whenever its list left a task: September did 255 % of its hours and was offered to push October's 12 h to November. Successor: **RP-48**.

- [ ] **RP-26** — A goal past its end says the day it ended, leaves the day and the week, and is listed apart among the goals; it can be archived or have its end moved. Nothing is deleted. Asked for by the user 2026-09-28.
  - Retired 2026-09-30 by the user. The week keeps a goal until the Sunday of the week it ended in (decided 2026-09-29, `SemanaMetaTerminada.dc.html`), so it does not leave the week. Successor: **RP-27**.
- [x] **RNP-11** — From 1024 px the app has a desktop face: a left rail in place of the bottom nav, Hoy and a goal in two columns, the week as a table of commitments by day, every sheet a centred dialog, every other screen one column in the same frame, with no horizontal overflow at 1280×800. Below 1024 the phone face holds unchanged (RNP-07). Asked for by the user 2026-09-28.
  - Retired 2026-10-05 by the user. The desktop face is redrawn with a rail that names the goals and a list beside the open item. Successor: **RNP-17**.
- [ ] **RP-33** — A person exports how every goal is going **as a PDF**: a read-only page of the report, and «Descargar PDF», which hands that page to the browser's own print-to-PDF — on a phone, the share or print menu. For each goal not archived: its measure against this month's planned amount and against the planned amount to date, its phases, the one-offs it carries, its months (RP-32) and its weeks (RP-17). The export writes nothing, installs nothing and generates nothing on the server; a source that cannot be read is said so in it (RNP-04). Asked for by the user 2026-09-30; PDF decided by the user 2026-09-30.
  - Retired 2026-10-05 by the user. The report carries this month's tasks, done and not, and folds the weeks into the months, so it no longer lists «the one-offs it carries» or the weeks apart. Successor: **RP-46**.
- [x] **RP-41** — claude.ai, on the web and on the phone, connects to a person's log through an authorization the person grants on a screen of the app that names the assistant and says what it may do and what it never does. The app is its own authorization server, and an assistant is recognised by registering itself or by the address of its own metadata. The authorization is listed beside the keys and revoked the same way. Decided by the user 2026-10-05.
  - Retired 2026-10-08 by the user: the consent also names where the person returns. Successor: **RP-60**.
- [x] **RP-57** — Tapping the name of a one-off that belongs to no goal opens the same sheet as RP-55, with its name alone: the person renames it, done or not, and «Borrar la tarea» sits at its foot only when RP-22 allows it. Decided by the user 2026-10-06.
  - Retired 2026-10-08 by the user: a loose task on today moves from Hoy. Successor: **RP-61**.
- [x] **RP-36** — A one-off with an estimated amount (RP-30), once done, adds that amount to its goal's measure on the day it was done — to the total, the week, the month and the export — and undone, takes it back. A one-off that holds others adds nothing of its own; each of them adds its own. **The same hours can count twice:** a task done inside a day's block also counts in that block's quantity (RP-03), and the app does not tell the two apart. Decided by the user 2026-09-30, knowing it.
  - Retired 2026-10-09 by the user: in a goal measured in km or pages a done task's figure counted the same distance twice («14 km de 13 km»); a task's figure now counts only in time. Successor: **RP-65**.
- [x] **RP-30** — A one-off that belongs to a goal with a measure can carry an estimated amount in that measure's unit, and a one-off planned for a month can hold one-offs of its own, one level deep. One that holds others has no amount and no day of its own: its amount is the sum of theirs, and it is done when every one of them is done. Asked for by the user 2026-09-30.
  - Retired 2026-10-09 by the user: a task carries an estimate only in a goal measured in time. Successor: **RP-68**.
- [x] **RP-49** — A person exports how every goal is going **as a PDF**: a read-only page of the report, and «Descargar PDF», which hands that page to the browser's own print-to-PDF — on a phone, the share or print menu. It says how many goals it holds and how many of them have ended. For each goal not archived: its measure against this month's planned amount and against the planned amount to date, its phases, **this month's tasks** — those carried in first, with the month they came from and what they owe, then the month's own — **done and not**, each with its estimate and its sub-tasks, and its months (RP-32); **on screen each month holds its weeks, folded under it; on paper only the months print** (RP-17). Every date it prints carries its year. The export writes nothing, installs nothing and generates nothing on the server; a source that cannot be read is said so in it (RNP-04). Decided by the user 2026-10-06, succeeding RP-46: six A4 pages for three goals.
  - Retired 2026-10-09 by the user: on paper a month not yet begun with no planned amount does not print; on screen and for the AI every month stays. Successor: **RP-70**.
- [x] **RP-70** *(successor of RP-49)* — A person exports how every goal is going **as a PDF**: a read-only page of the report, and «Descargar PDF», which hands that page to the browser's own print-to-PDF — on a phone, the share or print menu. It says how many goals it holds and how many of them have ended. For each goal not archived: its measure against this month's planned amount and against the planned amount to date, its phases, **this month's tasks** — those carried in first, with the month they came from and what they owe, then the month's own — **done and not**, each with its estimate and its sub-tasks, and its months (RP-32): on paper, a month not yet begun with no planned amount does not print; on screen and to a connected AI every month stays; **on screen each month holds its weeks, folded under it; on paper only the months print** (RP-17). Every date it prints carries its year. The export writes nothing, installs nothing and generates nothing on the server; a source that cannot be read is said so in it (RNP-04). Decided by the user 2026-10-09, succeeding RP-49.
  - Retired 2026-10-10 by the user: on paper the goal's measure names its name and unit, a line names the months left out, and the month count counts the printed ones. Successor: **RP-71**.

## 2. Model and invariants

### The four nouns

| Noun | What it is |
|---|---|
| **Goal** | A name, a horizon, one measure, and the phases it passes through. |
| **Commitment** | What counts, how often, and what satisfies it — a tap, a quantity, or evidence over a threshold. |
| **Fact** | Something that happened: its day, the moment it was written, its source, an optional quantity, an optional line. |
| **One-off** | Something to do once: a name, a day when it has one, a goal when it belongs to one, and a note when the person writes one. |
| **Month budget** | A planned amount for one goal in one calendar month, in the goal's measure unit. |
| **Rhythm** | How much of a goal's measure it takes per calendar month. A month budget overrides it for its month. |
| **Fixed month** | The month a person fixed a task to. A task with none takes its month from the plan. |
| **Access key** | A key a person creates for an AI assistant, or an authorization they grant one. Stored as its fingerprint; revoked, never deleted. |
| **Evidence** | Rows another app owns, read under the person's own identity and never copied. A source declares where they live and what one row is worth. |

### Invariants

- **Nothing stores "done".** A day's state is derived from facts against commitments, every time it is drawn.
- A fact is never edited. It is written once, and removed whole or not at all.
- A fact keeps the day it happened and the moment it was written. The two are never conflated and never collapsed into one column.
- Derived evidence lives in its own app's tables. This app reads it and never writes it.
- A commitment is retired, never deleted. A week already lived never changes shape because a plan changed today.
- A goal's measure is a sum over facts, never a column.
- The day boundary is the person's, not the server's.
- A quantity without a unit is not a quantity. The unit belongs to the commitment, never to the fact that repeats it.
- Nothing in the schema, the types or the screens names a particular evidence source. A source is configuration.
- A goal is optional. A fact with no goal is a whole fact.
- A month's reached amount, a one-off's done state, what it still owes and whether it is carried are derived, never stored. The only stored plan numbers are a goal's rhythm, a month's planned amount and a one-off's estimate. A task's month is derived by the plan unless the person fixed it.
- A time is stored in whole minutes. Hours are only how it is printed.
- Nothing a model proposes is written until the person confirms it.
- An AI acts as the person whose key it holds, through the same acts, schemas and policies as the screens. There is no second write path.
- A key exists in clear once, in the response that created it.

---

## 3. Architecture

A Next.js application whose data lives in the Supabase the other two apps already
use, in a schema of its own.

Principles, not recipes:

- One schema, `goals`, with its own migration journal, beside `finances` and `reading`.
- Evidence is a query across schemas under the reader's own session, so the reading app's
  own row policies are what allow it. **Confirmed 2026-09-22, before any module was written:**
  `apps/voyager/db/migrations/0000_shallow_hammerhead.sql` grants `USAGE ON SCHEMA reading`
  (:8) and `SELECT ON reading.lookups` (:71) to `authenticated`, and the policy
  `lookups_select_self` narrows it to `auth.uid() = user_id`. Nothing in `apps/voyager`
  changes for this app to read its evidence.
- **What that evidence holds today, measured the same day: 55 rows, one reader, one single
  day — 2026-09-11 in Bogotá, eleven days ago.** The path works; the habit has not reached it.
  RL-30 — the copy starting on its own — is still unticked in `docs/voyager/SPEC.md`, so a
  day here reads empty until the device syncs. A screen built on this source is correct and
  quiet at once. Build it knowing that; do not read the quiet as a defect.
- The identity is one `auth.users` row across the three apps. A person signed into the
  reading app and into this one is the same person, or no evidence can be read at all.
- `@repo/supabase-auth` serves the session and the claim verification. Nothing about
  auth is written twice.
- An AI reaches the log through `/mcp`, a route of this app, never through the database or a second API. Its person is resolved from the key by one function in `goals` and every statement after runs as that person. The app is its own OAuth 2.1 authorization server, its issuer the production URL, and accepts a client by dynamic registration or by the address of its metadata. Decided by the user 2026-10-05.

---

## 4. Stack

| Need | Choice | What it saves |
|---|---|---|
| Framework | **Next 16.3.3** | The version both apps run. Routing and server actions. |
| UI | **React 19.2.8** | The version Next 16.3.3 pairs with. |
| Language | **next-intl 4** | The Spanish catalogue RNP-01 requires, with date and number formatting. |
| Validation | **Zod 4** | One schema validates the form and the server action alike. |
| Components | **Radix Themes 3** | Layout, typography, controls and theming as components with props. |
| Icons | **lucide-react** | An icon set, chosen independently of the component library. |
| Types | **TypeScript**, with **@typescript/native-preview** | `tsgo` checks the project in seconds. |
| Lint | **eslint**, with **eslint-config-next** | The rules the framework's own conventions need. |
| Browser verification | **Playwright** | The facts no server-side check reaches: the 360 px viewport, the tap target, the five seconds of RNP-02. |
| Postgres | **postgres 3 + drizzle-orm 0.45** | The same client and ORM the other two apps use, over the same pooler. |
| Migrations | **drizzle-kit 0.31** (dev) | The `goals` schema versioned in the repository, with a journal of its own. |
| Auth | **@repo/supabase-auth** | The cookie session and the magic link, already written and already proved. |
| AI door | **mcp-handler 2** over **@modelcontextprotocol/server 2**, in a route handler | The MCP Streamable HTTP transport, both protocol eras, and the 401 that points at the resource metadata, without writing a JSON-RPC server. Decided by the user 2026-10-05. |
| OAuth 2.1 | Route handlers of this app and functions in `goals`; no library | The authorization server claude.ai needs, with the issuer at the production URL. Decided by the user 2026-10-05. |
| Plan import | **OpenAI over fetch**, no SDK — the way apps/voyager/lib/word/model.ts calls it, with the answer validated by Zod | Reading a plan in any shape, PDF included, without a parser or a PDF library. |

### Do not install

| Library | Use instead |
|---|---|
| Tailwind, shadcn/ui | Radix Themes is the system. |
| Zustand / Redux | The day is server state; a form is a form. |
| A date library (moment, luxon, date-fns) | `next-intl`'s formatting and one function that names the person's day. |
| A cron or scheduler package | A cadence is a rule read at draw time, never a job that writes rows. |
| A charting library | The review is a table (RP-17), not a chart. |
| A notification or push package | Out of scope, and it is what turns this app into one more thing to ignore. |
| The OpenAI SDK | fetch to https://api.openai.com/v1/… |
| A PDF library (pdfkit, react-pdf, pdf-lib, puppeteer) | The browser's print to PDF over a print-styled page (RP-49). |
| `@modelcontextprotocol/sdk` (1.x) | `@modelcontextprotocol/server` 2, which `mcp-handler` 2 requires. |
| redis, `@upstash/*` | `mcp-handler` 2 is stateless. |
| An OAuth server library (oidc-provider, @node-oauth/oauth2-server) | Route handlers of this app (RP-60). |
