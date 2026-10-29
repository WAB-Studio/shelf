import type { Browser, Locator, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { todayInZone } from "../lib/zone";
import { appAlerts, test, expect, settled as pageSettled } from "./fixtures";
import { boxOf } from "./box";

// Module 801. Boards `ImportarCabeceraRota`, `ImportarPrimeraLinea`, `ImportarErrorMarcaLinea`.
// The refusal that never reaches the model is asserted in scripts/plan/import-route.ts, where the model is a spy.

function shift(by: number) {
  const [year, month] = todayInZone().split("-").map(Number);
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: String((index % 12) + 1).padStart(2, "0") };
}
const M1 = `${shift(0).year}-${shift(0).month}`;
const M2 = `${shift(1).year}-${shift(1).month}`;
const HORIZON = `${shift(0).year + 1}-${shift(0).month}-17`;

const CUT_LINE = "Arréglala y vuelve a leer: las líneas de abajo no se pudieron leer.";
const MEASURE_SENTENCE = "La medida va como «medida: nombre · unidad».";
const FIRST_LINE_SENTENCE = "La primera línea va como «goallog · plantilla 2».";

const MONTH_BAD = `- ${M2} · 8 h`;
const SERIES_BAD = "- Series · martes · 30 min";
const TASK_BAD = `- ${M1} · 2 h · Comprar zapatillas`;

// Blank lines between sections push the later errors out of the box's view.
const gap = (n: number) => Array.from({ length: n }, () => "");
const plan = (head: string[], pad = 0) =>
  [
    ...head,
    "",
    "## Meses",
    `- ${M1} · 40 km`,
    MONTH_BAD,
    ...gap(pad),
    "## Compromisos",
    "- Fondo · sábado · 8 km",
    SERIES_BAD,
    ...gap(pad),
    "## Tareas",
    TASK_BAD,
    `- ${M2} · Inscribirme a la carrera`,
  ].join("\n");
const HEAD = ["pulsar · plantilla 1", "", "# Correr 10K", `horizonte: ${HORIZON}`, "medida: distancia · km"];
const BROKEN_HEAD = ["pulsar · plantilla 1", "", "# Correr 10K", `horizonte: ${HORIZON}`, "medida: distancia"];
const lineOf = (text: string, written: string) => text.split("\n").indexOf(written) + 1;

// Where the selection really sits, wrapped lines included: a hidden twin of the box laid out with its width, padding and type.
async function selectionSeen(box: Locator) {
  return box.evaluate((el: HTMLTextAreaElement) => {
    const s = getComputedStyle(el);
    const twin = document.createElement("div");
    for (const name of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "tabSize"] as const) {
      twin.style[name] = s[name];
    }
    twin.style.position = "absolute";
    twin.style.visibility = "hidden";
    twin.style.boxSizing = "border-box";
    twin.style.width = `${el.clientWidth}px`;
    twin.style.whiteSpace = "pre-wrap";
    twin.style.overflowWrap = "break-word";
    twin.textContent = el.value.slice(0, el.selectionStart);
    const span = document.createElement("span");
    span.textContent = el.value.slice(el.selectionStart, el.selectionEnd) || ".";
    twin.appendChild(span);
    document.body.appendChild(twin);
    const top = span.offsetTop;
    const height = span.offsetHeight;
    twin.remove();
    return {
      picked: el.value.slice(el.selectionStart, el.selectionEnd),
      // The line's rectangle in viewport coordinates, from the box's own rectangle.
      top: el.getBoundingClientRect().top + el.clientTop + top - el.scrollTop,
      bottom: el.getBoundingClientRect().top + el.clientTop + top + height - el.scrollTop,
      boxTop: el.getBoundingClientRect().top,
      innerHeight: window.innerHeight,
      inView: top >= el.scrollTop - 1 && top + height <= el.scrollTop + el.clientHeight + 1,
      scrolls: el.scrollHeight > el.clientHeight,
    };
  });
}

const SIZES = [
  { name: "390x844", viewport: { width: 390, height: 844 } },
  { name: "1440", viewport: { width: 1440, height: 900 } },
];

async function asPerson(
  { person, browser, baseURL }: { person: { sessionFile: string }; browser: Browser; baseURL: string | undefined },
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

async function paste(page: Page, text: string) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await pageSettled(page);
  await page.getByLabel(messages.textLabel).fill(text);
  await page.getByRole("button", { name: "Leer el plan" }).click();
}

