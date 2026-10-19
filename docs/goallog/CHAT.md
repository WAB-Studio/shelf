# GoalLog chat: what it must be able to do, and what it costs

Contract: RP-91–RP-95, RP-56 (retired for RP-119), RP-85 in `SPEC.md` §1. Boards: `DESIGN.md` «Decisions of 2026-10-13, the chat».
The tools are `apps/goallog/lib/tools/catalogue.ts`: 6 reads and 20 writes. A write is a proposal the person taps «Hacer» on
(RP-92); a read runs at once. The user's words, 2026-10-18: «analizar varios modelos, tampoco cosas caras; echarle cabeza a qué
tanto necesitamos».

## What a person brings

### Questions about the plan (reads; each is one of the fifty a day, P5)

| Task | Tool |
|---|---|
| «¿Qué me toca hoy?» | `get_today` |
| «¿Cómo voy en noviembre con Inglés?» | `get_month` (after `list_goals` for the id) |
| «¿Cómo va la meta de Inglés?» | `get_goal` (after `list_goals`) |
| «¿Qué metas tengo?» | `list_goals` |
| «¿Cómo voy este mes?» | `get_report` |
| «¿Qué tengo suelto esperando un día?» | `list_loose_one_offs` |

### Single changes (one proposal each)

| Task | Tool |
|---|---|
| «Hice la clase de inglés hoy» | `declare_fact` |
| «Ya terminé el Informe» | `complete_task` |
| «Agrega la tarea Pasaporte a Casa, de 2 horas» | `create_task` |
| «Anota en el Informe: …» | `set_task_note` |
| «Pon el Informe para el 27» | `schedule_task` |
| «Ponle 25 horas a Inglés en noviembre» | `set_month_amount` |
| «Renombra Fitness a Salud» | `rename_goal` |
| «Agrega una fase a Inglés de noviembre a diciembre» | `add_phase` |
| «Agrega la clase de inglés los lunes y miércoles» | `add_commitment` |
| «Mueve el final de Casa a marzo» | `move_horizon` |
| «Pasa Maze a noviembre» | `fix_task` |
| «Devuelve Documento al plan» | `unfix_task` |
| «Estima Maze en 3 horas» | `set_task_estimate` (through `editTask`; null clears it) |
| «La fase 2 termina el 30» | `edit_phase` (through `editPhase`) |
| «Crea la meta Viaje» | `create_goal` |
| «Pon Fitness dentro de Salud» | `move_goal` |
| «Anota en Casa: …» | `set_goal_note` |
| «Cambia la clase de inglés por otra» | `retire_commitment` (then `add_commitment`, two steps) |
| «El ritmo de Casa es de 10 horas al mes» | `set_rhythm` |
| «Inglés se mide en horas» | `set_measure` |

### Two-step changes

- A change over what exists, two proposals in one message: «pasa Maze a noviembre y anota que depende del Informe»
  (`fix_task` + `set_task_note`); «renombra Casa a Hogar y mueve su final» (`rename_goal` + `move_horizon`).
- A change that needs what another creates: «crea la meta Viaje y agrégale una tarea». The chat proposes only `create_goal`
  and says the rest waits (P3); the person asks again after «Hacer».
- A change to a commitment's rhythm: `retire_commitment` then `add_commitment` (RP-12). The second needs the first made.

### Refusals (no proposal, one sentence)

Delete a task or a goal; archive a goal; undo a mark («desmarca la clase de ayer»); remove a month's amount. RP-119 and the system
prompt forbid them. The right answer proposes nothing and says so.

### Missing (the chat cannot answer; no proposal either)

| Task | Status |
|---|---|
| Move a task to another goal («pasa Maze a Fitness») | **no existe** on any screen or tool (plan Q4 of oleada-4) |

The estimate and the phase edit are built (RP-139, `set_task_estimate` over `editTask`, `edit_phase` over `editPhase`). The move is a domain act that does not exist, and waits for Q4.
A good model refuses it or says it cannot; a bad one proposes the nearest wrong tool (`create_task`, `fix_task`).

## What the chat does not need

- No free-form planning, no «arma mi plan»: the import does that (RP-86, gpt-5.5).
- No long reasoning: a request names one or two acts over entities a read returns. `REASONING_EFFORT` is `low` in `lib/chat/model.ts`.
- No memory beyond the tab (RP-94).
- What it does need: pick the right tool among 26, fill ids from a read and never invent one, keep dates as AAAA-MM-DD, refuse
  what RP-119 forbids, answer in Spanish in a sentence or two.

