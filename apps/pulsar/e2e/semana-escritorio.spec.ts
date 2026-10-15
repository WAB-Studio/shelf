import { randomBytes, randomUUID } from "node:crypto";

import type { BrowserContext } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import { noonFromToday } from "./reloj";

// RNP-17, RP-16, RP-20, RP-27 on Semana (`SemanaEscritorio.dc.html`): at 1280
// the week is a table, at 360 it is still the list. Each test seeds its own
// rows and drops them by id.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

function weekdayIndex(day: string): number {
  return (civilDateToDate(day).getUTCDay() + 6) % 7;
}

// ICU's Spanish, never the catalogue's list the screen reads.
function shortLabel(day: string): string {
  const weekday = new Intl.DateTimeFormat("es", { weekday: "short", timeZone: "UTC" })
    .format(civilDateToDate(day))
    .replace(".", "");
  return `${weekday} ${Number(day.slice(8, 10))}`;
}

function longName(day: string): string {
  const date = civilDateToDate(day);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `${weekday} ${date.getUTCDate()}`;
}

function openName(day: string): string {
  const date = civilDateToDate(day);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `Abrir el ${weekday} ${date.getUTCDate()}`;
}

const today = todayInZone();
const weekDays = Array.from({ length: 7 }, (_, i) => shift(today, i - weekdayIndex(today)));
const todayIndex = weekdayIndex(today);

async function seedGoal(db: postgres.Sql, personId: string, name: string, horizon: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${personId}, ${name}, ${horizon}) returning id
  `;
  return goal.id;
}

async function seedCommitment(
  db: postgres.Sql,
  personId: string,
  goalId: string,
  name: string,
  createdAt: Date,
) {
  const [row] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goalId}, ${name}, 'daily', 'tap', ${createdAt}) returning id
  `;
  return row.id;
}

// Registered under the suite's run the way `mint-session.ts` registers the
// first person; the run's teardown drops it if this spec cannot.
async function createPerson(db: postgres.Sql): Promise<string> {
  const runId = process.env.HARNESS_RUN_ID?.trim();
  if (!runId) throw new Error("HARNESS_RUN_ID is unset: this spec runs under check:e2e's own run");
  const id = randomUUID();
  const email = `harness-pulsar-${id}@example.invalid`;
  await db.begin(async (tx) => {
    await tx`
      insert into auth.users (
        id, instance_id, aud, role, email, email_confirmed_at,
        encrypted_password, confirmation_token, recovery_token,
        email_change, email_change_token_current, email_change_token_new,
        email_change_confirm_status, phone_change, phone_change_token,
        reauthentication_token, raw_app_meta_data, raw_user_meta_data,
        is_sso_user, is_anonymous, created_at, updated_at)
      values (
        ${id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', ${email}, now(),
        '', '', '',
        '', '', '',
        0, '', '',
        '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        false, false, now(), now())`;
    await tx`
      insert into harness.identities (user_id, run_id, email, disposition)
      values (${id}, ${runId}, ${email}, 'ephemeral')`;
  });
  return id;
}

// The real `/auth/confirm` redemption `mint-session.ts` performs, its cookies
// landing in this context's own jar.
async function signIn(context: BrowserContext, db: postgres.Sql, personId: string) {
  const hash = randomBytes(32).toString("hex");
  const [{ email }] = await db<{ email: string }[]>`
    update auth.users set recovery_token = ${hash}, recovery_sent_at = now(), updated_at = now()
    where id = ${personId} returning email`;
  await db`
    insert into auth.one_time_tokens (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
    values (${randomUUID()}, ${personId}, 'recovery_token', ${hash}, ${email}, now(), now())`;
  const response = await context.request.get(`/auth/confirm?token_hash=${hash}&type=magiclink`, {
    maxRedirects: 0,
  });
  const location = response.headers()["location"];
  if (!location || location.includes("error=")) {
    throw new Error(`/auth/confirm refused the token: ${location}`);
  }
}

async function dropPerson(db: postgres.Sql, id: string) {
  await db`delete from goals.facts where user_id = ${id}`;
  await db`delete from goals.one_offs where user_id = ${id}`;
  await db`delete from goals.goals where user_id = ${id}`;
  await db`delete from auth.users where id = ${id}`;
  await db`delete from harness.identities where user_id = ${id}`;
}

