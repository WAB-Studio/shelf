# Traps archive

Entries moved out of `docs/TRAPS.md` because their file or their cause is gone, or because another entry now says the same.
Each keeps its text and its measurement. Read one only to learn why a rule exists.

### The voyager suite drives the real decoration routes, and pays for them

_Archived 2026-10-18: superseded 2026-10-08: the route it measured is gone._

**Superseded 2026-10-08.** Measured 2026-09-11, when `/api/word/photo` still existed: 79 tests reached
it and `/api/word/text` for real on every run. That route went with RL-36 (2026-09-14). The cost it
named stays true for the routes that remain and is now guarded in `apps/wordbook/e2e/fixtures.ts`:

- `test`/`expect` imported from `./fixtures` intercept `/api/word/text`, `/api/word/unlisted` and
  `/api/phrase/notes` and answer them deterministically, tagging each stub with `x-e2e-word-stub`.
  A watchdog fails a spec that reached a real one without `allowRealWordRoute(route, reason)`.
- A spec that imports `@playwright/test` directly skips the guard: those three routes then write
  rows to the shared Postgres and spend the model's daily cap.
- An unbounded network call inside a timing-sensitive test is a race, not a regression; keep real
  routes out of any spec that races a settle window.


### `e2e-remote-db` is a one-slot concurrency group for the whole repository

