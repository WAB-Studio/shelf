# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: varias-metas.spec.ts >> the Metas tab opens the goals list, and a second goal is opened from it, not typed (RP-11)
- Location: e2e/varias-metas.spec.ts:16:5

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByRole('navigation').getByRole('link', { name: 'Metas', exact: true })
    - locator resolved to <a href="/metas" class="bottom-nav-module__e36fZq__link">Metas</a>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <nextjs-portal></nextjs-portal> from <script data-nextjs-dev-overlay="true">…</script> subtree intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <nextjs-portal></nextjs-portal> from <script data-nextjs-dev-overlay="true">…</script> subtree intercepts pointer events
    - retrying click action
      - waiting 100ms
    56 × waiting for element to be visible, enabled and stable
       - element is visible, enabled and stable
       - scrolling into view if needed
       - done scrolling
       - <nextjs-portal></nextjs-portal> from <script data-nextjs-dev-overlay="true">…</script> subtree intercepts pointer events
     - retrying click action
       - waiting 500ms

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - main [ref=e3]:
      - generic [ref=e4]:
        - generic [ref=e5]:
          - generic [ref=e6]: lunes 12 de octubre
          - button "Cambiar a modo oscuro" [ref=e11]
        - heading "Hoy" [level=1] [ref=e15]
        - paragraph [ref=e16]:
          - text: hechos
          - generic [ref=e17]: "0"
          - text: de
          - generic [ref=e18]: "6"
      - generic [ref=e19]:
        - generic [ref=e22]:
          - generic [ref=e23]: Inglés B1/B2 → B2+ laboral
          - generic [ref=e24]:
            - paragraph [ref=e25]: "fase 1 de 3 · Desbloquear la boca: perder el miedo a hablar y pasar de 2 a 4 minutos de monólogo sin congelarse."
            - button "Anki todos los días · 10 min" [ref=e26] [cursor=pointer]:
              - generic [ref=e30]:
                - generic [ref=e31]: Anki
                - generic [ref=e32]:
                  - text: todos los días ·
                  - generic [ref=e33]: 10 min
            - button "Shadowing todos los días · 15 min" [ref=e34] [cursor=pointer]:
              - generic [ref=e38]:
                - generic [ref=e39]: Shadowing
                - generic [ref=e40]:
                  - text: todos los días ·
                  - generic [ref=e41]: 15 min
            - button "Monólogo grabado todos los días · 10 min" [ref=e42] [cursor=pointer]:
              - generic [ref=e46]:
                - generic [ref=e47]: Monólogo grabado
                - generic [ref=e48]:
                  - text: todos los días ·
                  - generic [ref=e49]: 10 min
            - 'button "Cerrar el ciclo: tarjetas de los errores todos los días" [ref=e50] [cursor=pointer]':
              - generic [ref=e54]:
                - generic [ref=e55]: "Cerrar el ciclo: tarjetas de los errores"
                - generic [ref=e56]: todos los días
            - button "Bloque variable del día lun, mar, mié, jue y vie" [ref=e57] [cursor=pointer]:
              - generic [ref=e61]:
                - generic [ref=e62]: Bloque variable del día
                - generic [ref=e63]: lun, mar, mié, jue y vie
            - button "Buscar palabras nuevas mientras leo 1 búsqueda" [disabled] [ref=e64]:
              - generic [ref=e68]:
                - generic [ref=e69]: Buscar palabras nuevas mientras leo
                - generic [ref=e70]: 1 búsqueda
            - generic [ref=e71] [cursor=pointer]:
              - 'button "Marcar como hecho: Grabar el audio de referencia (semana 1)" [ref=e72]'
              - button "Grabar el audio de referencia (semana 1)" [ref=e74]
              - button "Escribir una nota en «Grabar el audio de referencia (semana 1)»" [ref=e79]
            - generic [ref=e86]:
              - generic [ref=e87]: Una tarea de Inglés B1/B2 → B2+ laboral
              - textbox "Una tarea de Inglés B1/B2 → B2+ laboral" [ref=e89]:
                - /placeholder: Una tarea de Inglés B1/B2 → B2+ laboral…
        - generic [ref=e90]:
          - generic [ref=e93]:
            - generic [ref=e94]: este mes
            - generic [ref=e96]:
              - paragraph [ref=e97]: Inglés B1/B2 → B2+ laboral
              - generic [ref=e98]:
                - generic [ref=e99]:
                  - text: "0"
                  - generic [ref=e100]: min
                - generic [ref=e101]: · 0 de 1 tarea
          - generic [ref=e103]:
            - generic [ref=e104]: Sueltas
            - generic [ref=e110]:
              - generic [ref=e111]: Algo suelto
              - textbox "Algo suelto" [ref=e113]:
                - /placeholder: Escribe algo suelto...
    - navigation [ref=e114]:
      - generic [ref=e115]:
        - link "Hoy" [ref=e116] [cursor=pointer]:
          - /url: /
        - link "Semana" [ref=e117] [cursor=pointer]:
          - /url: /semana
        - link "Mes" [ref=e118] [cursor=pointer]:
          - /url: /mes
        - link "Metas" [ref=e119] [cursor=pointer]:
          - /url: /metas
  - button "Open Next.js Dev Tools" [ref=e125] [cursor=pointer]
  - alert [ref=e129]
