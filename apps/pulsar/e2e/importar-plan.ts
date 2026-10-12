import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { check } from "../lib/import/check";
import { normalize, type RawDraft, type Source } from "../lib/import/draft";
import type { StoredDraft } from "../lib/import/draft-store";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";
import { expect, settled } from "./fixtures";

// Shared by the `importar-*` specs of the tree review (RP-86–RP-98). Nothing here calls a model:
// a plan is the template (read on the server without one), a stored draft the review reads from
// the tab's storage, or a stream the page is handed in place of `/importar/leer`'s.

export const plus = (days: number) => {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
};

export function months() {
  const [year, month] = todayInZone().split("-").map(Number);
  const shift = (by: number) => {
    const index = year * 12 + (month - 1) + by;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
  };
  return { first: shift(0), second: shift(1), third: shift(2), later: shift(10) };
}

export const word = (month: string) =>
  new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" }).format(civilDateToDate(`${month}-01`));

export const GENERAL = "Carrera en IA";
export const BIG = "IA aplicada";
export const SMALL = "Ordenar la casa";
export const WEEK = "Semana 1";
export const SUB_A = "Figma parte 1";
export const SUB_B = "Cuentas de inglés";
export const TASK_A = "Leer capítulo";
export const TASK_B = "Entregar caso";
export const PHASE = "Portafolio base";
export const COMMITMENT = "Inglés diario";
export const GENERAL_NOTE_1 = "Reglas del plan: una cosa a la vez.";
export const GENERAL_NOTE_2 = "Un ritmo que pueda sostener.";
export const WEEK_NOTE = "Tres cosas pendientes en esta semana.";

// Three levels, a phase, two months (the first one's amount disagrees with its tasks: 10 h said,
// 5 h + 4 h written), a commitment, a week that is a task with two sub-tasks and a note, two tasks.
export function planText(): string {
  const { first, second } = months();
  return [
    "pulsar · plantilla 2",
    "",
    `# ${GENERAL}`,
    `horizonte: ${plus(500)}`,
    `nota: ${GENERAL_NOTE_1}`,
    `nota: ${GENERAL_NOTE_2}`,
    "",
    `# ${BIG}`,
    `horizonte: ${plus(400)}`,
    `dentro de: ${GENERAL}`,
    "",
    `# ${SMALL}`,
    `horizonte: ${plus(300)}`,
    `dentro de: ${BIG}`,
    "medida: horas de estudio · minutos",
    "ritmo: 20 h",
    "",
    "## Fases",
    `- ${second}-01 a ${second}-28 · ${PHASE}`,
    "",
    "## Meses",
    `- ${first} · 10 h`,
    `- ${second} · 6 h`,
    "",
    "## Compromisos",
    `- ${COMMITMENT} · martes y jueves · 2 h`,
    "",
    "## Tareas",
    `- ${first} · ${WEEK}`,
    `  nota: ${WEEK_NOTE}`,
    `  - 3 h · ${SUB_A}`,
    `  - 2 h · ${SUB_B}`,
    `- ${first} · 4 h · ${TASK_A}`,
    `- ${second} · 6 h · ${TASK_B}`,
  ].join("\n");
}

export const nonBlank = (text: string) => text.split("\n").filter((line) => line.trim() !== "").length;
export const lineOf = (text: string, needle: string) => text.split("\n").findIndex((line) => line.includes(needle)) + 1;

type Fixtures = { person: { id: string; sessionFile: string }; browser: Browser; baseURL: string | undefined };

export async function asPerson(
  { person, browser, baseURL }: Fixtures,
  run: (page: Page) => Promise<void>,
  viewport: { width: number; height: number } = { width: 360, height: 740 },
) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport,
    hasTouch: viewport.width < 1024,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

export async function toReview(page: Page, text: string) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: messages.read })).toBeVisible();
  await page.getByLabel(messages.textLabel, { exact: true }).fill(text);
  await page.getByRole("button", { name: messages.read }).click();
  await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await settled(page);
}

// A draft in the tab's storage (version 2), as `/importar/leer` would have left it for the review.
export type Seed = {
  raw: RawDraft;
  source: Source;
  via?: StoredDraft["via"];
  sourceName?: string | null;
};

