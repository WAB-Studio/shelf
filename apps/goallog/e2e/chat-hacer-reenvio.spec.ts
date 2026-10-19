import type { Browser, Page } from "@playwright/test";

import { test, expect, type Person } from "./fixtures";
import chat from "../messages/es/chat.json";

// RP-92, RP-56: «Hacer» sends the change's own id as its request id, so a tap repeated after the answer was
// lost makes the goal once. Runs on `PULSAR_FAULT_BASE_URL` (the stubbed chat), like `chat-modelo.spec.ts`.

async function open(browser: Browser, baseURL: string, person: Person) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport: { width: 360, height: 740 }, hasTouch: true });
  const page = await context.newPage();
  await page.goto("/chat");
  return { context, page };
}

const hacer = (page: Page) => page.getByRole("button", { name: chat.do, exact: true });
const hacerTodo = (page: Page) => page.getByRole("button", { name: chat.doAll, exact: true });
const hechos = (page: Page) => page.getByText(chat.made, { exact: true });

async function send(page: Page, text: string) {
  await page.getByLabel(chat.field).fill(text);
  await page.getByRole("button", { name: chat.send, exact: true }).click();
}

// Lets the server answer the first `count` «Hacer» calls, then drops the answer on the way back.
async function loseAnswers(page: Page, count: number) {
  const bodies: string[] = [];
  let lost = 0;
  await page.route("**/chat", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || request.headers()["next-action"] === undefined) return route.continue();
    bodies.push(request.postData() ?? "");
    if (lost < count) {
      lost += 1;
      await route.fetch();
      return route.abort("failed");
    }
    return route.continue();
  });
  return bodies;
}

const named = (db: import("postgres").Sql, personId: string, ...names: string[]) =>
  db<{ name: string }[]>`select name from goals.goals where user_id = ${personId} and name = any(${names}) order by name`;

test.describe("«Hacer» resent after a lost answer (RP-92, RP-56)", () => {
  test("a tap repeated after the first answer was lost makes one goal and the change reads «hecho»", async ({ person, browser, baseURL, db }) => {
    // Kills: sending no request id from the screen.
    const { context, page } = await open(browser, baseURL!, person);
    try {
      const bodies = await loseAnswers(page, 1);
      await send(page, "crea la meta Ahorro");
      await expect(hacer(page)).toHaveCount(1);
      await hacer(page).click();
      await expect.poll(() => bodies.length).toBe(1);
      // Nothing came back: the change is still open and the button live.
      await expect(hacer(page)).toBeEnabled();
      await expect(hechos(page)).toHaveCount(0);
      await hacer(page).click();
      await expect(hechos(page)).toHaveCount(1);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect((await named(db, person.id, "Ahorro reenvío")).length).toBe(1);
    } finally {
      await context.close();
    }
  });

  test("«Hacer todo» after the first answer was lost makes each change once, each under its own id", async ({ person, browser, baseURL, db }) => {
    // Kills: one request id for every change.
    const { context, page } = await open(browser, baseURL!, person);
    try {
      const bodies = await loseAnswers(page, 1);
      await send(page, "crea dos metas");
      await expect(hacer(page)).toHaveCount(2);
      await hacerTodo(page).click();
      // The first answer was lost (it stays open); the loop went on and made the second.
      await expect(hechos(page)).toHaveCount(1);
      await expect(hacer(page)).toHaveCount(1);
      await hacer(page).click();
      await expect(hechos(page)).toHaveCount(2);
      // Call 1 (lost) and call 3 (the same change again) carry one id; call 2 is the other change's.
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).toBe(bodies[0]);
      expect(bodies[1]).not.toBe(bodies[0]);
      expect((await named(db, person.id, "Reenvío uno", "Reenvío dos")).map((g) => g.name)).toEqual(["Reenvío dos", "Reenvío uno"]);
    } finally {
      await context.close();
    }
  });
});
