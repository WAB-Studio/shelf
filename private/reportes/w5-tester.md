# W5 tester report

## Tests
Appended to `apps/wordbook/e2e/offline.spec.ts` (all named "W5: ..."), plus `despliegue.spec.ts` CACHE_NAME -> v13 (its 6 cache-name tests go red until sw.js is v13).
1. one cache named reading-shell-v13.
2. 503 on `/` (worker's fetch) reaches the page, does not replace the cached shell; offline `/` draws the box.
3. 500 on `/registro/zzqq` is not stored; offline same address draws the word page (from `/registro/_`).
4. 503 on `/` naming other scripts sweeps no `/_next/static/` key.
5. 307 on `/` (opaque redirect in a navigation) is not stored; offline `/` draws the box.
6. `/?q=book` online (controlled visit) leaves no `?q=` key in any cache.
7. offline `/?q=apple`, never visited, draws "manzana, poma".
8. offline `/?q=book`, visited online (controlled), draws book (regression, green now).
9. install with `/cuenta` 500 stores no 500, completes, `/` opens offline.
Worker-only faults use `request.serviceWorker()` inside `context.route`. Absences use a bounded stability loop (`staysTrue`, 1.5 s) after a positive signal.

## Mutations
Reference sw.js (the contract, `private/w5-ref.patch`) makes all 9 + despliegue green (`private/logs/w5-green.log`). Logs `private/logs/w5-mut-*.log`, `w5-mutations.log`.
| test | mutation | red |
|---|---|---|
| 2, 3, 5 | drop `response.ok &&` in navigate put | expect(...).toBe(true) Received false (3 runs) |
| 4 | retireOtherBuilds without `response.ok` | Received false |
| 6 | drop the `/` + search put exclusion | Received false |
| 7 | remove the `/` fallback | page.goto net::ERR_FAILED /?q=apple |
| 9 | install puts every page (no ok filter) | cached /cuenta status 500 |
| 1 | name back to v12 | toEqual diff |
| 5 | drop `!response.redirected` | SURVIVES (see Uncovered) |
Against the unmodified repo sw.js (v12): 14 of 24 red (`w5-red-final.log`): 8 new tests (all but #8) + 6 despliegue tests. sw.js restored; `git status` shows only the two spec files.

## Uncovered
- `!response.redirected` is not reachable from a page navigation: navigation fetches use redirect "manual", so the worker sees an opaqueredirect (ok false, redirected false). Test 5 is killed by the `ok` check instead; the plan's mutation row for `!redirected` cannot go red. Worker may keep the clause.
- NO_OVERWRITE_ROUTES mutation: left to existing offline.spec :213 and :396 (not rerun by me).
- `activate` dropping v12 with its `?q=` entries: covered only by despliegue's single-cache assertion.
- Install sweep reading `/` only when ok: not separately observable (empty cache at install).
- Regression specs (sin-red-una-visita, registro-sin-red, cuenta-sin-red, url, cuenta-copia) not run by me.

## Deferred
None.