export function stored({ raw, source, via = "model", sourceName = null }: Seed): StoredDraft {
  const { draft, corrections } = normalize(raw, source);
  const checked = check(draft);
  return {
    version: 2,
    via,
    draft,
    corrections: [...corrections, ...checked.corrections],
    notices: checked.notices,
    source,
    sourceName,
    unmarked: null,
    declined: [],
  };
}

const KEY = "pulsar.import-draft";

export async function toSeededReview(page: Page, seed: Seed) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: messages.read })).toBeVisible();
  await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [KEY, JSON.stringify(stored(seed))] as const);
  await page.goto("/metas/importar/revisar");
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await settled(page);
}

// What `/importar/leer` answers for a text the server reads with no model: the real payload,
// to hand back as a model's `done` line.
export async function readWithTemplate(page: Page, text: string) {
  const response = await page.request.post("/importar/leer", { multipart: { text } });
  expect(response.status()).toBe(200);
  return (await response.json()) as { via: string; draft: unknown; corrections: unknown; notices: unknown; source: unknown };
}

// Replaces the page's `fetch` of `/importar/leer` with the NDJSON stream a model read answers
// (RP-86, RNP-13): one line per step, `gap` ms apart, then `done` or an `error`.
export async function streamInPlaceOfModel(
  page: Page,
  tail: { done: unknown } | { error: string },
  gap = 900,
) {
  await page.addInitScript(
    ([lines, delay]) => {
      const real = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith("/importar/leer") || init?.method !== "POST") return real(input, init);
        const encoder = new TextEncoder();
        const body = new ReadableStream({
          start(controller) {
            lines.forEach((line, i) => {
              setTimeout(() => {
                controller.enqueue(encoder.encode(`${line}\n`));
                if (i === lines.length - 1) controller.close();
              }, i * delay);
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }));
      };
    },
    [
      "error" in tail
        ? [JSON.stringify({ step: "find" }), JSON.stringify({ error: tail.error })]
        : [JSON.stringify({ step: "find" }), JSON.stringify({ step: "arrange" }), JSON.stringify({ step: "check" }), JSON.stringify({ done: tail.done })],
      gap,
    ] as const,
  );
}

// Records, in the page itself, every distinct state the three steps are drawn in, and whether a
// step's words were ever on screen: a snapshot taken at the end would miss the middle.
export async function watchSteps(page: Page) {
  await page.addInitScript(
    ([find, arrange, check, hint]) => {
      const w = window as unknown as { __steps: string[]; __stepsSeen: boolean };
      w.__steps = [];
      w.__stepsSeen = false;
      const state = (name: string) => {
        const item = [...document.querySelectorAll("li")].find((li) => li.textContent?.includes(name));
        return item?.querySelector("[data-state]")?.getAttribute("data-state") ?? null;
      };
      const look = () => {
        if (document.body?.innerText?.includes(hint)) w.__stepsSeen = true;
        const now = [state(find), state(arrange), state(check)];
        if (now.some((s) => s === null)) return;
        const text = now.join("|");
        if (w.__steps[w.__steps.length - 1] !== text) w.__steps.push(text);
      };
      new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    },
    [messages.steps.find.name, messages.steps.arrange.name, messages.steps.check.name, messages.steps.find.hint] as const,
  );
}

export const stepsSeen = (page: Page) => page.evaluate(() => (window as unknown as { __steps: string[] }).__steps);
export const stepsEverDrawn = (page: Page) => page.evaluate(() => (window as unknown as { __stepsSeen: boolean }).__stepsSeen);

// The create button, whatever the count.
export const createButton = (page: Page) => page.getByRole("button", { name: /^Crear \d+ metas?$/ });

// «N líneas: P en el plan, M en notas, F fuera» → its four numbers.
export async function countOf(page: Page, unit: "líneas" | "filas" | "partes" = "líneas") {
  const line = page.getByText(new RegExp(`\\d+ ${unit}: \\d+ en el plan, \\d+ en notas, \\d+ fuera`)).first();
  await expect(line).toBeVisible();
  const text = (await line.textContent())!;
  const [, total, plan, notes, out] = text.match(new RegExp(`(\\d+) ${unit}: (\\d+) en el plan, (\\d+) en notas, (\\d+) fuera`))!;
  return { total: Number(total), plan: Number(plan), notes: Number(notes), out: Number(out), text };
}

