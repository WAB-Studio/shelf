import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, appAlerts, type Person } from "./fixtures";
import chat from "../messages/es/chat.json";
import roadmap from "../messages/es/roadmap.json";

// RP-91–RP-94, RNP-21 (`ChatPropuesta`, `ChatPropuestas`, `ChatHecho`, `ChatRechazada`, `ChatFallo`,
// `ChatTope`, `ChatEscritorio`): the chat screen against `PULSAR_FAULT_BASE_URL`, a `next start` of
// the same build with `PULSAR_CHAT_STUB=script:e2e/data/chat-guion.json`. The stub answers by the
// message's own text, so no run reaches OpenAI. The words come from `messages/es/chat.json` and
// `roadmap.json`; the figures from the plan seeded here.

type Db = postgres.Sql;

const MARCH = "marzo de 2030";
const fix = (task: string) => chat.change.fix_task.replace("{month}", MARCH).replace("{task}", task);
const amount = chat.change.set_month_amount.replace("{month}", MARCH).replace("{goal}", "Inglés B1");
const PROPOSES = chat.proposes;
const OUTSIDE = roadmap.errors.monthOutsideSpan;

type World = { goal: string; maze: string; base: string };

// An open goal that runs to 2030 and two loose-in-plan tasks, all by exact id.
async function seed(db: Db, personId: string): Promise<World> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
    values (${personId}, 'Inglés B1', '2030-12-31'::date, 'minutos', 'minutos') returning id
  `;
  const task = async (name: string) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, in_plan)
      values (${personId}, ${goal.id}, ${name}, true) returning id
    `;
    return row.id;
  };
  return { goal: goal.id, maze: await task("Maze"), base: await task("Línea base") };
}

async function drop(db: Db, world: World): Promise<void> {
  await db`delete from goals.month_budgets where goal_id = ${world.goal}`;
  await db`delete from goals.one_offs where id in (${world.maze}, ${world.base})`;
  await db`delete from goals.goals where id = ${world.goal}`;
}

async function planned(db: Db, id: string): Promise<string | null> {
  const [row] = await db<{ planned_month: string | null }[]>`
    select to_char(planned_month, 'YYYY-MM-DD') as planned_month from goals.one_offs where id = ${id}
  `;
  return row.planned_month;
}

async function budget(db: Db, goal: string): Promise<number | null> {
  const rows = await db<{ amount: number }[]>`
    select amount from goals.month_budgets where goal_id = ${goal} and month = '2030-03-01'
  `;
  return rows.length === 0 ? null : rows[0].amount;
}

async function chatRows(db: Db, personId: string) {
  return db<{ source: string; outcome: string | null }[]>`
    select source, outcome from goals.model_calls where user_id = ${personId} and source = 'chat' order by called_at
  `;
}

async function open(browser: Browser, baseURL: string, person: Person, width = 360) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL,
    viewport: { width, height: width === 360 ? 740 : 800 },
    hasTouch: width === 360,
  });
  const page = await context.newPage();
  await page.goto("/chat");
  return { context, page };
}

const field = (page: Page) => page.getByLabel(chat.field);
const enviar = (page: Page) => page.getByRole("button", { name: chat.send, exact: true });
const hacer = (page: Page) => page.getByRole("button", { name: chat.do, exact: true });
const hacerTodo = (page: Page) => page.getByRole("button", { name: chat.doAll, exact: true });
const hechos = (page: Page) => page.getByText(chat.made, { exact: true });

async function send(page: Page, text: string): Promise<void> {
  await expect(field(page)).toBeVisible();
  await field(page).fill(text);
  await enviar(page).click();
}