## Tokens per message

Measured by size, not by a run; the bench replaces them with `goals.model_calls` rows.

| Part | Size | Tokens (about) |
|---|---|---|
| System prompt (`lib/chat/prompt.ts`, 1.3 KB) | 1.3 KB | 400 |
| 26 tool schemas and descriptions (4.1 KB of descriptions, about 22 schema objects) | 12–14 KB | 3,500–4,000 |
| A turn of the person | up to 2,000 chars | 30–600 |
| A read's payload (`lib/mcp/shape.ts`): `get_today`, `get_month` | 2–6 KB | 600–1,800 |
| A read's payload: `list_goals`, `get_goal`, `get_report` on a plan of 3 levels | 4–12 KB | 1,200–3,600 |

Each round re-sends everything. A single change is two or three rounds (a read for ids, the proposal, the closing words); a
question is two. A mean message: **15,000 input tokens** (4,000 fixed × 3 rounds plus reads) and **1,500 output** (low reasoning
counts here). These are the figures `run.ts` uses for its estimate. Mean per message is a guess until the first paid run.

## Cost per model

List prices in USD per million tokens, written down from memory on 2026-10-18. **Re-read each on the day before spending: they are
not verified here.** Cost of one message = 15,000 × input + 1,500 × output; a run is 25 messages; a person's day is at most 50.

| Model | Input | Output | One message | The 25-task run | A person's full day (50) |
|---|---|---|---|---|---|
| gpt-5-nano | 0.05 | 0.40 | USD 0.0014 | USD 0.034 | USD 0.07 |
| gpt-4.1-nano | 0.10 | 0.40 | USD 0.0021 | USD 0.052 | USD 0.10 |
| gpt-5-mini (RP-93, today) | 0.25 | 2.00 | USD 0.0068 | USD 0.17 | USD 0.34 |
| gpt-4.1-mini | 0.40 | 1.60 | USD 0.0084 | USD 0.21 | USD 0.42 |
| gpt-5 | 1.25 | 10.00 | USD 0.034 | USD 0.84 | USD 1.69 |
| gpt-5.5 (the import's) | not known | not known | re-read | re-read | re-read |

Reading it: benchmarking the four cheap models costs under USD 0.50 in all. gpt-5 is the ceiling worth looking at, under USD 1.
The app-wide cap (`APP_MODEL_CALLS_DAILY_CAP`, 600 calls) bounds the day: at gpt-5-mini 600 × 0.0068 is about USD 4, at gpt-5 about USD 20.
A bench run is 25 calls of the bench person's fifty and counts in the app's cap.

## The bench

`apps/goallog/scripts/chat-bench/`: `tasks.ts` (25 tasks mirroring this document), `score.ts` (pure scorer), `run.ts`. No
`package.json` entry, no check, no CI job: only a person runs it, with the user's yes. The tests (`score.test.ts`) never reach
the network.

- Refuses to start without `--i-pay`, without `OPENAI_API_KEY`, against anything but `http://localhost:<port>`, without
  `PULSAR_CHAT_BENCH_MODEL` set to the same name as `--model` (the server runs with it too), and without both prices.
- Prints its estimate first; refuses when the estimate reaches USD 10; stops mid-run when the real tokens × the prices reach USD 10.
- Spreads the messages over the sessions it is given, round-robin, so none passes 50 (it demands enough sessions for 40 each).
  The tasks need a seeded plan (`SEED` in `tasks.ts`) per session and a `--seed` file mapping each session to its ids.
- Writes `private/chat-bench/<model>-<time>.md`: model, task pass rate, mean input and output tokens, cost, p50 and p95 latency,
  and a line per task.
- Reads tokens from `goals.model_calls` (the route answers none). That table records the model as `gpt-5-mini` whatever the
  bench model is (`claimModelCall(CHAT_MODEL, …)`); the bench filters by source and time, never by model.
- Reads nothing the OpenAI CSV holds: it does not say what the app spent (`docs/TRAPS.md`, «El CSV de OpenAI no dice lo que gastó la app»).

The bench decides nothing (RP-93 stands): it hands the user a table; the user picks the model.