const alertOf = (page: Page) => appAlerts(page).filter({ hasText: /\S/ });
const rowsOf = (alert: Locator) => alert.getByRole("button");

test.describe("a broken header cuts the reading (board ImportarCabeceraRota)", () => {
  test("row 1: «medida: distancia» answers one row with the measure sentence and the grey cut line, nothing below judged", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, SIZES[0].viewport, async (page) => {
      const text = plan(BROKEN_HEAD);
      await paste(page, text);
      const alert = alertOf(page);
      await expect(alert.getByText("1 línea por corregir", { exact: true })).toBeVisible();
      await expect(alert.getByText("líneas por corregir")).toHaveCount(0);
      const whole = (await alert.textContent()) ?? "";
      expect(whole).toContain(`Línea 5: «medida: distancia». ${MEASURE_SENTENCE}`);
      expect(whole.match(/Línea \d+:/g)).toHaveLength(1);
      expect(whole).not.toContain(MONTH_BAD);
      expect(whole).not.toContain(SERIES_BAD);
      expect(whole).not.toContain(TASK_BAD);

      const cut = alert.getByText(CUT_LINE, { exact: true });
      await expect(cut).toBeVisible();
      const row = alert.getByText("Línea 5:", { exact: false }).first();
      const [cutBox, rowBox] = [(await boxOf(cut)), (await boxOf(row))];
      expect(cutBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1);
      const colour = (el: Locator) => el.evaluate((node) => getComputedStyle(node).color);
      expect(await colour(cut)).not.toBe(await colour(alert.getByText("1 línea por corregir", { exact: true })));
    });
  });

  test("row 2: after a sound header all three errors are listed and the card has no cut line", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, SIZES[0].viewport, async (page) => {
      await paste(page, plan(HEAD));
      const alert = alertOf(page);
      await expect(alert.getByText("3 líneas por corregir", { exact: true })).toBeVisible();
      expect((await alert.textContent()) ?? "").not.toContain("Arréglala");
    });
  });
});