test.describe("the chat against a stubbed model (RP-91–RP-94)", () => {
  test("a reply with no change is drawn under «GOALLOG» and offers no «Hacer»", async ({ person, browser, baseURL }) => {
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "hola");
      await expect(page.getByText("Hola, dime qué quieres ver o cambiar en tu plan.")).toBeVisible();
      await expect(page.getByText(chat.you, { exact: true })).toHaveCount(1);
      await expect(page.getByText(chat.chat, { exact: true })).toHaveCount(1);
      await expect(page.getByText("hola", { exact: true })).toBeVisible();
      await expect(hacer(page)).toHaveCount(0);
      await expect(hacerTodo(page)).toHaveCount(0);
      await expect(page.getByText(PROPOSES)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("the examples are shown on an empty chat, a tap sends one, and they go once there is a conversation", async ({
    person,
    browser,
    baseURL,
  }) => {
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await expect(page.getByText(chat.tryWith, { exact: true })).toBeVisible();
      await expect(page.getByText(chat.examples.amount)).toBeVisible();
      await page.getByText(chat.examples.month, { exact: true }).click();
      await expect(page.getByText(chat.you, { exact: true })).toHaveCount(1);
      await expect(page.getByText(/Octubre va en 12 h 30 min/)).toBeVisible();
      await expect(page.getByText(chat.tryWith, { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("while it answers, the message is drawn, field and send are shut and a second send reaches nothing", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const { context, page } = await open(browser, baseURL!, person);
    let hits = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/chat/enviar", async (route) => {
      hits += 1;
      await gate;
      await route.continue();
    });
    try {
      await send(page, "hola");
      await expect(page.getByText(chat.pending)).toBeVisible();
      await expect(page.getByText("hola", { exact: true })).toBeVisible();
      await expect(page.getByText(chat.you, { exact: true })).toHaveCount(1);
      await expect(field(page)).toBeDisabled();
      await expect(enviar(page)).toBeDisabled();

      await enviar(page).click({ force: true });
      await page.keyboard.press("Enter");
      expect(hits).toBe(1);

      release();
      await expect(page.getByText("Hola, dime qué quieres ver o cambiar en tu plan.")).toBeVisible();
      await expect(page.getByText(chat.pending)).toHaveCount(0);
      await expect(field(page)).toBeEnabled();
      expect(hits).toBe(1);
      expect(await chatRows(db, person.id)).toEqual([{ source: "chat", outcome: "ok" }]);
    } finally {
      release();
      await context.close();
    }
  });

  test("a proposal reads what it changes and «antes → después», and nothing changes until «Hacer»", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "pasa Maze a marzo de 2030");
      await expect(page.getByText(PROPOSES)).toBeVisible();
      await expect(page.getByText(fix("Maze"), { exact: true })).toBeVisible();
      await expect(page.getByText(`${chat.before.inPlan} → ${MARCH}`, { exact: true })).toBeVisible();
      await expect(hacer(page)).toHaveCount(1);
      await expect(hacerTodo(page)).toHaveCount(0);
      expect(await planned(db, world.maze)).toBeNull();
    } finally {
      await context.close();
      await drop(db, world);
    }
  });

  test("a month amount reads «sin monto → 4 h»", async ({ person, browser, baseURL, db }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "pon 4 h de inglés");
      await expect(page.getByText(amount, { exact: true })).toBeVisible();
      await expect(page.getByText(`${chat.before.noAmount} → 4 h`, { exact: true })).toBeVisible();
      expect(await budget(db, world.goal)).toBeNull();
    } finally {
      await context.close();
      await drop(db, world);
    }
  });

  test("«Hacer» makes the change: the row reads «hecho» with no button, the task is fixed and the month shows it", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "pasa Maze a marzo de 2030");
      await hacer(page).click();
      await expect(hechos(page)).toHaveCount(1);
      await expect(hacer(page)).toHaveCount(0);
      expect(await planned(db, world.maze)).toBe("2030-03-01");

      await page.goto(`/metas/${world.goal}/meses/2030-03`);
      await expect(page.getByText("Maze").first()).toBeVisible();
    } finally {
      await context.close();
      await drop(db, world);
    }
  });

  test("«Hacer todo» makes the three changes and every row reads «hecho»", async ({ person, browser, baseURL, db }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "organiza marzo");
      await expect(hacer(page)).toHaveCount(3);
      await expect(hacerTodo(page)).toBeVisible();
      await hacerTodo(page).click();
      await expect(hechos(page)).toHaveCount(3);
      await expect(hacer(page)).toHaveCount(0);
      await expect(hacerTodo(page)).toHaveCount(0);
      expect(await planned(db, world.maze)).toBe("2030-03-01");
      expect(await planned(db, world.base)).toBe("2030-03-01");
      expect(await budget(db, world.goal)).toBe(240);
    } finally {
      await context.close();
      await drop(db, world);
    }
  });

  test("«Hacer» on the second change makes that one alone; «Hacer todo» goes when fewer than two stay open", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "organiza marzo");
      await hacer(page).nth(1).click();
      await expect(hechos(page)).toHaveCount(1);
      expect(await planned(db, world.base)).toBe("2030-03-01");
      expect(await planned(db, world.maze)).toBeNull();
      expect(await budget(db, world.goal)).toBeNull();
      await expect(hacer(page)).toHaveCount(2);
      await expect(hacerTodo(page)).toBeVisible();

      await hacer(page).first().click();
      await expect(hechos(page)).toHaveCount(2);
      await expect(hacer(page)).toHaveCount(1);
      await expect(hacerTodo(page)).toHaveCount(0);
      expect(await planned(db, world.maze)).toBe("2030-03-01");
      expect(await budget(db, world.goal)).toBeNull();
    } finally {
      await context.close();
      await drop(db, world);
    }
  });

  test("a change the act refuses shows the act's own sentence, has no button, and the plan stays", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "pasa Maze al pasado");
      await hacer(page).click();
      await expect(page.getByText(OUTSIDE, { exact: true })).toBeVisible();
      await expect(hacer(page)).toHaveCount(0);
      await expect(hechos(page)).toHaveCount(0);
      expect(await planned(db, world.maze)).toBeNull();
    } finally {
      await context.close();
      await drop(db, world);
    }
  });

  test("«Hacer todo» makes what it can: the refused one keeps its reason and no button, the others are made", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "organiza con un error");
      await hacerTodo(page).click();
      await expect(hechos(page)).toHaveCount(2);
      await expect(page.getByText(OUTSIDE, { exact: true })).toBeVisible();
      await expect(hacer(page)).toHaveCount(0);
      await expect(hacerTodo(page)).toHaveCount(0);
      expect(await planned(db, world.maze)).toBe("2030-03-01");
      expect(await planned(db, world.base)).toBeNull();
      expect(await budget(db, world.goal)).toBe(240);
    } finally {
      await context.close();
      await drop(db, world);
    }
  });

  test("a change that names nothing of the person's draws its reason and no «Hacer»", async ({ person, browser, baseURL }) => {
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "pasa la que no existe");
      await expect(page.getByText(chat.errors.notInPlan, { exact: true })).toBeVisible();
      await expect(hacer(page)).toHaveCount(0);
      await expect(hacerTodo(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("an open change lapses when the next message is sent: «sin hacer», no button, nothing made", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "pasa Maze a marzo de 2030");
      await expect(hacer(page)).toHaveCount(1);
      await send(page, "hola");
      await expect(page.getByText("Hola, dime qué quieres ver o cambiar en tu plan.")).toBeVisible();
      await expect(page.getByText(chat.lapsed, { exact: true })).toHaveCount(1);
      await expect(hacer(page)).toHaveCount(0);
      await expect(page.getByText(fix("Maze"), { exact: true })).toBeVisible();
      expect(await planned(db, world.maze)).toBeNull();
    } finally {
      await context.close();
      await drop(db, world);
    }
  });

  test("a model that fails keeps the message as a turn, offers «Intentar otra vez», and a retry sends again", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const { context, page } = await open(browser, baseURL!, person);
    let hits = 0;
    await page.route("**/chat/enviar", async (route) => {
      hits += 1;
      await route.continue();
    });
    try {
      await send(page, "falla");
      await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveText(chat.errors.failed);
      await expect(page.getByText("falla", { exact: true })).toBeVisible();
      await expect(page.getByText(chat.you, { exact: true })).toHaveCount(1);
      await expect(field(page)).toHaveValue("");
      await expect(field(page)).toBeEnabled();
      await expect(enviar(page)).toHaveCount(0);
      expect(await chatRows(db, person.id)).toEqual([{ source: "chat", outcome: "failed" }]);

      await page.getByRole("button", { name: chat.retry, exact: true }).click();
      await expect.poll(() => hits).toBe(2);
      await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveText(chat.errors.failed);
      await expect(page.getByText(chat.you, { exact: true })).toHaveCount(1);
      expect(await chatRows(db, person.id)).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  test("with fifty chat messages today the cap notice shows, the field is shut and no row is added", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const [row] = await db<{ id: string }[]>`
        insert into goals.model_calls (user_id, model, source, outcome)
        values (${person.id}, 'gpt-5-mini', 'chat', 'ok') returning id
      `;
      ids.push(row.id);
    }
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "hola");
      await expect(page.getByText(chat.errors.cap, { exact: true })).toBeVisible();
      await expect(field(page)).toBeDisabled();
      await expect(enviar(page)).toBeDisabled();
      expect(await chatRows(db, person.id)).toHaveLength(50);
    } finally {
      await context.close();
      await db`delete from goals.model_calls where id = any(${ids})`;
    }
  });

  test("the conversation survives a reload with its change states, and is empty in another tab and context", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    const other = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 740 } });
    try {
      await send(page, "organiza marzo");
      await hacer(page).nth(1).click();
      await expect(hechos(page)).toHaveCount(1);

      await page.reload();
      await expect(page.getByText("organiza marzo", { exact: true })).toBeVisible();
      await expect(page.getByText(chat.you, { exact: true })).toHaveCount(1);
      await expect(page.getByText(chat.chat, { exact: true })).toHaveCount(1);
      await expect(hechos(page)).toHaveCount(1);
      await expect(hacer(page)).toHaveCount(2);

      const tab = await context.newPage();
      await tab.goto("/chat");
      await expect(tab.getByText(chat.tryWith, { exact: true })).toBeVisible();
      await expect(tab.getByText(chat.you, { exact: true })).toHaveCount(0);
      const kept = await tab.evaluate(() => JSON.stringify({ ...localStorage }));
      expect(kept).not.toContain("organiza marzo");

      const elsewhere = await other.newPage();
      await elsewhere.goto("/chat");
      await expect(elsewhere.getByText(chat.tryWith, { exact: true })).toBeVisible();
      await expect(elsewhere.getByText(chat.you, { exact: true })).toHaveCount(0);
    } finally {
      await other.close();
      await context.close();
      await drop(db, world);
    }
  });

  test("the conversation is never stored on the server: only the call's own row moves", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const marker = "marca-conversacion-estable";
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, `hola ${marker}`);
      await expect(page.getByText("Respuesta marca-respuesta-estable.")).toBeVisible();

      const tables = await db<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'goals' and table_type = 'BASE TABLE'
      `;
      const holding: string[] = [];
      for (const { table_name } of tables) {
        const [row] = await db<{ n: number }[]>`
          select count(*)::int as n from ${db("goals." + table_name)} as t
          where t::text like ${"%" + marker + "%"} or t::text like '%marca-respuesta-estable%'
        `;
        if (row.n > 0) holding.push(table_name);
      }
      expect(holding).toEqual([]);
      expect(await chatRows(db, person.id)).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test("nothing but the last 20 turns is sent", async ({ person, browser, baseURL }) => {
    const { context, page } = await open(browser, baseURL!, person);
    const sizes: number[] = [];
    await page.route("**/chat/enviar", async (route) => {
      const body = route.request().postDataJSON() as { turns: { role: string; text: string }[] };
      sizes.push(body.turns.length);
      await route.continue();
    });
    try {
      for (let i = 1; i <= 12; i += 1) {
        await send(page, "hola");
        await expect(page.getByText(chat.you, { exact: true })).toHaveCount(i);
        await expect(page.getByText(chat.chat, { exact: true })).toHaveCount(i);
        await expect(enviar(page)).toBeDisabled();
      }
      expect(sizes.slice(0, 3)).toEqual([1, 3, 5]);
      expect(Math.max(...sizes)).toBe(20);
      expect(sizes.at(-1)).toBe(20);
      await expect(page.getByText(chat.you, { exact: true })).toHaveCount(12);
    } finally {
      await context.close();
    }
  });
});

test.describe("the chat's layout (RNP-07, RNP-17)", () => {
  test("at 360 a full answer overflows nothing, every control reaches 32 px and the field clears the tab bar", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "palabra larga");
      await expect(page.getByText(/supercalifragilistico/)).toBeVisible();
      await send(page, "organiza marzo");
      await expect(hacer(page)).toHaveCount(3);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll("main button, main a, main input, main textarea")) {
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          if (Math.min(box.width, box.height) < 32) out.push(`${el.tagName}[${(el.textContent ?? "").trim().slice(0, 20)}] ${box.width}x${box.height}`);
        }
        return out;
      });
      expect(small).toEqual([]);

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const nav = await page.getByRole("navigation").boundingBox();
      const box = await field(page).boundingBox();
      expect(nav).not.toBeNull();
      expect(box).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(nav!.y + 0.5);
    } finally {
      await context.close();
      await drop(db, world);
    }
  });

  test("at 1280 the chat stands in the rail's frame in a column, with «Hacer todo» and «Enviar» at their natural width", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person, 1280);
    try {
      await send(page, "organiza marzo");
      await expect(hacer(page)).toHaveCount(3);

      const rail = page.getByRole("navigation");
      await expect(rail.getByRole("link").filter({ hasText: /^(Hoy|Semana|Mes|Metas)$/ })).toHaveCount(4);

      const input = await field(page).boundingBox();
      const all = await hacerTodo(page).boundingBox();
      const go = await enviar(page).boundingBox();
      const first = await hacer(page).first().boundingBox();
      expect(input).not.toBeNull();
      expect(all).not.toBeNull();
      expect(go).not.toBeNull();
      expect(first).not.toBeNull();

      expect(input!.width).toBeLessThanOrEqual(640);
      expect(input!.width).toBeGreaterThan(400);
      expect(all!.width).toBeLessThan(input!.width / 2);
      expect(go!.width).toBeLessThan(input!.width / 2);
      // «Hacer» sits at the row's end, inside the column.
      expect(first!.x + first!.width).toBeGreaterThan(input!.x + input!.width - 48);
      expect(first!.x + first!.width).toBeLessThanOrEqual(input!.x + input!.width + 1);
    } finally {
      await context.close();
      await drop(db, world);
    }
  });
});

// Survivors of the train's mutator (private/reportes/tren-c1/MUTATOR.md), each one a thing a person can do.
test.describe("the chat when the person acts fast or changes their mind (RP-92, RP-93)", () => {
  // Holds every server action (`Next-Action` POST) until `release()`; counts them.
  async function holdActions(page: Page) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = { n: 0 };
    await page.route("**/chat", async (route) => {
      if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) return route.continue();
      seen.n += 1;
      await gate;
      await route.continue();
    });
    return { release, seen };
  }

  test("after a failed answer, typing a new message offers «Enviar» and sends what was typed, not the old message", async ({
    person,
    browser,
    baseURL,
  }) => {
    const { context, page } = await open(browser, baseURL!, person);
    const sent: string[] = [];
    await page.route("**/chat/enviar", async (route) => {
      const body = route.request().postDataJSON() as { turns: { role: string; text: string }[] };
      sent.push(body.turns.at(-1)!.text);
      await route.continue();
    });
    try {
      await send(page, "falla");
      await expect(page.getByRole("button", { name: chat.retry, exact: true })).toBeVisible();

      await field(page).fill("hola");
      await expect(page.getByRole("button", { name: chat.retry, exact: true })).toHaveCount(0);
      await expect(enviar(page)).toBeEnabled();
      await enviar(page).click();

      await expect(page.getByText("Hola, dime qué quieres ver o cambiar en tu plan.")).toBeVisible();
      expect(sent).toEqual(["falla", "hola"]);
      await expect(field(page)).toHaveValue("");
    } finally {
      await context.close();
    }
  });

  test("a message the cap refuses leaves no turn behind: the conversation stays empty under the notice", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const [row] = await db<{ id: string }[]>`
        insert into goals.model_calls (user_id, model, source, outcome)
        values (${person.id}, 'gpt-5-mini', 'chat', 'ok') returning id
      `;
      ids.push(row.id);
    }
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await send(page, "mensaje sin respuesta");
      await expect(page.getByText(chat.errors.cap, { exact: true })).toBeVisible();
      await expect(page.getByText("mensaje sin respuesta", { exact: true })).toHaveCount(0);
      await expect(page.getByText(chat.you, { exact: true })).toHaveCount(0);
      const stored = await page.evaluate(() => sessionStorage.getItem("pulsar.chat"));
      expect(stored === null || !stored.includes("mensaje sin respuesta")).toBe(true);
    } finally {
      await context.close();
      await db`delete from goals.model_calls where id = any(${ids})`;
    }
  });

  test("two submits in the same instant send one message", async ({ person, browser, baseURL, db }) => {
    const { context, page } = await open(browser, baseURL!, person);
    let hits = 0;
    await page.route("**/chat/enviar", async (route) => {
      hits += 1;
      await route.continue();
    });
    try {
      await expect(field(page)).toBeVisible();
      await field(page).fill("hola");
      await page.evaluate(() => {
        const form = document.querySelector("main form") as HTMLFormElement;
        form.requestSubmit();
        form.requestSubmit();
      });
      await expect(page.getByText("Hola, dime qué quieres ver o cambiar en tu plan.")).toBeVisible();
      expect(hits).toBe(1);
      expect(await chatRows(db, person.id)).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test("while «Hacer todo» is making, no «Hacer» can be tapped", async ({ person, browser, baseURL, db }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    const held = await holdActions(page);
    try {
      await send(page, "organiza marzo");
      await expect(hacer(page)).toHaveCount(3);
      await hacerTodo(page).click();
      await expect.poll(() => held.seen.n).toBe(1);
      for (const i of [0, 1, 2]) await expect(hacer(page).nth(i)).toBeDisabled();
      await expect(hacerTodo(page)).toBeDisabled();
      held.release();
      await expect(hechos(page)).toHaveCount(3);
    } finally {
      held.release();
      await context.close();
      await drop(db, world);
    }
  });

  test("a message sent while «Hacer todo» is still making stops the changes not yet made: they lapse and are not made", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL!, person);
    const held = await holdActions(page);
    try {
      await send(page, "organiza marzo");
      await expect(hacer(page)).toHaveCount(3);
      await hacerTodo(page).click();
      await expect.poll(() => held.seen.n).toBe(1);

      await send(page, "hola");
      await expect(page.getByText("Hola, dime qué quieres ver o cambiar en tu plan.")).toBeVisible();
      held.release();
      await expect(page.getByText(chat.lapsed, { exact: true }).first()).toBeVisible();
      await expect(hacer(page)).toHaveCount(0);

      // The first request was already on its way; the other two were not taken, so they were never made.
      await expect.poll(() => planned(db, world.maze)).toBe("2030-03-01");
      await page.waitForTimeout(1500);
      expect(await planned(db, world.base)).toBeNull();
      expect(await budget(db, world.goal)).toBeNull();
      expect(held.seen.n).toBe(1);
    } finally {
      held.release();
      await context.close();
      await drop(db, world);
    }
  });

  test("a message over 2000 characters is not sent, keeps its text and says what to do; the next one is answered", async ({
    person,
    browser,
    baseURL,
  }) => {
    const { context, page } = await open(browser, baseURL!, person);
    let hits = 0;
    await page.route("**/chat/enviar", async (route) => {
      hits += 1;
      await route.continue();
    });
    try {
      const long = "a".repeat(2001);
      await send(page, long);
      await expect(page.getByText(chat.errors.tooLong, { exact: true })).toBeVisible();
      await expect(field(page)).toHaveValue(long);
      await expect(page.getByText(chat.you, { exact: true })).toHaveCount(0);
      await expect(page.getByText(chat.errors.failed)).toHaveCount(0);
      expect(hits).toBe(0);

      await field(page).fill("hola");
      await expect(page.getByText(chat.errors.tooLong, { exact: true })).toHaveCount(0);
      await enviar(page).click();
      await expect(page.getByText("Hola, dime qué quieres ver o cambiar en tu plan.")).toBeVisible();
      expect(hits).toBe(1);
    } finally {
      await context.close();
    }
  });
});
