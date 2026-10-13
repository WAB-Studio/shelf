import type { Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { appAlerts, test, expect, settled as pageSettled } from "./fixtures";

// The import box keeps what was typed before the page settled (RP-37).
// The page's JS is held by `page.route` until the typing is done, then released,
// so the person always types into the server's box and hydration always follows:
// no timer decides the order. Against the ordinary server (no model key): the
// template reads without one.
const STORED = messages.template.example;

// Five lines whose third, a head line before any «# name», is where the template reader stops.
const TYPED = "pulsar · plantilla 1\n\nhorizonte: pronto\nmedida: a · b\n";
const REPLACED = "pulsar · plantilla 1\n\n# Y\nmedida: c · d\n";

const READ = "Leer el plan";

async function settled(page: Page) {
  await expect(page.getByRole("button", { name: READ })).toBeVisible();
  await pageSettled(page);
}

// A valid read, so the tab's storage holds `STORED` as the last read's source.
async function storeARead(page: Page) {
  await page.goto("/metas/importar");
  await settled(page);
  await hydrated(page);
  await page.getByLabel(messages.textLabel).fill(STORED);
  await page.getByRole("button", { name: READ }).click();
  await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
}

// Holds every script chunk until `release()`; a visit then paints the server's
// box and nothing is interactive.
async function holdScripts(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/_next\/static\/chunks\/.*\.js/, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

// React marks a DOM node with its props key the moment it hydrates it.
async function hydrated(page: Page) {
  await page.waitForFunction(() => {
    const box = document.querySelector("textarea");
    return !!box && Object.keys(box).some((key) => key.startsWith("__reactProps$"));
  });
  // The client snapshot lands in the commit after the first hydrated paint.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function asPerson(
  { person, browser, baseURL }: { person: { sessionFile: string }; browser: import("@playwright/test").Browser; baseURL: string | undefined },
  run: (page: Page) => Promise<void>,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

test.describe("the import box keeps what was typed before the page settled (RP-37)", () => {
  test("text typed before hydration is the text after it, never the stored one", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await storeARead(page);
      const release = await holdScripts(page);
      await page.goto("/metas/importar", { waitUntil: "commit" });
      const box = page.getByLabel(messages.textLabel);
      await box.fill(TYPED);
      release();
      await hydrated(page);
      await expect(box).toHaveValue(TYPED);
      expect((await box.inputValue()).split("\n")).toHaveLength(TYPED.split("\n").length);
    });
  });

  test("select-all before hydration and typing after replaces the text, never joins it to the stored one", async ({
    person,
    browser,
    baseURL,
  }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await storeARead(page);
      const release = await holdScripts(page);
      await page.goto("/metas/importar", { waitUntil: "commit" });
      const box = page.getByLabel(messages.textLabel);
      await box.fill(TYPED);
      await box.press("Control+A");
      release();
      await hydrated(page);
      await page.keyboard.insertText(REPLACED);
      await expect(box).toHaveValue(REPLACED);
    });
  });

  test("«Leer el plan» reads the typed text: the error is its line 3, never a line of the stored one", async ({
    person,
    browser,
    baseURL,
  }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await storeARead(page);
      const release = await holdScripts(page);
      await page.goto("/metas/importar", { waitUntil: "commit" });
      await page.getByLabel(messages.textLabel).fill(TYPED);
      release();
      await hydrated(page);
      await page.getByRole("button", { name: READ }).click();
      const alert = appAlerts(page).filter({ hasText: /\S/ });
      await expect(alert).toHaveText(/^1 línea por corregirLínea 3: «horizonte: pronto»\. (?![\s\S]*Carrera)\S/);
    });
  });

  test("a return from the review with nothing typed shows the stored text, all of it", async ({ person, browser, baseURL }) => {
    // «Volver al texto» sits beside the source from 1024 px; under it the header's link carries the way back.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await storeARead(page);
      await page.getByRole("link", { name: messages.review.change, exact: true }).click();
      await expect(page).toHaveURL(/\/metas\/importar$/);
      await expect(page.getByLabel(messages.textLabel)).toHaveValue(STORED);
    }, { width: 1280, height: 900 });
  });

  test("a fresh visit with nothing stored shows an empty box and its placeholder", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await settled(page);
      const box = page.getByLabel(messages.textLabel);
      await expect(box).toHaveValue("");
      await expect(box).toHaveAttribute("placeholder", messages.placeholder);
    });
  });
});