test.describe("a wrong first line is refused on the screen (board ImportarPrimeraLinea)", () => {
  test("«pulsar · plantilla 3»: one row on line 1 and the grey cut line", async ({ person, browser, baseURL }) => {
    await asPerson({ person, browser, baseURL }, SIZES[0].viewport, async (page) => {
      await paste(page, plan(HEAD).replace("pulsar · plantilla 1", "pulsar · plantilla 3"));
      const alert = alertOf(page);
      await expect(alert.getByText("1 línea por corregir", { exact: true })).toBeVisible();
      const whole = (await alert.textContent()) ?? "";
      expect(whole).toContain(`Línea 1: «pulsar · plantilla 3». ${FIRST_LINE_SENTENCE}`);
      expect(whole.match(/Línea \d+:/g)).toHaveLength(1);
      await expect(alert.getByText(CUT_LINE, { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/metas\/importar$/);
    });
  });
});

for (const size of SIZES) {
  test.describe(`tapping an error marks its line in the box, at ${size.name} (board ImportarErrorMarcaLinea)`, () => {
    test("focus lands on the error list after a reading with errors", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        await paste(page, plan(HEAD));
        const alert = alertOf(page);
        await expect(alert.getByText("3 líneas por corregir", { exact: true })).toBeVisible();
        await expect.poll(() => alert.evaluate((el) => el.contains(document.activeElement))).toBe(true);
        expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("TEXTAREA");
      });
    });

    test("each error is a button of 44 px or more, one per error", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        await paste(page, plan(HEAD));
        const alert = alertOf(page);
        await expect(alert.getByText("3 líneas por corregir", { exact: true })).toBeVisible();
        await expect(rowsOf(alert)).toHaveCount(3);
        for (const row of await rowsOf(alert).all()) {
          expect((await boxOf(row)).height).toBeGreaterThanOrEqual(44);
        }
      });
    });

    test("tapping a row focuses the box, selects exactly that line and brings it into view, in any order", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        const text = plan(HEAD, 60);
        await paste(page, text);
        const alert = alertOf(page);
        await expect(alert.getByText("3 líneas por corregir", { exact: true })).toBeVisible();
        const box = page.getByLabel(messages.textLabel);

        for (const written of [TASK_BAD, MONTH_BAD, SERIES_BAD]) {
          const n = lineOf(text, written);
          await rowsOf(alert).filter({ hasText: `Línea ${n}:` }).click();
          await expect(box).toBeFocused();
          const seen = await selectionSeen(box);
          expect(seen.scrolls, "the fixture must overflow the box").toBe(true);
          expect(seen.picked).toBe(written);
          expect(seen.inView, `${written} in view`).toBe(true);
        }
      });
    });

    test("with long wrapping lines above, a tapped row still brings its line into view", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        const long = "objetivo largo ".repeat(10).trim();
        const phases = Array.from({ length: 12 }, (_, i) => {
          const month = String(i + 1).padStart(2, "0");
          return `- ${shift(0).year}-${month}-01 a ${shift(0).year}-${month}-20 · ${long}`;
        });
        const text = [
          ...HEAD, "", "## Fases", ...phases, "",
          "## Meses", `- ${M1} · 40 km`, MONTH_BAD, "",
          "## Compromisos", SERIES_BAD, "",
          "## Tareas", ...Array.from({ length: 4 }, () => `- ${M2} · Inscribirme ${long}`), TASK_BAD,
        ].join("\n");
        await paste(page, text);
        const alert = alertOf(page);
        await expect(rowsOf(alert).first()).toBeVisible();
        const box = page.getByLabel(messages.textLabel);
        for (const written of [TASK_BAD, MONTH_BAD, SERIES_BAD]) {
          await rowsOf(alert).filter({ hasText: `Línea ${lineOf(text, written)}:` }).click();
          const seen = await selectionSeen(box);
          expect(seen.scrolls).toBe(true);
          expect(seen.picked).toBe(written);
          expect(seen.inView, `${written} in view`).toBe(true);
        }
      });
    });

    test("tapping a row of a long error list brings the line into the screen, not only into the box, and keeps it there when the keyboard shrinks the screen", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        const long = "objetivo largo ".repeat(10).trim();
        const bad = Array.from({ length: 9 }, (_, i) => `- ${M1} · ${i + 2} h · Comprar zapatillas ${i + 1}`);
        const text = [
          ...HEAD, "", "## Tareas",
          ...bad.flatMap((line, i) => [line, `- ${M2} · Valida ${i} ${long}`]),
        ].join("\n");
        await paste(page, text);
        const alert = alertOf(page);
        await expect(rowsOf(alert).first()).toBeVisible();
        expect(await rowsOf(alert).count()).toBeGreaterThanOrEqual(8);
        const box = page.getByLabel(messages.textLabel);
        const visible = async (what: string) => {
          await expect
            .poll(async () => {
              const s = await selectionSeen(box);
              return s.top >= 0 && s.bottom <= s.innerHeight && s.boxTop >= 0 && s.inView;
            }, { message: what })
            .toBe(true);
        };
        const rows = await rowsOf(alert).count();
        for (const index of [rows - 1, 0, Math.floor(rows / 2)]) {
          await alert.scrollIntoViewIfNeeded();
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await rowsOf(alert).nth(index).click();
          await expect(box).toBeFocused();
          await visible(`row ${index} in the screen`);
          await page.setViewportSize({ width: size.viewport.width, height: 500 });
          await visible(`row ${index} in the screen with the keyboard up`);
          await page.setViewportSize(size.viewport);
        }
      });
    });

    test("a short error row is still a button of 44 px or more", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        await paste(page, "pulsar · plantilla 1\nhorizonte: 2027-10-01");
        const alert = alertOf(page);
        const row = rowsOf(alert).first();
        await expect(row).toBeVisible();
        expect((await boxOf(row)).height).toBeGreaterThanOrEqual(44);
      });
    });

    test("a broken-header row selects its header line", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        await paste(page, plan(BROKEN_HEAD));
        const alert = alertOf(page);
        await expect(alert.getByText("1 línea por corregir", { exact: true })).toBeVisible();
        await rowsOf(alert).filter({ hasText: "Línea 5:" }).click();
        const picked = await page.getByLabel(messages.textLabel).evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
        expect(picked).toBe("medida: distancia");
      });
    });

    test("the tapped row is marked with aria-current and the mark moves to the next one tapped", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        const text = plan(HEAD);
        await paste(page, text);
        const alert = alertOf(page);
        await expect(alert.getByText("3 líneas por corregir", { exact: true })).toBeVisible();
        const row = (written: string) => rowsOf(alert).filter({ hasText: `Línea ${lineOf(text, written)}:` });
        await expect(alert.locator('[aria-current="true"]')).toHaveCount(0);
        await row(MONTH_BAD).click();
        await expect(row(MONTH_BAD)).toHaveAttribute("aria-current", "true");
        await expect(alert.locator('[aria-current="true"]')).toHaveCount(1);
        await row(TASK_BAD).click();
        await expect(row(TASK_BAD)).toHaveAttribute("aria-current", "true");
        await expect(row(MONTH_BAD)).not.toHaveAttribute("aria-current", "true");
        await expect(alert.locator('[aria-current="true"]')).toHaveCount(1);
      });
    });
    test("reading again after a tap clears the mark: no row carries aria-current on the new list", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        const text = plan(HEAD);
        await paste(page, text);
        const alert = alertOf(page);
        await expect(alert.getByText("3 líneas por corregir", { exact: true })).toBeVisible();
        await rowsOf(alert).filter({ hasText: `Línea ${lineOf(text, MONTH_BAD)}:` }).click();
        await expect(alert.locator('[aria-current="true"]')).toHaveCount(1);

        const answered = page.waitForResponse((r) => r.url().includes("/importar/leer"));
        await page.getByRole("button", { name: "Leer el plan" }).click();
        await answered;
        await expect(alert.getByText("3 líneas por corregir", { exact: true })).toBeVisible();
        await expect(rowsOf(alert)).toHaveCount(3);
        await expect(alert.locator("[aria-current]")).toHaveCount(0);
      });
    });

    test("the box is marked invalid while the error list shows, and not before", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        await page.goto("/metas/importar");
        await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
        await pageSettled(page);
        const box = page.getByLabel(messages.textLabel);
        await expect(box).not.toHaveAttribute("aria-invalid", "true");
        await box.fill(plan(HEAD));
        await expect(box).not.toHaveAttribute("aria-invalid", "true");
        await page.getByRole("button", { name: "Leer el plan" }).click();
        await expect(alertOf(page).getByText("3 líneas por corregir", { exact: true })).toBeVisible();
        await expect(box).toHaveAttribute("aria-invalid", "true");
      });
    });

    test("a refusal that is not a list of lines takes no focus and its box is not marked invalid", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        await page.goto("/metas/importar");
        await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
        await pageSettled(page);
        await page.getByRole("button", { name: "Leer el plan" }).click();
        const alert = alertOf(page);
        await expect(alert).toBeVisible();
        await expect(alert).not.toHaveAttribute("tabindex", /.*/);
        await expect(page.getByLabel(messages.textLabel)).not.toHaveAttribute("aria-invalid", "true");
      });
    });

    test("a line under very long unbroken words is still brought into view", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        const url = `https://ejemplo.test/${"a".repeat(180)}`;
        const text = [
          ...HEAD, "", "## Meses", `- ${M1} · 40 km`, MONTH_BAD, "",
          "## Tareas", ...Array.from({ length: 10 }, () => `- ${M2} · ${url}`), TASK_BAD,
        ].join("\n");
        await paste(page, text);
        const alert = alertOf(page);
        await expect(rowsOf(alert).first()).toBeVisible();
        const box = page.getByLabel(messages.textLabel);
        await rowsOf(alert).filter({ hasText: `Línea ${lineOf(text, TASK_BAD)}:` }).click();
        const seen = await selectionSeen(box);
        expect(seen.scrolls).toBe(true);
        expect(seen.picked).toBe(TASK_BAD);
        expect(seen.inView).toBe(true);
      });
    });

    test("an error that points past the last line selects the empty line and brings it into view", async ({ person, browser, baseURL }) => {
      await asPerson({ person, browser, baseURL }, size.viewport, async (page) => {
        // The header is the only text: the missing goal is reported on the empty line after it.
        const text = `${"\n".repeat(40)}pulsar · plantilla 1\n`;
        await paste(page, text);
        const alert = alertOf(page);
        await expect(rowsOf(alert)).toHaveCount(1);
        const box = page.getByLabel(messages.textLabel);
        await rowsOf(alert).first().click();
        const seen = await selectionSeen(box);
        expect(seen.scrolls).toBe(true);
        expect(seen.picked).toBe("");
        expect(seen.inView).toBe(true);
      });
    });
  });
}