```

# Test source

```ts
  1  | 
  2  | import type postgres from "postgres";
  3  | 
  4  | import { test, expect } from "./fixtures";
  5  | 
  6  | // Seeded by `harness:seed-goal`, the one goal this identity always carries
  7  | // (`compromiso.spec.ts`'s own constant, word for word) — this suite never
  8  | // touches it, only ever the second goal it opens beside it.
  9  | const SEEDED_GOAL_NAME = "Inglés B1/B2 → B2+ laboral";
  10 | 
  11 | async function deleteGoal(db: postgres.Sql, personId: string, goalId: string): Promise<void> {
  12 |   await db`delete from goals.commitments where goal_id = ${goalId} and user_id = ${personId}`;
  13 |   await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  14 | }
  15 | 
  16 | test("the Metas tab opens the goals list, and a second goal is opened from it, not typed (RP-11)", async ({
  17 |   page,
  18 |   db,
  19 |   personId,
  20 | }) => {
  21 |   await page.goto("/");
> 22 |   await page.getByRole("navigation").getByRole("link", { name: "Metas", exact: true }).click();
     |                                                                                        ^ Error: locator.click: Test timeout of 30000ms exceeded.
  23 |   await page.waitForURL("**/metas");
  24 | 
  25 |   // The seeded goal is already listed — this list never redirects past it —
  26 |   // and its own way to open a second sits under it.
  27 |   await expect(page.getByRole("link", { name: SEEDED_GOAL_NAME })).toBeVisible();
  28 |   const addAnother = page.getByRole("link", { name: "Abrir otra meta" });
  29 |   await expect(addAnother).toBeVisible();
  30 |   await expect(addAnother).toHaveAttribute("href", "/metas/nueva");
  31 | 
  32 |   const goalName = `Meta segunda ${Date.now()}`;
  33 |   // The same form `compromiso.spec.ts`'s own `createGoal` drives, reached
  34 |   // here by the tap this module adds rather than by a bare `page.goto`.
  35 |   await addAnother.click();
  36 |   await page.waitForURL("**/metas/nueva");
  37 |   await page.getByLabel("nombre").fill(goalName);
  38 |   await page.getByRole("button", { name: "Abrirla" }).click();
  39 |   await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  40 |   const goalId = page.url().split("/metas/")[1];
  41 | 
  42 |   // Below 1024px Hoy draws a section only for a goal that asks today
  43 |   //: a daily tap commitment makes the new one ask.
  44 |   await db`
  45 |     insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
  46 |     values (${personId}, ${goalId}, 'Tocar la segunda', 'daily', 'tap', now() - interval '3 days')`;
  47 | 
  48 |   try {
  49 |     // The list, with two: neither redirected past, both their own row.
  50 |     await page.goto("/metas");
  51 |     await expect(page.getByRole("link", { name: SEEDED_GOAL_NAME })).toBeVisible();
  52 |     await expect(page.getByRole("link", { name: goalName })).toBeVisible();
  53 |     await expect(page.getByRole("link", { name: "Abrir otra meta" })).toBeVisible();
  54 | 
  55 |     // Both open goals draw on the day (§0.3, 5), grouped, with no selector —
  56 |     // the newly opened one included once it asks something today.
  57 |     await page.goto("/");
  58 |     // A time-unit goal's name also heads its figure card (RP-35): take the section's.
  59 |     await expect(page.getByText(SEEDED_GOAL_NAME, { exact: true }).first()).toBeVisible();
  60 |     await expect(page.getByRole("main").getByText(goalName, { exact: true })).toBeVisible();
  61 | 
  62 |     // Its own screen has a quiet way back to the list: the bottom nav's own
  63 |     // "Metas" tab, already mounted on every signed-in screen, never a second
  64 |     // link this module adds.
  65 |     await page.goto(`/metas/${goalId}`);
  66 |     await page.getByRole("navigation").getByRole("link", { name: "Metas", exact: true }).click();
  67 |     await page.waitForURL("**/metas");
  68 |     await expect(page.getByRole("link", { name: goalName })).toBeVisible();
  69 |   } finally {
  70 |     await deleteGoal(db, personId, goalId);
  71 |   }
  72 | });
  73 | 
  74 | test("an empty week says what to do and links to opening one (RP-11, RP-16)", async ({
  75 |   person,
  76 |   browser,
  77 | }) => {
  78 | 
  79 |   const context = await browser.newContext({
  80 |     storageState: person.sessionFile,
  81 |   });
  82 |   try {
  83 |     const page = await context.newPage();
  84 |     await page.goto("/semana");
  85 | 
  86 |     // The range still draws (`Semana.dc.html` names no board for a goal-
  87 |     // less week, so nothing here says the range itself should hide).
  88 |     await expect(page.getByText(/^Del \d/)).toBeVisible();
  89 |     await expect(page.getByText("Todavía no tienes una meta abierta.")).toBeVisible();
  90 |     const link = page.getByRole("link", { name: "Crear una meta" });
  91 |     await expect(link).toBeVisible();
  92 |     await expect(link).toHaveAttribute("href", "/metas/nueva");
  93 |   } finally {
  94 |     await context.close();
  95 |   }
  96 | });
  97 | 
```