const longAgo = () => noonFromToday(-12);

test("at 1280 the week is a table: commitments down, days across, today's fact in today's cell, a one-off a named row (RNP-17, RP-16, RP-20)", async ({
  browser,
  baseURL,
  db,
}) => {
  // A person of this spec's own: siblings seed on the suite's person, so the
  // «hechos» tally of this page is exactly what this test seeds.
  const personId = await createPerson(db);
  const context = await browser.newContext({ baseURL: baseURL! });
  const page = await context.newPage();
  await signIn(context, db, personId);
  const stamp = Date.now();
  const goalName = `Meta tabla ${stamp}`;
  const first = `Anki ${stamp}`;
  const second = `Leer ${stamp}`;
  const named = `Suelta con meta ${stamp}`;
  const loose = `Suelta libre ${stamp}`;
  try {
    const goalId = await seedGoal(db, personId, goalName, shift(today, 60));
    const firstId = await seedCommitment(db, personId, goalId, first, longAgo());
    // Created now: no earlier day of the week held it.
    await seedCommitment(db, personId, goalId, second, noonFromToday(0));
    await db`insert into goals.facts (user_id, commitment_id, day) values (${personId}, ${firstId}, ${today})`;
    const [own] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, day) values (${personId}, ${goalId}, ${named}, ${today}) returning id
    `;
    const [free] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, name, day) values (${personId}, ${loose}, ${today}) returning id
    `;
    await db`
      insert into goals.facts (user_id, one_off_id, goal_id, day) values (${personId}, ${own.id}, ${goalId}, ${today})
    `;
    await db`insert into goals.facts (user_id, one_off_id, day) values (${personId}, ${free.id}, ${today})`;

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/semana");

    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveCount(7);
    for (const [index, day] of weekDays.entries()) {
      const label = index === todayIndex ? `${shortLabel(day)} · hoy` : shortLabel(day);
      await expect(table.getByRole("columnheader").nth(index)).toContainText(label);
    }

    const rowOf = (name: string) => table.locator("tr", { has: page.getByRole("rowheader", { name, exact: true }) });
    const marks = (name: string, index: number) => rowOf(name).locator("td").nth(index).getByRole("img");

    await expect(table.getByRole("rowheader", { name: new RegExp(`^${goalName}`, "i") })).toBeVisible();
    await expect(marks(first, todayIndex)).toHaveAttribute("data-state", "declared");
    await expect(marks(second, todayIndex)).toHaveAttribute("data-state", "empty");
    // Before it was written the commitment asked nothing: a named «·».
    for (let index = 0; index < todayIndex; index++) {
      await expect(marks(second, index)).toHaveAttribute("data-state", "none");
      await expect(marks(second, index)).toHaveAccessibleName(`${second}, ${longName(weekDays[index])}: no pedía`);
    }

    for (const name of [named, loose]) {
      await expect(rowOf(name)).toHaveCount(1);
      await expect(marks(name, todayIndex)).toHaveAttribute("data-state", "declared");
      await expect(rowOf(name).locator('[data-state="declared"]')).toHaveCount(1);
      await expect(marks(name, todayIndex)).toHaveAccessibleName(`${name}, ${longName(today)}: hecho`);
    }
    await expect(table.getByRole("rowheader", { name: "Sueltas" })).toBeVisible();

    // Only this spec's person owns these rows: 1 declared of 2 on the day.
    // The two commitments count; the one-offs never do.
    await expect(table.locator("tfoot td").nth(todayIndex)).toHaveText("1 de 2");
    await expect(table.getByRole("rowheader", { name: "hechos" })).toBeVisible();

    // The table sits in one Panel card: a 1px border with a 14px radius.
    const cards = await page.evaluate(
      () =>
        [...document.querySelectorAll("body *")].filter((el) => {
          const style = getComputedStyle(el);
          return style.borderTopWidth === "1px" && style.borderTopLeftRadius === "14px";
        }).length,
    );
    expect(cards).toBe(1);
  } finally {
    await context.close();
    await dropPerson(db, personId);
  }
});

