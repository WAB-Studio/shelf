# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: crear-dentro-aviso.spec.ts >> on a goal with a rhythm the sheet says it stops counting, above «Abrirla»; the new goal measures in the parent's unit
- Location: e2e/crear-dentro-aviso.spec.ts:37:5

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByText('esta meta no mide nada')
Expected: 0
Received: 1
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" with timeout 5000ms
  - waiting for getByText('esta meta no mide nada')
    14 × locator resolved to 1 element
       - unexpected value "1"

```

# Test source

```ts
  1  | import type { Browser } from "@playwright/test";
  2  | import type postgres from "postgres";
  3  | 
  4  | import { horizonForWeeks } from "@/lib/day/weeks";
  5  | import { todayInZone } from "@/lib/zone";
  6  | 
  7  | import { test, expect } from "./fixtures";
  8  | 
  9  | // Module 900, clause 5 (board CrearDentroAviso): the create-inside sheet says the upper goal's rhythm stops
  10 | // counting, only when it has one, and the new goal measures in the parent's unit.
  11 | 
  12 | type Db = postgres.Sql;
  13 | 
  14 | async function seedPair(db: Db, personId: string, name: string, rhythm: number | null) {
  15 |   const [general] = await db<{ id: string }[]>`
  16 |     insert into goals.goals (user_id, name, horizon) values (${personId}, ${`General ${name}`}, ${horizonForWeeks(todayInZone(), 30)}::date)
  17 |     returning id`;
  18 |   const [large] = await db<{ id: string }[]>`
  19 |     insert into goals.goals (user_id, name, horizon, parent_id, measure_name, measure_unit, rhythm)
  20 |     values (${personId}, ${name}, ${horizonForWeeks(todayInZone(), 11)}::date, ${general.id}, 'estudio', 'minutos', ${rhythm})
  21 |     returning id`;
  22 |   return large.id;
  23 | }
  24 | 
  25 | async function openSheet(browser: Browser, baseURL: string, sessionFile: string, goalId: string) {
  26 |   const context = await browser.newContext({ storageState: sessionFile, baseURL, viewport: { width: 360, height: 900 } });
  27 |   const page = await context.newPage();
  28 |   await page.goto(`/metas/${goalId}`);
  29 |   await page.getByRole("button", { name: "Agregar meta pequeña" }).click();
  30 |   const sheet = page.getByRole("dialog");
  31 |   await expect(sheet).toBeVisible();
  32 |   return { context, page, sheet };
  33 | }
  34 | 
  35 | const lineOf = (name: string) => `El ritmo al mes de «${name}» deja de contar; la meta nueva mide como ella.`;
  36 | 
  37 | test("on a goal with a rhythm the sheet says it stops counting, above «Abrirla»; the new goal measures in the parent's unit", async ({ person, browser, baseURL, db }) => {
  38 |   // Kills: no warning line; line placed after the buttons; createGoal not carrying the parent's unit (the new goal «no mide nada»).
  39 |   const name = `Diseño ${Date.now()}`;
  40 |   const parentId = await seedPair(db, person.id, name, 720);
  41 |   const { context, page, sheet } = await openSheet(browser, baseURL!, person.sessionFile, parentId);
  42 |   try {
  43 |     const line = sheet.getByText(lineOf(name), { exact: true });
  44 |     await expect(line).toBeVisible();
  45 |     const open = sheet.getByRole("button", { name: "Abrirla", exact: true });
  46 |     expect((await line.boundingBox())!.y).toBeLessThan((await open.boundingBox())!.y);
  47 | 
  48 |     const child = `Línea base ${Date.now()}`;
  49 |     await sheet.getByLabel("nombre").fill(child);
  50 |     await sheet.getByLabel(/^semanas, contando la del /i).fill("4");
  51 |     await open.click();
  52 |     await page.waitForURL((url) => /\/metas\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(parentId));
  53 |     await expect(page.getByRole("main").getByText(child, { exact: true })).toBeVisible();
> 54 |     await expect(page.getByText("esta meta no mide nada")).toHaveCount(0);
     |                                                            ^ Error: expect(locator).toHaveCount(expected) failed
  55 |   } finally {
  56 |     await context.close();
  57 |   }
  58 | });
  59 | 
  60 | test("on a goal with no rhythm the sheet draws no such line", async ({ person, browser, baseURL, db }) => {
  61 |   // Kills: the line shown for every goal, not only those with a rhythm.
  62 |   const name = `Sin ritmo ${Date.now()}`;
  63 |   const parentId = await seedPair(db, person.id, name, null);
  64 |   const { context, sheet } = await openSheet(browser, baseURL!, person.sessionFile, parentId);
  65 |   try {
  66 |     await expect(sheet.getByRole("button", { name: "Abrirla", exact: true })).toBeVisible();
  67 |     await expect(sheet.getByText("deja de contar")).toHaveCount(0);
  68 |   } finally {
  69 |     await context.close();
  70 |   }
  71 | });
  72 | 
```