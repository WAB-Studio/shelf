import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import messages from "../messages/es/import.json";
import { BIG, GENERAL, SMALL, asPerson, createButton, planText, toOpenReview } from "./importar-plan";

// RP-86, RP-92: «Crear plan» sends one request id kept with the draft, so a tap repeated after the answer was lost
// (even across a reload) writes the plan once. Nothing here calls a model.

const KEY = "pulsar.import-draft";
const storedId = (page: Page) => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).requestId as string | undefined, KEY);

// Drops the first `count` confirms: after the server answered them, or before they reach it. A reload after
// the server wrote shows a review with nothing left to create, so the reload case drops the call unsent.
async function loseAnswers(page: Page, count: number, reachServer = true) {
  const bodies: string[] = [];
  let lost = 0;
  await page.route("**/metas/importar/revisar", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || request.headers()["next-action"] === undefined) return route.continue();
    bodies.push(request.postData() ?? "");
    if (lost < count) {
      lost += 1;
      if (reachServer) await route.fetch();
      return route.abort("failed");
    }
    return route.continue();
  });
  return bodies;
}

const written = (db: import("postgres").Sql, personId: string) =>
  db<{ name: string }[]>`select name from goals.goals where user_id = ${personId} order by name`;

test.describe("«Crear» resent after a lost answer (RP-86, RP-92)", () => {
  test("the second tap sends the same id and the plan is written once", async ({ person, browser, baseURL, db }) => {
    // Kills: minting the id per tap.
    await asPerson({ person, browser, baseURL }, async (page) => {
      const bodies = await loseAnswers(page, 1);
      await toOpenReview(page, planText({ rhythm: false }));
      const id = await storedId(page);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      await createButton(page).click();
      await expect.poll(() => bodies.length).toBe(1);
      await expect(page.getByText(messages.review.failed)).toBeVisible();
      await expect(createButton(page)).toBeEnabled();
      expect(await storedId(page)).toBe(id);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[0]).toContain(id!);
      expect((await written(db, person.id)).map((g) => g.name)).toEqual([GENERAL, BIG, SMALL].sort());
    });
  });

  test("a reload between the taps keeps the id: the resent call is the same and the plan is written once", async ({ person, browser, baseURL, db }) => {
    // Kills: keeping the id in memory only.
    await asPerson({ person, browser, baseURL }, async (page) => {
      const bodies = await loseAnswers(page, 1, false);
      await toOpenReview(page, planText({ rhythm: false }));
      const id = await storedId(page);
      await createButton(page).click();
      await expect(page.getByText(messages.review.failed)).toBeVisible();
      await page.reload();
      await expect(createButton(page)).toBeVisible();
      expect(await storedId(page)).toBe(id);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      expect(bodies[1]).toBe(bodies[0]);
      expect((await written(db, person.id)).map((g) => g.name)).toEqual([GENERAL, BIG, SMALL].sort());
    });
  });

  test("while the call is in flight the button is shut and reads «Creando…»; done clears the draft and its id", async ({ person, browser, baseURL }) => {
    // Kills: keeping the id after `ok`.
    await asPerson({ person, browser, baseURL }, async (page) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/metas/importar/revisar", async (route) => {
        if (route.request().method() === "POST" && route.request().headers()["next-action"] !== undefined) await gate;
        await route.continue();
      });
      await toOpenReview(page, planText({ rhythm: false }));
      await createButton(page).click();
      await expect(page.getByRole("button", { name: messages.review.creating })).toBeDisabled();
      release();
      await expect(page).toHaveURL(/\/metas$/);
      expect(await page.evaluate((key) => sessionStorage.getItem(key), KEY)).toBeNull();
    });
  });
});