// A Monday's week holds no past day: that run asserts no header is a link.
test("at 1280 a past day's header opens that day (RP-06)", async ({ page, db, personId }) => {
  const name = `Meta cabecera ${Date.now()}`;
  const goalId = await seedGoal(db, personId, name, shift(today, 60));
  try {
    await seedCommitment(db, personId, goalId, `Compromiso ${name}`, longAgo());
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/semana");
    const table = page.getByRole("table");
    await expect(table.getByRole("rowheader", { name: `Compromiso ${name}`, exact: true })).toBeVisible();
    await expect(table.getByRole("link", { name: openName(weekDays[todayIndex]) })).toHaveCount(0);
    await expect(table.getByRole("link", { name: /^Abrir el (?!chat$)/ })).toHaveCount(todayIndex);
    if (todayIndex > 0) {
      const past = weekDays[0];
      await table.getByRole("link", { name: openName(past) }).click();
      await expect(page).toHaveURL(new RegExp(`/dia/${past}$`));
    }
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("at 360 the week is folded: no table, a seven-day header once, a row of seven marks per commitment (RNP-07, Q3)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Meta plegada ${Date.now()}`;
  const commitment = `Compromiso plegado ${name}`;
  const goalId = await seedGoal(db, personId, name, shift(today, 60));
  try {
    await seedCommitment(db, personId, goalId, commitment, longAgo());
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/semana");
    await expect(page.getByRole("table")).toBeHidden();
    const marks = page.getByRole("img", { name: new RegExp(`^${commitment}, `) });
    await expect(marks).toHaveCount(7);
    // One row: the seven marks share a line, left to right in the week's order.
    const boxes = await marks.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
    expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1);
    expect(boxes.map((box) => box.left)).toEqual([...boxes.map((box) => box.left)].sort((a, b) => a - b));
    for (const [index, day] of weekDays.entries()) {
      await expect(marks.nth(index)).toHaveAccessibleName(new RegExp(`^${commitment}, ${longName(day)}: `));
    }
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

// Ended today, or tomorrow on a Monday so the goal still lived this week.
const endDay = todayIndex === 0 ? shift(today, 1) : today;
const blankDays = weekDays.filter((day) => day >= endDay);
const livedDays = weekDays.filter((day) => day < endDay);

test("a goal whose horizon falls this week draws nothing from its horizon on, on both faces (RP-27)", async ({
  page,
  db,
  personId,
}) => {
  const stamp = Date.now();
  const goalName = `Meta que termina ${stamp}`;
  const commitment = `Compromiso terminado ${stamp}`;
  const goalId = await seedGoal(db, personId, goalName, endDay);
  try {
    await seedCommitment(db, personId, goalId, commitment, longAgo());
    await db`
      insert into goals.facts (user_id, commitment_id, day)
      select ${personId}, id, ${today} from goals.commitments where goal_id = ${goalId} and ${todayIndex !== 0}
    `;

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/semana");
    const row = page
      .getByRole("table")
      .locator("tr", { has: page.getByRole("rowheader", { name: commitment, exact: true }) });
    await expect(row).toHaveCount(1);
    for (const day of livedDays) {
      const mark = row.locator("td").nth(weekDays.indexOf(day)).getByRole("img");
      await expect(mark).not.toHaveAttribute("data-state", "none");
    }
    for (const day of blankDays) {
      const mark = row.locator("td").nth(weekDays.indexOf(day)).getByRole("img");
      await expect(mark).toHaveAttribute("data-state", "none");
    }

    await page.setViewportSize({ width: 360, height: 740 });
    const marks = page.getByRole("img", { name: new RegExp(`^${commitment}, `) });
    await expect(marks).toHaveCount(7);
    for (const day of blankDays) {
      await expect(marks.nth(weekDays.indexOf(day))).toHaveAccessibleName(`${commitment}, ${longName(day)}: no pedía`);
    }
    for (const day of livedDays) {
      await expect(marks.nth(weekDays.indexOf(day))).not.toHaveAccessibleName(/no pedía/);
    }
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});
