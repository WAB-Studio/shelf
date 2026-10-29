import type { Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { appAlerts, test, expect, settled as pageSettled } from "./fixtures";
import { asPerson, movedExample, toOpenReview } from "./importar-plan";

// The page always carries Next's own empty `role="alert"` route announcer, so an
// alert is the one with text in it.
//
// Against the ordinary server, which holds no model key (`OPENAI_API_KEY=""`):
// the template reads without one, anything else answers 503, and no claim is
// ever written (RP-37, RNP-13). The boards are `Importar*.dc.html`.
const EXAMPLE = messages.template.example;
// The example's own month line, counted from 1 as the parser names it.
const BROKEN_LINE = EXAMPLE.split("\n").indexOf("- 2026-11 · 20 h") + 1;
const PRIVACY = messages.privacy;
const NO_KEY = messages.errors.noKey;

// `load` fires with the loading fallback still standing; the screen is settled
// when its button is there.
async function settled(page: Page) {
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await pageSettled(page);
}

// «Línea N: «<line as written>». <what is missing or misplaced>.» The second sentence
// names the cause and never says the written line a second time.
async function expectLineError(page: Page, line: number, written: string) {
  const alert = appAlerts(page).filter({ hasText: /\S/ });
  const escaped = written.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(alert).toHaveText(new RegExp(`^\\d+ líneas? por corregirLínea ${line}: «${escaped}»\\. \\S[\\s\\S]*\\.$`));
  const whole = ((await alert.textContent()) ?? "").replace(/^\d+ líneas? por corregir/, "");
  const sentence = whole.slice(`Línea ${line}: «${written}». `.length);
  expect(sentence, "the cause").not.toContain(written);
  expect(sentence.startsWith(`Esperaba ${written}`)).toBe(false);
  expect(whole.split(written)).toHaveLength(2);
}

async function boxOf(locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box");
  return box;
}

test.describe("the import screen (RP-37)", () => {
  test("the header's way back, «Volver a Metas», lands on /metas, and the page has one h1", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await settled(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await page.getByRole("link", { name: "Volver a Metas", exact: true }).click();
      await expect(page).toHaveURL(/\/metas$/);
    } finally {
      await context.close();
    }
  });

  test("the privacy line is visible before any send, above «Leer el plan»", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await settled(page);

      const privacy = page.getByText(PRIVACY, { exact: true });
      await expect(privacy).toBeVisible();
      const read = await boxOf(page.getByRole("button", { name: "Leer el plan" }));
      expect((await boxOf(privacy)).y).toBeLessThan(read.y);
    } finally {
      await context.close();
    }
  });

  test("a pasted text outside the template answers the missing key, keeps the text and writes no claim", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await settled(page);

      const text = "Octubre: leer el capítulo uno. Noviembre: el dos.";
      const area = page.getByLabel(messages.textLabel);
      await area.fill(text);
      await page.getByRole("button", { name: "Leer el plan" }).click();

      const alert = appAlerts(page).filter({ hasText: /\S/ });
      await expect(alert).toHaveText(NO_KEY);
      // The box sits above the text area, and the upload is shut.
      expect((await boxOf(alert)).y).toBeLessThan((await boxOf(area)).y);
      await expect(page.getByLabel(messages.upload)).toBeDisabled();
      await expect(area).toHaveValue(text);
      await expect(page.getByRole("button", { name: "ver la plantilla" })).toBeVisible();
      await expect(page).toHaveURL(/\/metas\/importar$/);

      const rows = await db`select 1 from goals.model_calls where user_id = ${person.id}`;
      expect(rows).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  test("the catalogue's template example, pasted, lands on the review without a key", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await settled(page);

      await page.getByLabel(messages.textLabel).fill(EXAMPLE);
      await page.getByRole("button", { name: "Leer el plan" }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);

      const rows = await db`select 1 from goals.model_calls where user_id = ${person.id}`;
      expect(rows).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  test("the example's last goal, «Leer», is read with no end and a rhythm of 40 pages", async ({ person, browser, baseURL }) => {
    // Kills: a default horizon for a goal the template gives none.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, movedExample());
      await expect(page.getByText("meta · sin final")).toBeVisible();
      await expect(page.getByRole("button", { name: "Cambiar el ritmo, 40 páginas al mes", exact: true })).toBeVisible();
    });
  });

  test("the text last read is in the box when the screen opens again, and a file read leaves it empty", async ({
    person,
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await settled(page);
      await expect(page.getByLabel(messages.textLabel)).toHaveValue("");

      await page.getByLabel(messages.textLabel).fill(EXAMPLE);
      await page.getByRole("button", { name: "Leer el plan" }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);

      await page.goto("/metas/importar");
      await settled(page);
      await expect(page.getByLabel(messages.textLabel)).toHaveValue(EXAMPLE);

      await page.getByLabel(messages.upload).setInputFiles({
        name: "plan.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(EXAMPLE),
      });
      await page.getByRole("button", { name: messages.read }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);

      await page.goto("/metas/importar");
      await settled(page);
      await expect(page.getByLabel(messages.textLabel)).toHaveValue("");
    } finally {
      await context.close();
    }
  });

  test("the example with a broken month line names the line and keeps the text", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await settled(page);

      const broken = EXAMPLE.replace("- 2026-11 · 20 h", "- 2026-13 · 20 h");
      const area = page.getByLabel(messages.textLabel);
      await area.fill(broken);
      await page.getByRole("button", { name: "Leer el plan" }).click();

      await expectLineError(page, BROKEN_LINE, "- 2026-13 · 20 h");
      await expect(area).toHaveValue(broken);
      await expect(page).toHaveURL(/\/metas\/importar$/);

      // The template is hidden after the failure; one tap on «ver la plantilla» brings it back.
      await expect(page.getByRole("button", { name: "copiar la plantilla" })).toHaveCount(0);
      await page.getByRole("button", { name: "ver la plantilla" }).click();
      await expect(page.getByRole("button", { name: "copiar la plantilla" })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("an uploaded text file with a broken month line quotes that line", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await settled(page);

      await page.getByLabel(messages.upload).setInputFiles({
        name: "plan.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(EXAMPLE.replace("- 2026-11 · 20 h", "- 2026-13 · 20 h")),
      });
      await page.getByRole("button", { name: messages.read }).click();
      await expectLineError(page, BROKEN_LINE, "- 2026-13 · 20 h");
    } finally {
      await context.close();
    }
  });

  test("a text with nothing in it answers the empty notice and offers the template", async ({
    person,
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await settled(page);

      await page.route("**/importar/leer", (route) =>
        route.fulfill({ status: 422, json: { error: "import.errors.empty" } }),
      );
      await page.getByLabel(messages.textLabel).fill("algo sin metas");
      await page.getByRole("button", { name: "Leer el plan" }).click();
      await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveText(messages.errors.empty);
      await page.getByRole("button", { name: "ver la plantilla" }).click();
      await expect(page.getByRole("button", { name: "copiar la plantilla" })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("a blank box answers the blank notice without sending anything", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      let sent = 0;
      await page.route("**/importar/leer", (route) => {
        sent += 1;
        return route.fulfill({ status: 422, json: { error: "import.errors.empty" } });
      });
      await page.goto("/metas/importar");
      await settled(page);

      await page.getByLabel(messages.textLabel).fill("   \n ");
      await page.getByRole("button", { name: "Leer el plan" }).click();
      await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveText(messages.errors.blank);
      expect(sent).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("a 5 MB file shows the size notice without sending it", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      let sent = 0;
      page.on("request", (request) => {
        if (request.url().endsWith("/importar/leer")) sent += 1;
      });
      await page.goto("/metas/importar");
      await settled(page);

      await page.getByLabel(messages.upload).setInputFiles({
        name: "roadmap-escaneado.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.alloc(5 * 1024 * 1024, 1),
      });
      await page.getByRole("button", { name: messages.read }).click();
      await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveText(
        "«roadmap-escaneado.pdf» pesa 5 MB y el tope es 4 MB. Pega su texto en la caja.",
      );
      expect(sent).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("while it reads, the button says so and the text and the upload are shut", async ({
    person,
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/importar/leer", async (route) => {
        await gate;
        await route.fulfill({ status: 503, json: { error: "import.errors.noKey" } });
      });
      await page.goto("/metas/importar");
      await settled(page);

      await page.getByLabel(messages.textLabel).fill("algo que leer");
      await page.getByRole("button", { name: "Leer el plan" }).click();

      const reading = page.getByRole("button", { name: "Leyendo el plan…" });
      await expect(reading).toBeDisabled();
      await expect(reading).toHaveAttribute("aria-busy", "true");
      await expect(page.getByText(messages.slow, { exact: true })).toBeVisible();
      await expect(page.getByLabel(messages.textLabel)).toBeDisabled();
      await expect(page.getByLabel(messages.upload)).toBeDisabled();

      release();
      await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveText(NO_KEY);
    } finally {
      await context.close();
    }
  });

  for (const width of [360, 1280]) {
    test(`at ${width} the screen holds: nothing overflows and the template shows`, async ({
      person,
      browser,
      baseURL,
    }) => {
      const context = await browser.newContext({
        storageState: person.sessionFile,
        baseURL: baseURL!,
        viewport: { width, height: 800 },
      });
      try {
        const page = await context.newPage();
        await page.goto("/metas/importar");
        await settled(page);

        await expect(page.getByText(PRIVACY, { exact: true })).toBeVisible();
        await expect(page.getByText(messages.template.note, { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "copiar la plantilla" })).toBeVisible();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        const read = await boxOf(page.getByRole("button", { name: "Leer el plan" }));
        expect(read.x).toBeGreaterThanOrEqual(0);
        expect(read.x + read.width).toBeLessThanOrEqual(width);
      } finally {
        await context.close();
      }
    });

    test(`at ${width} a broken line shows «ver la plantilla» under its error and nothing overflows`, async ({
      person,
      browser,
      baseURL,
    }) => {
      const context = await browser.newContext({
        storageState: person.sessionFile,
        baseURL: baseURL!,
        viewport: { width, height: 800 },
      });
      try {
        const page = await context.newPage();
        await page.goto("/metas/importar");
        await settled(page);

        await page.getByLabel(messages.textLabel).fill(EXAMPLE.replace("- 2026-11 · 20 h", "- 2026-13 · 20 h"));
        await page.getByRole("button", { name: "Leer el plan" }).click();
        const alert = appAlerts(page).filter({ hasText: `Línea ${BROKEN_LINE}:` });
        await expect(alert).toBeVisible();
        const show = page.getByRole("button", { name: "ver la plantilla" });
        await expect(show).toBeVisible();
        expect((await boxOf(show)).y).toBeGreaterThan((await boxOf(alert)).y);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    });
  }

  for (const width of [360, 1280]) {
    test(`the header repeats nothing and the quiet lines read in Archivo at ${width}`, async ({ person, browser, baseURL }) => {
      const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 800 } });
      try {
        const page = await context.newPage();
        await page.goto("/metas/importar");
        await settled(page);
        // The way back and the title line: no eyebrow that says «metas» twice.
        await expect(page.locator("main > header > *")).toHaveCount(2);
        for (const line of [messages.privacy, messages.template.note]) {
          const family = await page.getByText(line, { exact: true }).evaluate((el) => getComputedStyle(el).fontFamily);
          expect(family).not.toMatch(/mono/i);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        await context.close();
      }
    });
  }
});

// Board `ImportarErrorLinea`: a `ritmo:` line anywhere but right after `medida:`.
const BOARD_TEXT = [
  "pulsar · plantilla 1",
  "",
  "# IA aplicada",
  "horizonte: 2027-10-01",
  // The board draws «· horas»; «horas» does not count as time yet, so the unit the reader accepts today stands in.
  "medida: horas de estudio · minutos",
  "ritmo: 12 h",
  "",
  "## Meses",
  "- 2026-10 · 12 h",
  "ritmo: 10 h",
  "",
  "## Tareas",
  "- 2026-10 · 4 h · Leer AI Engineering",
].join("\n");
const BOARD_SENTENCE = "Línea 10: «ritmo: 10 h». El ritmo va justo después de «medida:», una sola vez por meta.";

for (const width of [390, 1440]) {
  test.describe(`the error of one line, at ${width} wide (RP-37, board ImportarErrorLinea)`, () => {
    test("a ritmo: out of place reads the board's sentence, under the text and above «Leer el plan»", async ({ person, browser, baseURL }) => {
      const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto("/metas/importar");
        await settled(page);
        const area = page.getByLabel(messages.textLabel);
        await area.fill(BOARD_TEXT);
        await page.getByRole("button", { name: "Leer el plan" }).click();

        const alert = appAlerts(page).filter({ hasText: /\S/ });
        await expect(alert).toHaveText(`1 línea por corregir${BOARD_SENTENCE}`);
        await expect(alert).toHaveCount(1);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Importar un plan");
        await expect(area).toHaveValue(BOARD_TEXT);
        await expect(page).toHaveURL(/\/metas\/importar$/);

        const areaBox = await boxOf(area);
        const alertBox = await boxOf(alert);
        await expect(page.getByRole("button", { name: "ver la plantilla" }).or(page.getByRole("link", { name: "ver la plantilla" }))).toBeVisible();
        const read = await boxOf(page.getByRole("button", { name: "Leer el plan" }));
        expect(alertBox.y).toBeGreaterThanOrEqual(areaBox.y + areaBox.height - 1);
        expect(read.y).toBeGreaterThanOrEqual(alertBox.y + alertBox.height - 1);
        expect(alertBox.x + alertBox.width).toBeLessThanOrEqual(width);

        // Bordered, in the ink: no red.
        const look = await alert.evaluate((node) => {
          const style = getComputedStyle(node);
          return { border: style.borderTopWidth, style: style.borderTopStyle, color: style.color };
        });
        expect(look.style).toBe("solid");
        expect(parseFloat(look.border)).toBeGreaterThan(0);
        const [r, g, b] = look.color.match(/\d+(\.\d+)?/g)!.map(Number);
        expect(r - Math.max(g, b), `colour ${look.color}`).toBeLessThan(40);
      } finally {
        await context.close();
      }
    });

    test("the written ritmo: appears once in the error, whatever its amount", async ({ person, browser, baseURL }) => {
      const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto("/metas/importar");
        await settled(page);
        await page.getByLabel(messages.textLabel).fill(BOARD_TEXT.replace("ritmo: 10 h", "ritmo: 12 h"));
        await page.getByRole("button", { name: "Leer el plan" }).click();
        await expectLineError(page, 10, "ritmo: 12 h");
        await expect(appAlerts(page).filter({ hasText: /\S/ })).toContainText("justo después de");
      } finally {
        await context.close();
      }
    });

    test("a ritmo: on a measure that is not time says so, not where it goes", async ({ person, browser, baseURL }) => {
      const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! , viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto("/metas/importar");
        await settled(page);
        await page.getByLabel(messages.textLabel).fill(BOARD_TEXT.replace("horas de estudio · minutos", "distancia · km"));
        await page.getByRole("button", { name: "Leer el plan" }).click();
        await expectLineError(page, 6, "ritmo: 12 h");
        await expect(appAlerts(page).filter({ hasText: /\S/ })).toContainText("tiempo");
        // 992: the reading goes on, so a later stray «ritmo:» also lists; line 6's own row is the one that must not say where it goes.
        await expect(appAlerts(page).filter({ hasText: /\S/ })).toContainText(/Línea 6: «ritmo: 12 h»\. El ritmo es un monto por mes/);
      } finally {
        await context.close();
      }
    });
  });
}
