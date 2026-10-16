import type { Browser, Page, Request } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect, settled } from "./fixtures";

// Module 900, clauses 2-4 (boards ImportarAdjunto-1 and -2-tras-error). Picking a file only attaches it;
// «Leer el plan» sends it. The model is never reached: /importar/leer is intercepted.

const READ = "Leer el plan";
const BLANK = "No pegaste nada. Pega tu plan o sube un archivo.";
const UNREADABLE = "Ese tipo de archivo no se lee. Pega su texto en la caja.";
const ONLY_FILE = "Se lee el archivo; el texto de la caja no se envía.";
const PDF = { name: "Plan-2026.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nun plan") };
const DOCX = {
  name: "Roadmap 2026.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer: Buffer.from("PK\u0003\u0004docx"),
};

async function asPerson(
  { person, browser, baseURL }: { person: { sessionFile: string }; browser: Browser; baseURL: string | undefined },
  run: (page: Page, leer: Request[]) => Promise<void>,
  answer: { status: number; json: unknown } = { status: 415, json: { error: "import.errors.unreadableType" } },
  clock = false,
) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 800 } });
  try {
    const page = await context.newPage();
    if (clock) await page.clock.install();
    const leer: Request[] = [];
    await page.route("**/importar/leer", (route) => {
      leer.push(route.request());
      return route.fulfill(answer);
    });
    await page.goto("/metas/importar");
    await expect(page.getByRole("button", { name: READ })).toBeVisible();
    await settled(page);
    await run(page, leer);
  } finally {
    await context.close();
  }
}

const pick = (page: Page, file: typeof PDF) => page.getByLabel(messages.upload).setInputFiles(file);
const quit = (page: Page) => page.getByRole("button", { name: "Quitar" });

test("picking a PDF sends nothing; the file shows named with «Quitar»; «Leer el plan» sends it", async ({ person, browser, baseURL }) => {
  // Kills: onPick reading the file at once (a request leaves on pick), or the pick not naming the file.
  await asPerson({ person, browser, baseURL }, async (page, leer) => {
    await pick(page, PDF);
    await expect(page.getByText(PDF.name, { exact: true })).toBeVisible();
    await expect(quit(page)).toBeVisible();
    await page.clock.runFor(30_000);
    expect(leer).toHaveLength(0);
    await page.getByRole("button", { name: READ }).click();
    await expect.poll(() => leer.length).toBe(1);
    expect(leer[0].postDataBuffer()!.toString("latin1")).toContain(`filename="${PDF.name}"`);
    await page.clock.runFor(30_000);
    expect(leer).toHaveLength(1);
  }, undefined, true);
});

test("«Quitar» drops the file: its name goes, the picker returns, and nothing was sent", async ({ person, browser, baseURL }) => {
  // Kills: «Quitar» that leaves the file attached or sends it.
  await asPerson({ person, browser, baseURL }, async (page, leer) => {
    await pick(page, PDF);
    await expect(quit(page)).toBeVisible();
    await quit(page).click();
    await expect(page.getByText(PDF.name, { exact: true })).toHaveCount(0);
    await expect(quit(page)).toHaveCount(0);
    await expect(page.getByLabel(messages.upload)).toHaveCount(1);
    expect(leer).toHaveLength(0);
    await page.getByRole("button", { name: READ }).click();
    await expect(page.getByText(BLANK, { exact: true })).toBeVisible();
    expect(leer).toHaveLength(0);
  });
});

test("after a refused type the file stays named, the type's sentence stays, and a second «Leer el plan» never says «No pegaste nada»", async ({ person, browser, baseURL }) => {
  // Kills: the refusal clearing the file, so the next press finds an empty box and a blank.
  await asPerson({ person, browser, baseURL }, async (page, leer) => {
    await pick(page, DOCX);
    await expect(page.getByText(DOCX.name, { exact: true })).toBeVisible();
    const read = page.getByRole("button", { name: READ });
    await read.click();
    await expect(page.getByText(UNREADABLE, { exact: true })).toBeVisible();
    await expect.poll(() => leer.length).toBe(1);
    await expect(read).toBeEnabled();
    await read.click();
    await expect.poll(() => leer.length).toBe(2);
    await expect(page.getByText(UNREADABLE, { exact: true })).toBeVisible();
    await expect(page.getByText(BLANK, { exact: true })).toHaveCount(0);
    await expect(page.getByText(DOCX.name, { exact: true })).toBeVisible();
    await expect(quit(page)).toBeVisible();
  });
});

test("a file plus text in the box: the line says only the file is read, and the request carries the file, not the text", async ({ person, browser, baseURL }) => {
  // Kills: sending the box's text with (or instead of) the file; the line absent or shown with an empty box.
  await asPerson({ person, browser, baseURL }, async (page, leer) => {
    const typed = "Texto de la caja que no debe viajar";
    await pick(page, PDF);
    await expect(page.getByText(ONLY_FILE, { exact: true })).toHaveCount(0);
    await page.getByLabel(messages.textLabel).fill(typed);
    await expect(page.getByText(ONLY_FILE, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: READ }).click();
    await expect.poll(() => leer.length).toBe(1);
    const body = leer[0].postDataBuffer()!.toString("latin1");
    expect(body).toContain(`filename="${PDF.name}"`);
    expect(body).not.toContain(typed);
    expect(body).not.toContain('name="text"');
    await expect(page.getByLabel(messages.textLabel)).toHaveValue(typed);
  });
});
