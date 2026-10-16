import { civilDateShort, todayInZone } from "@/lib/zone";
import { monthOf } from "@/lib/plan/months";
import common from "../messages/es/common.json";
import { test, expect } from "./fixtures";
import exportMessages from "../messages/es/export.json";

const brand = common.brand;

// RNP-01: every page names its place, «{place} · {brand}», and the goal's own
// name never enters a title (it would cost a statement).
test("every page reads «{place} · {brand}», /exportar keeps its dated title", async ({ browser, baseURL, person, db }) => {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
    values (${person.id}, ${`Meta de títulos ${Date.now()}`}, (${todayInZone()}::date + 90), 'minutos', 'minutos')
    returning id
  `;
  const g = `/metas/${goal.id}`;
  const month = monthOf(todayInZone());

  const routes: [string, string][] = [
    ["/", "Hoy"],
    ["/semana", "Semana"],
    ["/mes", "Mes"],
    ["/sueltas", "Sueltas"],
    ["/conexiones", "Conectar una IA"],
    ["/metas", "Metas"],
    ["/metas/nueva", "Meta nueva"],
    ["/metas/importar", "Importar un plan"],
    ["/metas/importar/revisar", "Revisar el plan"],
    [g, "Meta"],
    [`${g}/meses`, "Meses"],
    [`${g}/meses/${month}`, "Mes"],
    [`${g}/meses/${month}/tarea/nueva`, "Tarea nueva"],
    [`${g}/revision`, "Revisión"],
    [`${g}/fases/nueva`, "Fase nueva"],
    [`${g}/compromisos/nuevo`, "Compromiso nuevo"],
    ["/oauth/autorizar", "Permiso"],
  ];

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  for (const [path, place] of routes) {
    await page.goto(path);
    const title = await page.title();
    expect(title, path).toBe(`${place} · ${brand}`);
    expect(title, path).not.toMatch(/pulsar/i);
  }

  await page.goto("/exportar");
  expect(await page.title()).toBe(`${exportMessages.printBrand} · ${civilDateShort(todayInZone())}`);
  await context.close();

  const out = await browser.newContext({ baseURL: baseURL! });
  const entrar = await out.newPage();
  await entrar.goto("/entrar");
  const entrarTitle = await entrar.title();
  expect(entrarTitle).toBe(`Entrar · ${brand}`);
  expect(entrarTitle).not.toMatch(/pulsar/i);
  await out.close();
});