_Archived 2026-10-18: the group no longer exists since module 227 (CI runs on its runner's own stack)._

GitHub holds one run in progress and **one** in the queue per concurrency group. A third arrival
does not queue behind the second: it **cancels** it. Opening a second PR while a first one's `e2e`
is still running therefore kills the first one's queued run, and the PR reads as failed for a
reason that has nothing to do with its diff.

It happened with #30 and #31 on 2026-09-07. Land one PR's `e2e` before opening the next when both
touch the group, or expect to re-run by hand.

Closed 2026-10-05 by module 227: CI runs on its runner's own stack.


### Every push enters the one-slot group, not just every PR

_Archived 2026-10-18: the group no longer exists since module 227; the advice to fast-forward `integracion` only when about to merge into it lives in `docs/agentes/lanes.md`._

The entry above and `AGENTS.md` both frame `e2e-remote-db` as something a second **PR** disturbs. It
is wider than that: **any** push that triggers the workflow takes a place in the queue.

Measured 2026-09-08. Fast-forwarding `integracion` to `main` — a branch update carrying commits
`main` had already tested green — queued a run that evicted PR #37's `e2e` after 8m12s of waiting.
The job's own annotation names it exactly:

    Canceling since a higher priority waiting request for e2e-remote-db exists

`cancel-in-progress: false` does not save you. It stops a new arrival from killing what is *running*;
it does not stop a third arrival from evicting what is *queued*. GitHub keeps one running and one
waiting, and the newest request wins the waiting slot.

The eviction reads as a plain red `e2e` on the PR page. Check the run's ANNOTATIONS before chasing a
diff: `gh run view <id>` prints them, and a cancelled-by-priority run names itself.

Land one thing at a time when the group is busy, and prefer cancelling a redundant run
(`gh run cancel <id>`) over adding another.

**The redundant run is usually your own `integracion` fast-forward.** `docs/agentes/lanes.md` says to
fast-forward it *before using it*; doing it after every merge instead queues a run over a SHA `main`
has already tested, and that run is what evicts the PR waiting behind it. Measured again 2026-09-08:
three fast-forwards in an afternoon, each one a push run on a SHA identical to `main`'s, and the last
of them held the slot while PR #48 — the only PR of the day that actually needed orbit's `e2e` —
waited in the queue behind it.

Fast-forward `integracion` when you are about to merge into it. Not after every merge to `main`.

Closed 2026-10-05 by module 227: CI runs on its runner's own stack. The group is gone; a push queues nothing.
Fast-forwarding `integracion` still spends a run, so keep the advice above.


## Los números de módulo se repiten entre slices, y los informes se pisan

_Archived 2026-10-18: reports are named by branch (`private/reportes/<branch>.md`); module numbers no longer name them._

Medido 2026-09-08. `private/reportes/modulo-12-contrato-foto.md` iba a escribirse junto a un
`modulo-12-driver-copia.md` de otro slice, y `modulo-13-proveedores-ia.md` junto a
`modulo-13-cadenas.md`. Cada plan numera desde 1, así que el número solo es único dentro de su plan.

- Nombra el informe por lo que hace, no solo por el número. `modulo-12-contrato-foto`, nunca `modulo-12`.
- Comprueba `ls private/reportes/modulo-<n>-*` antes de escribir uno.


## Copia el informe del carril antes de soltarlo

_Archived 2026-10-18: merged into «Dropping a worktree burns the report inside it»._

Medido 2026-09-08. `git worktree remove ../finances-app-l3 --force` se llevó
`modulo-12-contrato-foto.md` sin avisar: `private/` está en gitignore, así que el informe vivía solo
ahí. Sobrevivió porque su contenido estaba en el cuerpo del PR y en `SPEC.md`.

- `cp ../finances-app-l<n>/private/reportes/*.md private/reportes/` **antes** del `worktree remove`.
- Escribe en el cuerpo del PR lo que decide, no solo en el informe. El PR sí viaja en git.


## Openverse y el bucket de Supabase: tres cosas que muerden al escribir el módulo

_Archived 2026-10-18: describes RL-36, retired 2026-09-14; no code uses Openverse._

**Describe una ruta retirada.** `RL-36`, la foto de la palabra, se retiró entero el 2026-09-14
(`docs/wordbook/SPEC.md` §1 «Retired»); lo de abajo queda escrito porque costó un día, no porque siga
en pie.

Medido 2026-09-10 conduciendo la cadena entera —buscar, bajar, subir— antes de despachar nada.
Las tres salieron en las primeras cinco palabras.


### Los metadatos de S3 sólo admiten ASCII, y los autores de Openverse no lo son

_Archived 2026-10-18: describes RL-36, retired 2026-09-14; no code uses Openverse._

`put_object` con `Metadata={"creator": ...}` revienta con
`ParamValidationError: Non ascii characters found in S3 metadata`. El autor que lo destapó venía
como **`☺ Lee J Haywood`** — un emoticono dentro del nombre, en el primer resultado de `kettle`.

**La atribución no va pegada al objeto en S3. Va a Postgres**, que además es de donde lee la lista
por imagen de `/cuenta`. Pegarla al objeto era la arquitectura equivocada y el error lo dice antes.


### Un resultado de Openverse puede apuntar a una imagen muerta

_Archived 2026-10-18: describes RL-36, retired 2026-09-14; no code uses Openverse._

`abeyance` devolvió un resultado válido cuya miniatura dio **`HTTP 424 Failed Dependency`** — el
proxy de miniaturas de Openverse contesta 424 cuando el original de aguas arriba ya no está.

- Pide **varios candidatos** (`page_size=5`), no uno.
- Por cada candidato prueba `thumbnail` y, si falla, `url`.
- Con eso, medido sobre 60 palabras: **93,3% bajan**, y en el 100% de las que tenían resultado
  **sirvió el primer candidato**. El 424 es ocasional, no sistemático — pero sin reintento se lleva
  por delante una palabra que sí tenía foto.
- **La cobertura real es 93,3%, no el 95,7%** que salió al contar resultados en vez de descargas.
  Contar resultados cuenta también los muertos.


### Una «miniatura» de Openverse puede pesar 5,3 MB

_Archived 2026-10-18: describes RL-36, retired 2026-09-14; no code uses Openverse._

Sobre las mismas 60: mediana **44.117 B**, p90 **154.415 B**, **máximo 5.338.962 B**. No hay
garantía de tamaño en el campo `thumbnail`.

Guardar 5 MB para dibujar un cuadro de 76 px es tirar el bucket. **Pon un tope de bytes y descarta
el candidato que lo pase**, pasando al siguiente — no lo recortes después de haberlo subido.


## `foto.spec.ts` no puede pedirle píxeles al bucket en CI, y no debe pedirle credenciales tampoco

_Archived 2026-10-18: `foto.spec.ts` and `/api/word/photo` are gone with RL-36._

**Describe una ruta retirada.** `RL-36`, la foto de la palabra, se retiró entero el 2026-09-14
(`docs/wordbook/SPEC.md` §1 «Retired»); `foto.spec.ts` y `/api/word/photo` salen del código en el
módulo que lo construye, y lo de abajo queda escrito porque costó un día, no porque siga en pie.

Medido 2026-09-11. `.github/workflows/ci.yml`'s `voyager-e2e` no define ninguna de las cinco
`SUPABASE_STORAGE_*` que `isStorageConfigured()` exige — a propósito: dárselas a cada corrida de CI
le daría a cualquier push escritura sobre el bucket de producción del usuario. Sin ellas, la ruta
`GET /api/word/photo` nunca puede servir el objeto, así que una prueba que dependa del bucket para
dibujar píxeles reales **no puede pasar en CI jamás**, con o sin credenciales de más.

- La guarda (`isPhotographableHeadword`) sí se prueba sin bucket: corta antes de tocar Postgres o
  Openverse, así que `grudge` responde 204 igual con o sin almacenamiento.
- Que la ruta **acepte** una palabra fotografiable sólo se distingue de un fallo de bucket cuando la
  palabra ya tiene una fila `found` cacheada — `dog` la tiene, en la base compartida que usan tanto
  los carriles como CI (mismo `DATABASE_URL`). Sin esa fila cacheada, un `dog` sin bucket responde
  204 igual que uno cuya guarda lo hubiera cortado: `getCachedPhoto` corre antes que
  `isStorageConfigured`, así que una palabra sin caché y sin bucket nunca llega a Openverse. Purgar
  esa fila deja esta distinción sin piso.
- La costura del dibujo — que los bytes se conviertan en píxeles — se prueba con bytes **sembrados**,
  no con el bucket: intercepta sólo `GET /api/word/photo?*` en el propio origen de la prueba
  (`VOYAGER_BASE_URL`, nunca un patrón `**` que también atrape una URL absoluta a otro host) y
  responde con un PNG generado por el propio `<canvas>` del navegador — decodificable de verdad,
  nunca un data URI copiado a mano. El POST sigue siendo real: sólo se sustituyen los bytes que el
  bucket habría servido.
- Control negativo de la guarda: `isPhotographableHeadword` a `return true`, más `DATABASE_URL`
  apuntado a un puerto que rechaza la conexión (nunca a la base real: así la guarda rota nunca llega
  a escribir una fila de un headword que no pasa el corpus). `grudge` da `500`, no `204` — la prueba
  se pone roja sin tocar la base compartida.
- Control negativo del dibujo: revertir sólo `toWordPhoto` en `route.ts` a construir la URL absoluta
  con `NEXT_PUBLIC_SITE_URL` (el defecto original de #152) sin tocar `protocol.ts`. El esquema
  `photoResponseSchema` — endurecido en el mismo commit que arregló el defecto — ya rechaza esa URL
  en el cliente (`.startsWith("/api/word/photo?")`), así que `fetchPhoto` cae a `catch` y la foto
  queda `{ kind: "absent" }`: ni siquiera se monta un `<img>`. La prueba se pone roja en
  `expect(img).toBeVisible()`, antes de llegar a la interceptación.


## `.next/types/validator.ts` sobrevive a la ruta que describe

_Archived 2026-10-18: merged into «`.next/dev/types` viejo pone en rojo un typecheck que está bien»._

Medido tres veces el 2026-09-19, en tres árboles distintos, tras retirar `/api/word/photo`:

```
.next/types/validator.ts(134,39): error TS2307: Cannot find module '../../app/api/word/photo/route.js'
```

`tsgo` lee los tipos generados por una corrida anterior a que la ruta muriera. **No es una
regresión y no hay nada que arreglar en el código.** `rm -rf .next && npx next typegen`, o
cualquier `next build`, lo borra. `.next` no está versionado, así que no deja rastro en el árbol.

Cuesta minutos cada vez que alguien lo lee como un rojo suyo: lo tropezaron el worker del módulo 8,
su validador y el rebase de RL-49.

Vuelve en Next 16 con otra ruta y otro nombre de archivo. Medido el 2026-09-22 en `apps/goallog`,
lane 4, después de que un validador creara `app/uicheck9x/page.tsx` para medir la pantalla y la
borrara al terminar:

```
.next/dev/types/validator.ts(51,39): error TS2307: Cannot find module '../../../app/uicheck9x/page.js'
```

Ahora los tipos del servidor de desarrollo viven en `.next/dev/types`, no en `.next/types`, y
`rm -rf .next/dev/types` basta: no hace falta tirar `.next` entero ni volver a construir. **Una
ruta de prueba que se borra deja su entrada detrás**, así que el rojo aparece en el árbol del
siguiente que corra `typecheck`, no en el del que la creó.


## The `pulsar-e2e` queue holds one waiting run, and a newer one cancels it

_Archived 2026-10-18: the `pulsar-e2e` group is gone since module 227._

- **What.** The job's `concurrency: { group: pulsar-e2e, cancel-in-progress: false }` keeps one run
  going and one waiting. A third pull request replaces the waiting one, which ends `cancelled` with no
  steps. `gh pr checks` prints it as `fail`.
- **Measured 2026-09-30.** #319 cancelled that way; #329 twice in one hour, each time by a PR opened
  while it waited (#330, then #331). Both showed `fail 36s`–`1m7s`, `steps: []`.
- **Do.** Open pulsar pull requests one at a time, each after the previous one's `pulsar-e2e` started.
  Read `gh api repos/<repo>/actions/jobs/<id> -q .conclusion` before reading a `fail` as a red.
  Relaunch a cancelled one with `gh run rerun <run> --failed`, or a rebase and push.
- Closed 2026-10-05 by module 227: CI runs on its runner's own stack. The `pulsar-e2e` group is gone; a cancelled run with no steps is no longer this queue.


## Two `voyager-e2e` runs at once fail `registro.spec.ts:568`

_Archived 2026-10-18: CI runs on its runner's own stack since module 227; the collision no longer exists._

- **What.** `voyager-e2e` has no concurrency group. Two pull requests ran it one minute apart against
  the one database, and both failed «the foreign row never made it down» at `registro.spec.ts:606`.
  The spec waits for the sync with `waitForTimeout(2000)`.
- **Measured 2026-09-30.** #329 at 20:55 and #331 at 20:56, 191 passed / 1 failed each. #330 alone,
  minutes before, passed. #329's rerun, alone, passed. Logs in `private/ci-reds/`.
- **Do.** Read two simultaneous `voyager-e2e` reds on that spec as this collision, not as the branch.
  Rerun it alone. Never answer it with a retry or a longer sleep: the sleep is the defect.
- Closed 2026-10-05 by module 227: CI runs on its runner's own stack. Two `voyager-e2e` runs no longer share a database.
  The `waitForTimeout(2000)` in the spec is still the defect.


## A canvas read costs the main session about 40k tokens (2026-10-16)

_Archived 2026-10-18: merged into «Reading the design canvas spends 30k tokens before the file exists»._
- `Artifact read` of the WordBook canvas returned the 4.3 MB page: the editor's stylesheet and fonts, before any board.
- Do: read it once, and take the boards from the saved file with a script. They live in the `appifact-doc` script, `content.files`, one `.dc.html` each, plus `canvas.json`. Splice new boards in there. Before republishing, strip the publish skeleton the read prepends (everything before `<!doctype html>\n<html lang="en">`), and escape `</` in the JSON.

## HomeFund's drizzle snapshot chain forks at 0052 (2026-10-16)

_Archived 2026-10-22: M6 repaired the chain. Snapshots 0053–0057 carry 0053's 24 foreign-key indexes; `drizzle-kit check` passes and `db:generate` writes nothing._
- `npm run db:generate` fails on `integracion`: snapshots 0053 and 0054 both name 0052's id as `prevId`. A migration's own proof «generate writes nothing» can only be taken with the chain straightened by hand, then reverted.
- Do: fix the chain in a module of its own before relying on `db:generate`. Until then, say in a report that the proof ran on a straightened chain.

## The e2e setup purged the leader alone, so a dead run left the member's rows for every later run

- `apps/homefund/e2e/global-setup.ts` purged `userId` and never `memberUserId`. A run that died before its own cleanup on
  2026-10-23 left three personal accounts owned by lane 2's member («Cuenta de la bandeja», «Nómina», «Visa Oro»).
- Every spec that reads what the member sees read them as the fund's: 12 `writable-accounts.spec.ts` tests offered one
  account too many, and `debts.spec.ts` «Deuda total» read $ 1.290.000 where it seeds $ 40.000. Red on every lane 2
  run from oleada-7 on, green on CI, so it looked like lane state.
- Purge both identities at setup and teardown. Measured 2026-10-28: 170/0 on `debts` + `writable-accounts` after.

### A pulsar lane mints no identity, so every lane writes the same `goals` rows

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

`scripts/worktree.sh`'s table gives `pulsar` an `.env.local` and **no harness identities**, so a lane
opened with `--app goallog` has no `harness-<n>@example.invalid` of its own. Every pulsar track that
needs a person to write as reaches for the same registered pair, `harness-5@example.invalid` and
`harness-member-5@example.invalid` — and `HARNESS_LANE` does not scope `goals.goals`,
`goals.commitments`, `goals.phases`, `goals.facts` or `goals.one_offs`. Two tracks seeding fixtures
at once are writing the same person's rows.

Measured 2026-09-22: module 8's verification saw rows appear and vanish under it while module 10's
lane was seeding the same identity. Both reports were honest; the database was one.

Two rules follow, and the second is the one that bites:

- **Delete a fixture by its exact id. Never by `user_id`.** A cleanup scoped to the person takes the
  other lane's rows with it, and that lane then reports a failure it did not cause.
- **Count rows before and after your own run, and treat a moving count as a neighbour, not a bug** —
  until you have checked which lanes are live.

It is the same shape as «One database behind every harness lane» above, one schema over.

### `check:e2e` reads `PULSAR_BASE_URL`, and a lane running `HARNESS_BASE_URL` alone never notices

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- **What.** `apps/goallog/playwright.config.ts` reads `process.env.PULSAR_BASE_URL`, never
  `HARNESS_BASE_URL`, and falls back to `http://localhost:3200` — lane 1's port — when it is unset.
  A lane invoking `check:e2e` by hand with only `HARNESS_BASE_URL` set drives whatever server already
  answers 3200 instead of its own build, and a mutation applied only to the lane's own checkout never
  reaches the suite: both the "baseline" and the "mutated" run pass, identically, for the same reason
  — neither one ever left port 3200.
- **Measured 2026-09-27** by the mutator (`private/reportes/pulsar-mutaciones.md`): caught by an
  `ss -ltnp` on 3200 showing a `next-server` nobody in that session had started, confirmed by a direct
  `curl` plus cookie against the real lane port, which showed the mutation's effect where the suite
  run against 3200 had shown none.
- **Do.** Set `PULSAR_BASE_URL` explicitly for every `check:e2e` invocation outside the lane's own
  `npm run` default (`PULSAR_BASE_URL=http://localhost:320<n-1>`), the way `docs/TRAPS.md`'s own
  voyager entry already names this shape for that app: "`worktree.sh` derives a suite's base-URL
  variable from the app's name." `HARNESS_BASE_URL` alone is not that variable for this app.

### A spec's own "another day" was yesterday, which on a Monday belongs to the week before

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- **What.** `apps/goallog/e2e/semana.spec.ts` picked a day "guaranteed not to be today" by subtracting
  24 hours from now, unconditionally. On every day but Monday that lands inside the current
  Monday-to-Sunday week; on a Monday it lands on the Sunday before, a day `lib/zone.ts`'s `weekOf`
  places in the *previous* week — the spec then asserted against a day `/semana` never draws at all.
- **Measured 2026-09-28**, 00:08 Bogotá — the first Monday the suite ran after it landed. Fixed the
  same day in `#250`: `otherDayLabel()` steps forward a day instead of back when today is itself a
  Monday, so "another day of this week" always stays inside the week it means to test.
- **Do.** A spec that picks "some other day near today" to stay inside one civil-day window (a week,
  a month) must derive its direction from where today itself sits in that window, never assume
  "yesterday" or "tomorrow" is always inside it — the boundary day is exactly the one on which that
  assumption breaks, and a suite run any other day of the week will not catch it.

### A lane's `session-<n>.json` outlives the identity it names

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- **What.** `check:goal` failed with `Failed query: insert into "goals"."goals" … params: 50a8cf48-…`:
  the cookie in `apps/goallog/private/session-4.json` named a harness identity `harness:reap` had already
  pruned. `mint-session` opens a seed run it never closes, so the reap drops it once its heartbeat is
  30 minutes stale, and the session file stays behind pointing at nobody.
- **Measured 2026-09-28** on lane 4, twice: module 65's rerun and the coordinator's. A fresh
  `harness:mint-session` made the same code pass, 87 checks.
- **Do.** Run `HARNESS_LANE=<n> PULSAR_BASE_URL=http://localhost:<port> npm run harness:mint-session
  -w apps/goallog` before `check:day`, `check:goal` or `check:goal-actions` when the last mint is over
  half an hour old. A red on an insert naming a `user_id` that is not the lane's is this, not the code.
- **Its access token also dies after an hour, and then every call spends a refresh.** `getClaims()` refreshes an
  expired token and a script never writes the new cookie back, so each server action pays one
  `POST /token?grant_type=refresh_token`. Auth's refresh limit is per IP, and the five lanes share one.
- **Measured 2026-10-05** on lane 3: `session-3.json`'s token had expired ten hours before. One `check:plan` logged
  **202** `429 over_request_rate_limit` and passed 22 of 74; five runs read 21–25 of 74. After a fresh mint the same
  code passed 74 of 74 with no 429. Logs in `private/auth-rate-limit-2026-10-05/`.
- `mint-session` needs the lane's own server up. Without it it prints `FAILED  fetch failed`, which is not a 429.
- **Do.** Mint before every `check:*` run, not by the half hour. Read the token's `exp` when a check reds on
  `signedOut` or `withGoalsDb called without a verified session`.

### Two specs that mint at one lane number share a session file

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

Measured 2026-09-29 in `apps/goallog`: `mint-session.ts` wrote `private/session-<lane>.json`, and every
spec picked its lane by hand (`9700 + laneNumber()` in `metas-terminadas` and `sueltas-programadas`,
`9711` reached by two formulas on lane 1, `9850 + lane` reused by four tests). Under `workers: 2` two
mints of one number overwrote one cookie file: the loser drove, and at teardown deleted rows of, the
other's person. That reads as `no box`, an empty page or a `linkInvalid` on a person the spec never made.

- Take the person from `mintDisposablePerson(baseUrl)` in `e2e/fixtures.ts`. It writes a UUID-named file
  (`MINT_SESSION_FILE`), so no number exists to collide. Never hand-pick an offset.
- `linkInvalid` has a second cause, measured the same day: Auth answered `429 over_request_rate_limit`
  under a full run (5 of 5 mint failures in one run). The route logs it as
  `magic link verification failed linkInvalid AuthApiError · 429 · over_request_rate_limit`. Read that
  line before blaming a collision. A full `check:e2e` mints about 20 people; leave the lane idle a few
  minutes after one.
- The user raised Auth → Rate Limits → token verifications to 300 per 5 minutes on 2026-09-29. A 429 at that limit means one sign-in per worker (`e2e/fixtures.ts`), not a higher limit.
- Save `private/playwright-results` and that log line the first time. No retry: `retries: 0` stays.
- Measured 2026-09-29 (module 98), lane 5, full `check:e2e`, 2 workers: **43 verifications before, 6 after**
  (42 disposable people plus the lane's own, down to the lane's own plus what `escritorio.spec.ts` mints per
  worker). Two full runs after: 207 passed, 0 skipped, 0 failed, no `over_request_rate_limit` in the server log.
  Before, one run was 203 passed and 1 failed (`tema.spec.ts`, no `linkInvalid`).
- Take the person from the `person` fixture in `e2e/fixtures.ts`: one mint per worker (`workerPerson`), and its
  rows are deleted before each test. Isolation is by rows, not by person. Never call `mintDisposablePerson` in
  a test body; a new spec that needs a person with no history takes `person`.
- Still minting, on purpose: `escritorio.spec.ts`'s `world` and `desk` fixtures. They are already worker-scoped
  and seed rows that must outlive a test, which the `person` fixture would delete. Any spec that needs
  `auth.users.created_at` fresh or tests sign-in itself would also mint; none does today.

### `page.goto` returns with the loading fallback still standing

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

`load` fires with `(app)/loading.tsx` up; the real page sits in a hidden streamed `div` with no box. A box, a style or a
count read straight after `goto`, `waitForURL` or `reload` measures the skeleton or nothing. `evaluate` waits for a node to
attach, not to be visible.

- Footprint 1, measured 2026-09-29 in `pulsar-e2e` on CI: nine layout specs at 1024 and 1280 failed on `integracion`
  (`no box`, widths of 0, ``locator('main') resolved to 2 elements``) and passed 182/0 locally and on a never-used lane. The
  failure's `error-context.md` showed `main` holding the skeleton beside the streamed page. The runner reaches the database
  slower, so the Suspense boundary swaps late. A fresh identity was not the cause.
- Footprint 2, measured 2026-10-08 on CI run 37823517494, `[mobile] e2e/columnas-espacio.spec.ts:26`: `Expected: >= 4`,
  `Received: 0` at `:33`; the 1024 twin passed 1.5 s earlier on the same shard. `siblingRects` ran `evaluate` right after
  `goto` and the children were still zero-sized. Footprint: `private/ci-reds/425/columnas-espacio-footprint.txt` in the main
  checkout. The same day: `metas-barrido:33`, `campo-chip:44-52`, `plan-ritmo:250` (`private/ci-reds/flakes-2026-10-08/`).
- Do: call `settled(page)` from `e2e/fixtures.ts` before the first measure, or `visit(page, url)` for `goto` + `settled`.
  `settled` is `expect(main).toHaveCount(1)`, then `toBeVisible()`, then `document.fonts.ready`. The count rule comes
  first: a strict `main` locator throws on the two `main`s of the skeleton and the page.
- Never retry, sleep or `waitForTimeout` to buy quiet. Save `private/playwright-results/` before rerunning.
- Read the artifact `pulsar-playwright-results` (`gh run download <id> -n pulsar-playwright-results`, from inside the repo)
  before guessing at a red the local suite does not show.

### A pulsar lane has no member identity, so `check:goal-actions` dies there

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- Measured 2026-09-30, module 100: in a lane opened with `--app goallog`, `check:goal-actions` ran 18/2.
  Both reds said `no member identity — run harness:token for this lane`. The member is minted by
  orbit's `harness:token`, and that lane has no `apps/homefund/.env.local`.
- Run `npm run harness:token -w apps/homefund` with the lane's `HARNESS_LANE` from the main checkout,
  which has `apps/homefund/.env.local`. Never insert the member into `auth.users` by hand: a row outside
  `@repo/harness-registry` is a leak nothing prunes.
- Lane 1's member is `harness-member@example.invalid`, with no number. Until 2026-09-30
  `check-goal-actions.ts` looked for `harness-member-1@…` and went red 18/2 on lane 1 too.

### The dev badge sits over the desktop rail's toggle, and Playwright reports it as an overlay

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- **What.** Under `next dev`, `<nextjs-portal>` holds the always-present Dev Tools badge, bottom-left by
  default: a 32 px button at x 22–54, y 746–778 at 1280×800. The rail's face toggle is at x 26–70,
  y 738–782, so `marco-escritorio.spec.ts:31` timed out on «subtree intercepts pointer events».
- **Measured 2026-09-30, `apps/goallog`.** No error dialog, no issues count, aria-label
  «Open Next.js Dev Tools», zero errors or warnings in the dev log and console. CI runs a production
  build, which has no badge, so it stayed green.
- **Do.** Keep `devIndicators: { position: "bottom-right" }` in `apps/goallog/next.config.ts`. Never set
  `devIndicators: false`: errors would stay, but the badge is how a dev sees a real issue count.
- **Also on the phone.** Bottom-right is the Metas tab's corner at 360: a spec that taps it (`varias-metas.spec.ts:16`)
  reads «`<nextjs-portal>` subtree intercepts pointer events» under `next dev`, with no error behind the badge.
  Measured 2026-10-06. Run the e2e against `npm run build` + `next start`, as `playwright.config.ts` says; never click `force`.

### A local stack per runner runs `pulsar-e2e` in 1.8 min and exposes a spec the remote hid

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- **What.** Module 227 moved the six suite jobs of `ci.yml` onto the runner's own Supabase stack.
  PR #396's first run on it:
  - `pulsar-e2e`: 310 passed, 1 failed, 1.8 min. On the remote it took ~14 min.
  - `voyager-e2e`: green.
  - `pulsar-policies`: green.
- **The one red was a real defect.** `deshacer.spec.ts:47` used `getByLabel("cantidad")`. Module 204's back link
  carries `aria-label="Volver a Meta cantidad …"`, so the locator matched two elements. Fixed in PR #397.
- **Measured 2026-10-05.** The ~14 min was contention and round trips to the remote pooler, not the suite.
  The `linkTimeout`, `CONNECTION_ENDED` and `57014` reds listed above came from that sharing.
- **Do.** Read a red on the local stack as the branch first: no other lane or run touches that database.
  Skip the load explanations above for CI.
  Keep them for lanes and for the RNF-09 timing, which still read the remote project.

### `check:mcp` needs a dev server started a certain way, and a session of its own

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- `scripts/mcp/route.ts` and `oauth-flow.ts` read the server log at `apps/goallog/private/dev<port>.log` (port `3200 + lane - 1`)
  and assert a `[outbound]` line. Nothing in the app writes it: the server must start with the fetch hook
  `NODE_OPTIONS='--import data:text/javascript,const%20f=fetch;globalThis.fetch=(i,o)=>{console.log(%22[outbound]%22,String(i.url??i));return%20f(i,o)}'`.
  Without it, 23 tests fail with «the server log does not show outbound calls»; without the server, 39 fail with `fetch failed`.
- `oauth-flow.ts` also runs green against `next build` + `next start`, measured 2026-10-14 (11 of 11). `next build` bakes
  `NEXT_PUBLIC_SITE_URL` in as the issuer, so build with it set to the server's own origin, inside `scripts/supabase-local.sh
  exec` (outside, the remote Supabase URL is baked in): `NEXT_PUBLIC_SITE_URL=http://localhost:3208 npx next build`, then
  `npx next start -p 3208 > private/967/server.log 2>&1` with the same `NODE_OPTIONS` hook, then run the file with
  `PULSAR_SERVER_LOG=private/967/server.log NEXT_PUBLIC_SITE_URL=http://localhost:3208`. A server built with another issuer fails the
  metadata test and names `NEXT_PUBLIC_SITE_URL`; a missing log fails its first test and names `PULSAR_SERVER_LOG`.
- `scripts/harness/checks-run.ts` runs `check:day`, `check:goal`, `check:goal-actions`, `check:plan` — not `check:mcp`.
  CI's `pulsar-checks` runs it in a step of its own, after a bare `harness:mint-session` (`route.ts` reads
  `private/session-<lane>.json`, which `checks-run.ts` drops with its run). Locally, mint the session the same way first.
  Measured 2026-10-05: `read-tools.ts` expected `list_goals` at 2 statements; module 210 (tren 5) made `/metas` read the
  evidence beside the goals, 4 statements, and the red sat unseen through trains 5, 6 and 7, because no CI ran it then.
- A lane opened with `--app goallog` has no member identity until `HARNESS_LANE=<n> scripts/supabase-local.sh exec npm run
  harness:token -w apps/homefund` runs from the main checkout; `harness:mint-session` makes the person only. Without it
  `check:plan` reports 14 reds («no member identity») that read like regressions. Measured the same day in lanes 4 and 5.

### claude.ai's client metadata lists a grant pulsar does not offer

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- `https://claude.ai/oauth/mcp-oauth-client-metadata` declares `grant_types` with a third entry,
  `urn:ietf:params:oauth:grant-type:jwt-bearer`. A schema that takes `z.enum` of the grants it serves refuses the whole
  document, and `/oauth/autorizar` reads «Este pedido no es válido» on the first real connection.
- Every local probe registered its own clean document, so nothing caught it before production. Measured 2026-10-06 by the
  user's first connection from claude.ai (module 200), fixed in module 287: ignore unknown grants, require the code grant.
- Fetch the real document before trusting a schema that parses someone else's metadata.

### Next's route announcer is an alert

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- `node_modules/next/dist/client/components/app-router-announcer.js` renders `<next-route-announcer>` with an open shadow
  root holding `role="alert"`, filled with the new title after a client navigation. Playwright's `getByRole` pierces open
  shadow roots, so it counts that node as an app alert.
- Measured 2026-10-06: CI run 37524876363 failed `importar-revisar.spec.ts:84` at line 100,
  `getByRole('alert').filter({ hasText: /\S/ })` counting 1. Locally it never reproduced: it is timing.
- Count app alerts with `appAlerts(page)` from `apps/goallog/e2e/fixtures.ts`, never `getByRole('alert')` on the page.
  `anunciador.spec.ts` shows both counts after a client navigation.

### A whole-page absence on the shared person is a race

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- `personId` (`e2e/fixtures.ts`) is one person per lane, shared by both workers and every spec. A test that asserts
  «nothing else is here» on it fails whenever another spec seeds for it at the same moment.
- Assert an absence or an exact count only on the disposable `person`. Measured 2026-10-06: `dia-pasado.spec.ts:314`
  and `dia-pasado-hechos.spec.ts:105` passed one CI run and failed the next on the same tree.
- Match a date's words with `\p{L}` and the `u` flag, never `\w`: `\w` is ASCII and skips «miércoles» and «sábado»,
  so on those days a header spec measured the «hechos 0 de 6» tally instead (75 px off, 2026-10-07). Drive the longest
  date by rewriting the eyebrow's text, so the check never waits for a Wednesday.
- Read `docs/goallog/SPEC.md` before "fixing" an order a spec expects. On 2026-10-07 a red e2e asked «most recent
  first» for `ended_this_week`; the query was changed to `horizon desc` and broke three `check:day`/`check:plan`
  assertions that pin RP-47's plan order. The e2e followed a DESIGN line RP-47 had superseded; it was the spec that was wrong.
  The e2e only failed from a Wednesday, the first weekday that draws two endings.

### A `pulsar-e2e` shard dies before its first test: port 54322 already in use

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

The shard's `supabase start` fails with `failed to bind host port for 0.0.0.0:54322:172.18.0.2:5432/tcp: address already
in use`, the job goes red with no spec run, and `pulsar-e2e-report` follows it red.

- Seen 2026-10-09, run 37980310112, shard 1 of 4, on a branch whose other three shards were green. The log is in
  `private/reportes/ci-37980310112-shard1-puerto-54322.log`.
- It is the runner, not the branch. Read the shard's setup step before any spec: no `✘` line means nothing ran.
- `gh run rerun <id> --failed` and read the rerun before merging.

### A pulsar spec named `*caida.spec.ts` never runs in the mobile project

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- `apps/goallog/playwright.config.ts` makes `mobile` ignore `(caida|fuente-caida|importar-modelo)\.spec\.ts`, unanchored, so
  any new file ending in `caida.spec.ts` is ignored there too. It runs only if the `caida` or `fuente-caida` project
  matches it; otherwise Playwright says «No tests found» and the module looks covered.
- Measured 2026-10-09, cierre parte 2. Name a new spec something else, or add it to a project by name.

### `page.content()` always holds every interface string

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._
- `NextIntlClientProvider` in `apps/goallog/app/layout.tsx` ships the whole message catalogue in each page's payload.
- `expect(await page.content()).not.toContain("<copy>")` cannot pass, whatever the screen paints.
- Assert absence on what is drawn: `getByText(...).toHaveCount(0)` or `locator("body").innerText()`.
- Measured 2026-10-10, module 723: `meses-km.spec.ts:165` stayed red with the feature correct; the only match was the raw
  `month.list.empty` message.

### Chromium print ignores `break-*: avoid` between siblings

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._
- `page.pdf()` (Chromium) ignores `break-before/after: avoid` between a `<table>`'s last row and the block after it, and
  between grid items. Wrappers (grid, flex, padded box, second `tbody`) did not help.
- What it honours: `break-inside: avoid` on the container, and `break-before: avoid` on a row inside the same `tbody`.
- So pulsar's months-left-out line is the table's last `<tr data-row="months-out">` (`Table` prop `after`,
  `apps/goallog/components/ui/table.tsx`), and a goal's head stays with its table through `PrintGoal whole`.
- Measured 2026-10-10, modules 802 and 803: a 26-position sweep left the line alone at 2 cuts, and a 48-test sweep left
  the head alone at 8, until moved inside. Prove a break rule with a sweep that moves the cut, never one PDF.

### A mutation on the week line survives on a Sunday

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._
- Pulsar's server, its seeds and the specs read the real clock; there is no `faketime`. Three specs skip their week branch
  on a Sunday or a Monday, so every mutation on «hasta el miércoles», «del sábado al martes» or «en curso» survives that day.
- Measured 2026-10-11, the train 7 mutator: W5, W6, M1, M2, M4–M6, M8 and M9 lived, all on the week line, run on a Sunday.
- Read a survivor's date before calling it a gap. Run the week mutations on Tuesday to Saturday, or pin the clock with
  `PULSAR_CLOCK` (next entry).

### A mutation that only bites on some days: run it under PULSAR_CLOCK

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._
- `PULSAR_CLOCK=YYYY-MM-DD` pins «today» for pulsar's server (`todayInZone`), the browser (a `pulsar-clock` meta the
  signed-in layout draws), the specs and `seed-goal.ts`. Export it once for the server and the spec run alike:
  `export HARNESS_LANE=6 PULSAR_CLOCK=2026-10-21; PORT=3205 scripts/supabase-local.sh exec npm run start -w apps/goallog`,
  then `PULSAR_BASE_URL=http://localhost:3205 scripts/supabase-local.sh exec npm run check:e2e -w apps/goallog -- --project=mobile <spec>`.
- It is honoured only beside a loopback `DATABASE_URL` and never with `VERCEL`; anywhere else `next.config.ts` refuses to
  build or boot and `todayInZone` throws. A bare `next start` in a lane reads `.env.local`, the remote, and refuses.
- SQL stays on the real clock: `created_at`/`archived_at`/`retired_at` defaults, token expiry, `model_calls.day` and the
  `one_offs` policy and triggers that refuse editing a past one-off (`day > now() at time zone …`). A clock ahead of today
  lets the database edit what the app calls past; a clock behind refuses what the app calls future.
- Specs that compute a day from `new Date()` instead of `todayInZone()` stay on the real clock under it.
- Measured 2026-10-11, module 841: under `2026-10-21` the pace line drew; `hoy-unidad-una-vez.spec.ts` went green, and red
  with `bare` dropped from its Figure. `meta-unidad-una-vez.spec.ts:43` is red under it with or without the mutant: its
  `innerText` puts a line break after the Figure's unit span (a flex item), so «búsquedas , bajo» never matches. Read
  `textContent` in a spec that matches across a Figure.

### A lane's fault server on another lane's port

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._
- `PULSAR_FAULT_BASE_URL` names a port; a worker that picks :320<m> for it squats lane m's port, and lane m's worker kills it.
- Measured 2026-10-11: lane 4 ran its fault server on :3205 (lane 6's); lane 6's `fuser -k 3205/tcp` killed it mid-run.
- Run a lane's fault server on :321<n-1> (lane 4 → :3213). Say it in every dispatch that may need one.

### A check that counts days in UTC goes red every night

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._
- From 19:00 in Bogotá the UTC date is already tomorrow. `new Date(Date.now() + …).toISOString().slice(0, 10)` then names a
  day the app, which counts in the zone (`todayInZone()`), has not reached.
- Measured 2026-10-11: CI at 22:52 Bogotá set a goal's horizon to «today» in UTC, the app read it as tomorrow, and
  `check:mcp` `read-tools.ts` went 2 red on a train that never touched it. Locally the same hour: 16/2 before, 18/0 after.
- Count a check's days from `todayInZone()`, never from `Date.now()`.

### A hand-written savepoint does not recover a postgres-js transaction

Measured 2026-10-13, module 898 (`apps/goallog/app/actions/import.ts`). Writing `savepoint p` / `rollback to savepoint p` by hand
inside `db.transaction` looks right and fails: postgres-js remembers the first error and re-raises it when the outer `begin`
ends, so the whole import still rolls back. Nest `tx.transaction(async (sp) => …)` instead: drizzle issues the savepoint and the
driver forgets the error it caught. The fast path stays one transaction; the nested ones run only after a class-23 refusal.

### `supabase-local.sh exec` blanks the app's OpenAI key

Measured 2026-10-13, module 903. The wrapper exports `OPENAI_API_KEY=` (empty) so no suite reaches OpenAI, and an exported
variable wins over `.env.local`: a dev server started through it answers 503 `noKey` even with the key in the lane's
`apps/goallog/.env.local`. A deliberate paid read needs the server started with the key read from `.env.local` inside the exec.
That 503 calls no model, so a forgotten key costs nothing but the confusion.

### Two `<main>` while a client redirect lands

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._
- 2026-10-14, module 975, `apps/goallog/e2e/metas-sin-final-seed.ts` (`visit`). CI run 38620980911, `meta-ritmo-unidad.spec.ts:159` at 360:
  `/metas/{id}/plan` redirects to `/metas/{id}`, and for a moment the old and the new `main` are both in the DOM. `toHaveCount(1)` passed
  on one instant and `toBeVisible()` ran on the next, strict-mode failing on two. The two lines are not atomic. It failed once in CI and 1 in 20 locally (`--repeat-each=10` at both widths).
- Waiting for the final URL alone did not cure it: the 1-in-20 still failed with two `main` after `toHaveURL`, both carrying the goal's content.
- Count `main:visible` in one assertion (`toHaveCount(1)`) after awaiting the final URL; `visit` takes `lands` for a route that redirects.
  Never answer it with a retry or a sleep.

### `pulsar-fechas` is red in every pinned date: the app writes the real day (2026-10-15)

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- Pending, not fixed. CI run 38757787894 on `infra-tren`: every `dates (...)` cell red; the `monday` cell (`PULSAR_CLOCK=2026-10-12`) ended `43 failed, 216 passed`.
- First failure, `e2e/dia-pasado.spec.ts:109` (RP-06, RP-05), line 125: `expect(row).toContainText(writtenLabel(todayInZone()))`.
  - `Expected substring: "anotado el lunes 12"`
  - `Received string: "Compromiso día pasado 1792077200692todos los días · 10:13 · lo dijiste tú · anotado el jueves 15"`
- The spec reads the pinned day (`todayInZone()`) and the screen prints the real one (jueves 15): something that stamps «anotado» (the fact's written-at) does not go through `PULSAR_CLOCK` (`apps/goallog/lib/zone.ts`). Other reds in the same cell: `dia-pasado.spec.ts:145` and `:204`, `hoy-palabras.spec.ts:92`, `hoy-sistema.spec.ts:144`, `meta-mes.spec.ts:373` and `:421`, `meta-ritmo-unidad.spec.ts:175`.
- The red cells took 12 min each on 5 s timeouts. Chase it with one date and one spec, locally, with `PULSAR_CLOCK=2026-10-12`. Log: `private/ci/infra-38757787894.log`, grep `dates (monday)`.
- Until fixed, the nightly run (`pulsar-calendario.yml`) is red by design of the bug, not of the night.

### A pulsar e2e PR run proves nothing: `pulsar-e2e` runs on push and dispatch only (2026-10-16)

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._
- PR #620's run was green with `pulsar-e2e` skipped (`.github/workflows/ci.yml:307`, `github.event_name != 'pull_request'`); the new spec never ran.
- Dispatch `gh workflow run CI --ref <branch>` before merging any pulsar change that touches a spec.

### A harness script that reads every cookie as the session breaks on a new cookie (2026-10-17)

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- `apps/goallog/scripts/check-day.ts` joined every cookie of the minted session file and parsed the result as the
  Supabase session. Train codigo-6b made `/auth/confirm` also set `goallog-signed-in-at`; the minter keeps every
  `Set-Cookie` of the landing, so the join stopped being JSON.
- Measured 2026-10-17, CI run 39071089606: `pulsar-checks` red, «session-7.json carries a cookie that is not a session»;
  every lane's local `check:day` passed because their session files were minted before the change. Re-minting lane 4
  reproduced it; filtering on `-auth-token` (c0df782c) made it pass.
- Do: read a session only from the cookies whose name holds `-auth-token`. Re-mint a lane's session after a change to
  `/auth/confirm`, before trusting a local `check:*`.

### A server action that redirects rejects its promise on the client (2026-10-17)

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- `verifySignInCode` in GoalLog ends a good code with `redirect()`. On the client the awaited action rejects with
  `NEXT_REDIRECT`; a bare `catch` around it swallows the landing and paints the offline words instead.
- Measured 2026-10-17, train codigo-6c M8: a bare catch in `handleVerify` turned the «Done · /entrar» and «Done ·
  consent» rows of `apps/goallog/e2e/entrar-codigo.spec.ts` red (the pending record was never cleared). Calling
  `unstable_rethrow(error)` first (`next/navigation`) made them green, 27/27.
- Do: open every client `catch` around a server action that may `redirect()` with `unstable_rethrow(error)`. A catch
  around an action that only returns needs none.

### Next runs a page's server actions one at a time (2026-10-17)

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- A server action whose request hangs blocks every later server action from the same page: the next tap is queued
  behind it, so a timeout on the client frees the button but the second send stays on «Enviando…» until the first call
  ends. A redirect from the abandoned call still lands when it finally answers.
- Measured 2026-10-17, train critic-6c M7 (`apps/goallog/e2e/entrar-sin-respuesta.spec.ts`, tester report
  `private/lanes/l4-close/reportes/tester-m7.md`): after a timed-out send, a second «Enviar código» showed «Enviando…»
  until the hung call returned; a good code answered after the 8 s race still landed on `/` with one session.
- Do: a client timeout only changes the words and frees the controls; it never assumes the call ended. Keep the
  "in flight" flag until the original promise settles, so a late landing clears its pending record.

### A long `idle_timeout` keeps every test process alive

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

Measured 2026-10-19 on GoalLog (`check:plan`). `apps/goallog/db/client.ts` sets `idle_timeout: 240` (RNP-02). A test file
that reaches the app's code opens that pool and ends only its own `sql`, so `node --test` waits ~240 s for the idle
sockets per file: pass 2 took 1927 s for 31 s of tests.

- Preload `scripts/harness/end-app-pool.ts` with `--import`; it ends `globalThis.sql` in a root `after()`.
- Never lower the timeout for tests: `settle-pipeline.ts` asserts 240.
- Never use `--test-force-exit`: under `--experimental-test-module-mocks` it drops tests (561 to 533).

### A wire check that reads a statement's parameters breaks when that statement is inlined

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

- `check:day` and `check:goal` named each connection from the settle's `parameters[2]`. M16 sent the settle with
  `.inlineParams()`, so it carries no parameters and every connection read `unknown`. Read the value from the
  statement's text, or from both.
- Measured 2026-10-19: `pulsar-checks` red on CI 39346172548 (`2 connection(s): unknown, unknown`). Local
  `check:plan` never runs these checks; the train's first CI was cancelled before `pulsar-checks` finished.

### A stale `.next/dev` reloads every page of `next dev` without end

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

Measured 2026-10-28, lane 3: after `git checkout` of other commits under a running `next dev`, then a restart,
every GoalLog page reloaded itself ~10 times a second (`[HMR] connected` → `[Fast Refresh] rebuilding` → reload;
912 `✓ Compiled in 2ms` in the log). Specs failed with timeouts and `net::ERR_ABORTED`: 24 of 31 on
`mes-que-viene`, `semana-que-viene` and `semana-atras`, the same on `origin/oleada-8`, so no code caused it.

- Count main-frame navigations of one page for 4 s: more than 2 is this.
- Stop the server, move `apps/<app>/.next/dev` into the lane's `private/`, start again. 31/31 green after.
- Stop the dev server before checking out another commit in its worktree.

### GoalLog's browser suite does not run on a pull request

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

Measured 2026-10-31, runs 41166595127 and 41225242801.

`pulsar-e2e` in `.github/workflows/ci.yml` runs on push to integracion or main and on
`workflow_dispatch`, never on `pull_request`. #709 and #715 merged green on their PRs and left about
560 GoalLog specs red on integracion; nobody saw it until #718. #729 repaired them.

- Before merging a GoalLog PR, run `gh workflow run ci.yml -R WAB-Studio/shelf --ref <branch>` and wait
  for every `pulsar-e2e (n)` shard.

### A probe archived «now» stays in the week on a Sunday

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

Measured 2026-11-01, a Sunday: `check:day` went red on `integracion` (f58d8d78) and on #751 alike with
«an archived goal is not in loadWeek's goals». `loadWeek` keeps a goal archived on its week's own Sunday (RP-24,
`lib/queries/rows.ts:127` compares with `>=`); `scripts/check-day.ts` archived its probe with `new Date()`.

- Seed an archive, an end or a retirement a full week before the day under test, never at now.
- A date check that passes six days of seven proves nothing: read the rule's boundary and seed past it.

### A spec that names a month as today's month breaks in November and on the 1st

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

Measured 2026-11-01, a Sunday and a month's first day: 18 GoalLog specs went red on `integracion` at once.

- Chained `replaceAll("2026-10", first).replaceAll("2026-11", second)` rewrites `first` again when it is 2026-11. Move months in one pass.
- A month in another year is said with it («enero de 2027»): derive a label's year from today, never drop it.
- Ended today means its last day is yesterday: on the 1st that is last month. Seed a task before the fact it carries.
- The runner's `pdftotext` splits a kerned pair («f ebrero»): compare paper text without spaces.

### A row's height on paper moves by a pixel with its place on the page

_Archived 2026-11-19: GoalLog retired, its suite and checks are gone._

Measured 2026-11-02: `papel-fila-detalle.spec.ts:313` read a row 30.75pt on 2 November and 31.5pt on 1 November (`PULSAR_CLOCK`), against 32.25 ± 0.8. Chromium snaps each row to a whole CSS pixel (0.75pt), and the day moves the table down the A4 page.

- Measure a printed row with at least two pixels of slack (1.5pt) plus float noise; a real regression is a line of text, 15pt.
- Reproduce a date-dependent paper failure with `PULSAR_CLOCK=YYYY-MM-DD` on the server and the spec.
