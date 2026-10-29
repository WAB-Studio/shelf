import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import oneOffs from "../messages/es/oneOffs.json";
import roadmap from "../messages/es/roadmap.json";
import day from "../messages/es/day.json";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-61 (`HoySueltaMover.dc.html`, `HoySueltaMoverDia.dc.html`): on Hoy, never
// on a past day, the sheet of a loose task not yet done offers «Darle otro
// día», which opens the schedule step with the day it has now. `/sueltas` keeps
// «Darle un día». «Darle otro día» is not in the catalogue yet: the board's
// words stand here.

const WIDTHS = [390, 1440];
const GIVE_OTHER = "Darle otro día";

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

async function seed(db: postgres.Sql, personId: string, name: string, dayValue: string | null): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day) values (${personId}, ${name}, ${dayValue}) returning id
  `;
  return row.id;
}

async function dayOf(db: postgres.Sql, id: string): Promise<string | null | undefined> {
  const [row] = await db<{ day: string | null }[]>`select day::text as day from goals.one_offs where id = ${id}`;
  return row?.day;
}

// The oracle for «ahora: sábado 19» is ICU's Spanish weekday, never the catalogue's list.
function weekdayAndNumber(dayValue: string): string {
  const date = civilDateToDate(dayValue);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `${weekday} ${date.getUTCDate()}`;
}

function nameButton(page: Page, name: string) {
  return page.getByRole("button", { name: new RegExp(`^${name}`) });
}

async function openSheet(page: Page, name: string) {
  await nameButton(page, name).click();
  const sheet = page.getByRole("dialog", { name });
  await expect(sheet.getByRole("heading", { name })).toBeVisible();
  return sheet;
}

async function openStep(page: Page, name: string) {
  const sheet = await openSheet(page, name);
  const give = sheet.getByRole("button", { name: GIVE_OTHER, exact: true });
  await expect(give).toBeVisible();
  await give.click();
  const step = page.getByRole("dialog", { name: oneOffs.schedule.title });
  await expect(step).toBeVisible();
  return step;
}

// Radix registers the sheet's Escape layer after its DOM exists; the open
// animation is the first thing that ends after it (`docs/TRAPS.md`).
async function settled(step: ReturnType<Page["getByRole"]>) {
  await step.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

for (const width of WIDTHS) {
  test(`Hoy at ${width}: a loose task of today offers «${GIVE_OTHER}» in its sheet, between the save row and «${roadmap.fijar.delete}» (RP-61)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Llamar al banco ${width} ${Date.now()}`;
    const id = await seed(db, personId, name, todayInZone());
    try {
      await page.goto("/");
      const sheet = await openSheet(page, name);
      const give = sheet.getByRole("button", { name: GIVE_OTHER, exact: true });
      await expect(give).toBeVisible();
      await expect(sheet.getByRole("button", { name: oneOffs.sheet.giveDay })).toHaveCount(0);
      const save = await sheet.getByRole("button", { name: roadmap.fijar.save }).boundingBox();
      const del = await sheet.getByRole("button", { name: roadmap.fijar.delete }).boundingBox();
      const box = await give.boundingBox();
      expect(save!.y).toBeLessThan(box!.y);
      expect(box!.y).toBeLessThan(del!.y);
    } finally {
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`Hoy at ${width}: the step for a task of today reads «ahora: hoy» and offers no «hoy» (RP-61)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Paso sin hoy ${width} ${Date.now()}`;
    const id = await seed(db, personId, name, todayInZone());
    try {
      await page.goto("/");
      const step = await openStep(page, name);
      await expect(step).toContainText("ahora: hoy");
      await expect(step.getByRole("radio", { name: "hoy", exact: true })).toHaveCount(0);
      await expect(step.getByRole("radio", { name: "mañana", exact: true })).toBeVisible();
      await expect(step.getByRole("radio", { name: "otro día", exact: true })).toBeVisible();
      await expect(step.getByRole("button", { name: oneOffs.schedule.move, exact: true })).toBeVisible();
      await expect(step.getByRole("button", { name: oneOffs.schedule.stay, exact: true })).toBeVisible();
      // HoySueltaMoverDia, decided 2026-10-09: «mañana» is chosen, never «otro día» with today's date.
      await expect(step.getByRole("radio", { name: "mañana", exact: true })).toBeChecked();
      await expect(step.getByRole("radio", { name: "otro día", exact: true })).not.toBeChecked();
      await expect(step.getByLabel("qué día")).toHaveCount(0);
    } finally {
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`Hoy at ${width}: «${GIVE_OTHER}» → «mañana» → «Moverla» takes the task off Hoy and onto tomorrow on /sueltas (RP-61)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Mover a mañana ${width} ${Date.now()}`;
    const id = await seed(db, personId, name, todayInZone());
    try {
      await page.goto("/");
      const step = await openStep(page, name);
      await step.getByRole("radio", { name: "mañana", exact: true }).click();
      await step.getByRole("button", { name: oneOffs.schedule.move, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(nameButton(page, name)).toHaveCount(0);
      expect(await dayOf(db, id)).toBe(plusDays(1));

      await page.goto("/sueltas");
      await expect(nameButton(page, name)).toContainText(weekdayAndNumber(plusDays(1)));
    } finally {
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`Hoy at ${width}: «${GIVE_OTHER}» → «Moverla» without touching anything moves a task of today to tomorrow and never sends today (RP-61)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Moverla sin tocar ${width} ${Date.now()}`;
    const id = await seed(db, personId, name, todayInZone());
    const posted: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) posted.push(request.postData() ?? "");
    });
    try {
      await page.goto("/");
      const step = await openStep(page, name);
      await step.getByRole("button", { name: oneOffs.schedule.move, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(nameButton(page, name)).toHaveCount(0);
      expect(await dayOf(db, id)).toBe(plusDays(1));
      const sent = posted.filter((body) => body.includes(id));
      expect(sent.length).toBeGreaterThan(0);
      for (const body of sent) expect(body).not.toContain(todayInZone());
    } finally {
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`Hoy at ${width}: a task carried from last Wednesday offers «hoy» first and chosen; «Moverla» keeps it on Hoy with today's day and no «del …» (RP-61, RP-19)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Pagar el seguro ${width} ${Date.now()}`;
    const old = plusDays(-6);
    const id = await seed(db, personId, name, old);
    try {
      await page.goto("/");
      const carried = weekdayAndNumber(old);
      await expect(nameButton(page, name)).toContainText(`del ${carried}`);
      const step = await openStep(page, name);
      await expect(step).toContainText(`ahora: ${carried}`);
      // HoySueltaMoverArrastrada: hoy, mañana, otro día, sin día — hoy chosen.
      const radios = step.getByRole("radiogroup", { name: "Para cuándo" }).getByRole("radio");
      await expect(radios).toHaveText(["hoy", "mañana", "otro día"]);
      await expect(step.getByRole("radio", { name: "hoy", exact: true })).toBeChecked();
      await expect(step.getByLabel("qué día")).toHaveCount(0);

      await step.getByRole("button", { name: oneOffs.schedule.move, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await dayOf(db, id)).toBe(todayInZone());
      await expect(nameButton(page, name)).toBeVisible();
      await expect(nameButton(page, name)).not.toContainText("del ");
    } finally {
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`Hoy at ${width}: a carried task never says «${day.errors.oneOffDayPast}» and its «${oneOffs.schedule.stay}» leaves it as it was (RP-61)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Arrastrada sin pasado ${width} ${Date.now()}`;
    const old = plusDays(-2);
    const id = await seed(db, personId, name, old);
    try {
      await page.goto("/");
      const step = await openStep(page, name);
      await step.getByRole("button", { name: oneOffs.schedule.move, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await dayOf(db, id)).not.toBe(old);

      await db`update goals.one_offs set day = ${old} where id = ${id}`;
      await page.goto("/");
      const again = await openStep(page, name);
      await again.getByRole("button", { name: oneOffs.schedule.stay, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await dayOf(db, id)).toBe(old);
    } finally {
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`Hoy at ${width}: «${oneOffs.schedule.stay}» and Escape leave the task on Hoy with its day (RP-61)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Dejarla como está ${width} ${Date.now()}`;
    const id = await seed(db, personId, name, todayInZone());
    try {
      await page.goto("/");
      let step = await openStep(page, name);
      await step.getByRole("radio", { name: "mañana", exact: true }).click();
      await step.getByRole("button", { name: oneOffs.schedule.stay, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(nameButton(page, name)).toBeVisible();
      expect(await dayOf(db, id)).toBe(todayInZone());

      step = await openStep(page, name);
      await step.getByRole("radio", { name: "mañana", exact: true }).click();
      await settled(step);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(nameButton(page, name)).toBeVisible();
      expect(await dayOf(db, id)).toBe(todayInZone());

      // The task sheet's own «Cancelar» also writes nothing and offers the step again.
      const sheet = await openSheet(page, name);
      await sheet.getByRole("button", { name: roadmap.fijar.cancel }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await dayOf(db, id)).toBe(todayInZone());
    } finally {
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`Hoy at ${width}: a done loose task's sheet offers neither «${GIVE_OTHER}» nor «${oneOffs.sheet.giveDay}» (RP-61)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Hecha sin mover ${width} ${Date.now()}`;
    const id = await seed(db, personId, name, todayInZone());
    try {
      await page.goto("/");
      await page
        .locator("div")
        .filter({ has: page.getByRole("button", { name, exact: true }) })
        .last()
        .getByRole("button", { name: "Marcar como hecho" })
        .click();
      await expect(page.getByRole("button", { name: `Deshacer: ${name}` })).toBeVisible();

      await page.getByText(name, { exact: true }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet).toContainText(oneOffs.sheet.eyebrowDone);
      await expect(sheet.getByRole("button", { name: GIVE_OTHER })).toHaveCount(0);
      await expect(sheet.getByRole("button", { name: oneOffs.sheet.giveDay })).toHaveCount(0);
    } finally {
      await db`delete from goals.facts where one_off_id = ${id}`;
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`/sueltas at ${width}: the sheet still says «${oneOffs.sheet.giveDay}», never «${GIVE_OTHER}» (RP-61, RP-59)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Sueltas igual ${width} ${Date.now()}`;
    const dayless = await seed(db, personId, name, null);
    const scheduledName = `Sueltas programada ${width} ${Date.now()}`;
    const scheduled = await seed(db, personId, scheduledName, plusDays(3));
    try {
      await page.goto("/sueltas");
      for (const each of [name, scheduledName]) {
        await nameButton(page, each).first().click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("button", { name: oneOffs.sheet.giveDay, exact: true })).toBeVisible();
        await expect(sheet.getByRole("button", { name: GIVE_OTHER })).toHaveCount(0);
        await settled(sheet);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
    } finally {
      await db`delete from goals.one_offs where id in (${dayless}, ${scheduled})`;
    }
  });
}

test("Hoy: a loose task carried from two days ago reads «ahora: <its day>» in the step and moves to tomorrow (RP-61, RP-19)", async ({
  page,
  db,
  personId,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const name = `Arrastrada mover ${Date.now()}`;
  const old = plusDays(-2);
  const id = await seed(db, personId, name, old);
  try {
    await page.goto("/");
    const step = await openStep(page, name);
    await expect(step).toContainText(`ahora: ${weekdayAndNumber(old)}`);
    await expect(step).not.toContainText("ahora: hoy");
    await expect(step.getByRole("radio", { name: "hoy", exact: true })).toBeVisible();

    await step.getByRole("radio", { name: "mañana", exact: true }).click();
    await step.getByRole("button", { name: oneOffs.schedule.move, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(nameButton(page, name)).toHaveCount(0);
    expect(await dayOf(db, id)).toBe(plusDays(1));
  } finally {
    await db`delete from goals.one_offs where id = ${id}`;
  }
});

test("Hoy: while the move is in flight «Moverla» is disabled and the step stays open; the task leaves when it answers (RP-61)", async ({
  page,
  db,
  personId,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const name = `Mover pendiente ${Date.now()}`;
  const id = await seed(db, personId, name, todayInZone());
  try {
    await page.goto("/");
    const step = await openStep(page, name);
    await step.getByRole("radio", { name: "mañana", exact: true }).click();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"]) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    const move = step.getByRole("button", { name: oneOffs.schedule.move, exact: true });
    await move.click();
    await expect.poll(() => held).toBe(true);
    // Let any exit animation of an early close finish before judging.
    await settled(step).catch(() => {});
    await expect(move).toBeDisabled();
    await expect(step).toBeVisible();
    await expect(step).toContainText("¿Para cuándo?");
    // The modal hides the page behind it from the role tree.
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`), includeHidden: true })).toHaveCount(1);

    release();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(nameButton(page, name)).toHaveCount(0);
    expect(await dayOf(db, id)).toBe(plusDays(1));
  } finally {
    await db`delete from goals.one_offs where id = ${id}`;
  }
});

test("Hoy: a task done in another tab meanwhile is refused; the notice reads in the step, the task stays (RP-61)", async ({
  page,
  db,
  personId,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const name = `Mover rechazada ${Date.now()}`;
  const id = await seed(db, personId, name, todayInZone());
  try {
    await page.goto("/");
    const step = await openStep(page, name);
    await step.getByRole("radio", { name: "mañana", exact: true }).click();

    // Done in another tab while the step is open.
    const other = await page.context().newPage();
    await other.goto("/");
    await other
      .locator("div")
      .filter({ has: other.getByRole("button", { name, exact: true }) })
      .last()
      .getByRole("button", { name: "Marcar como hecho" })
      .click();
    await expect(other.getByRole("button", { name: `Deshacer: ${name}` })).toBeVisible();
    await other.close();
    await step.getByRole("button", { name: oneOffs.schedule.move, exact: true }).click();

    await expect(step).toContainText(day.errors.oneOffHasFact);
    await expect(step).toBeVisible();
    expect(await dayOf(db, id)).toBe(todayInZone());
  } finally {
    await db`delete from goals.facts where one_off_id = ${id}`;
    await db`delete from goals.one_offs where id = ${id}`;
  }
});

test("a past day draws no loose task, so no sheet offers «Darle otro día» there (RP-61)", async ({
  page,
  db,
  personId,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const name = `Suelta de ayer ${Date.now()}`;
  const id = await seed(db, personId, name, plusDays(-1));
  try {
    await page.goto(`/dia/${plusDays(-1)}`);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText(GIVE_OTHER)).toHaveCount(0);
    // Whatever the page draws of the task, opening it never offers the move.
    const row = nameButton(page, name);
    if ((await row.count()) > 0) {
      await row.first().click();
      await expect(page.getByRole("dialog").getByRole("button", { name: GIVE_OTHER })).toHaveCount(0);
    }
  } finally {
    await db`delete from goals.one_offs where id = ${id}`;
  }
});

test("360: the sheet and the step stand inside the viewport with the move offered (RP-61)", async ({
  page,
  db,
  personId,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const name = `Llamar al banco para ver cómo se parte un nombre largo en 360 ${Date.now()}`;
  const id = await seed(db, personId, name, todayInZone());
  try {
    await page.goto("/");
    const sheet = await openSheet(page, name);
    const give = sheet.getByRole("button", { name: GIVE_OTHER, exact: true });
    await expect(give).toBeVisible();
    const inside = async (el: ReturnType<Page["getByRole"]>) => {
      const box = await el.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    };
    await inside(give);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await give.click();
    const step = page.getByRole("dialog", { name: oneOffs.schedule.title });
    await expect(step).toContainText("ahora: hoy");
    await inside(step.getByRole("button", { name: oneOffs.schedule.move, exact: true }));
    await inside(step.getByRole("button", { name: oneOffs.schedule.stay, exact: true }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await db`delete from goals.one_offs where id = ${id}`;
  }
});
