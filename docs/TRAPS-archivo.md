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
