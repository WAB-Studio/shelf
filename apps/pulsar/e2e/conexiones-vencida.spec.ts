import type { Browser, Locator, Page } from "@playwright/test";
import type { Sql } from "postgres";

import messages from "../messages/es/connections.json";
import { test, expect, type Person } from "./fixtures";
import { boxOf } from "./box";

// RNP-20 (a key or connection unused for 90 days no longer enters), RP-38,
// `ConexionesVencida`: the list says so, in the muted voice of a revoked row, with no «Revocar».
// Dates are fixed in the past so the words are exact; `expiredAt` is last use (or creation) + 90 days.
const DAY = 86_400_000;
const ago = (days: number, extraMs = 0) => new Date(Date.now() - days * DAY + extraMs);

async function openScreen(browser: Browser, baseURL: string, person: Person, width: number) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL,
    viewport: { width, height: width < 1024 ? 740 : 800 },
    hasTouch: width < 1024,
  });
  const page = await context.newPage();
  await page.goto("/conexiones");
  await expect(page.getByRole("heading", { level: 1, name: messages.title })).toBeVisible();
  return { context, page };
}

type Seed = {
  kind?: "personal" | "oauth";
  name: string;
  created: string | Date;
  used?: string | Date;
  revoked?: string | Date;
  expiresAt?: string | Date;
};

// `token_hash` is unique and never read back: a seeded row needs only a distinct one.
async function seed(db: Sql, person: Person, row: Seed) {
  const kind = row.kind ?? "personal";
  await db`
    insert into goals.access_tokens (user_id, kind, name, token_hash, hint, created_at, last_used_at, revoked_at, expires_at)
    values (${person.id}, ${kind}, ${row.name}, ${Buffer.from(`${row.name}-${Math.random()}`)},
      ${kind === "personal" ? "abcd" : null}, ${row.created}, ${row.used ?? null}, ${row.revoked ?? null},
      ${row.expiresAt ?? null})`;
}

// Dead rows older than 30 days sit behind a fold (RP-64); open every one that is shut.
async function openFolds(page: Page) {
  const shut = page.getByRole("button", { name: /que ya no entran?$/, expanded: false });
  while ((await shut.count()) > 0) await shut.first().click();
}

// A row is the flex line holding the name column and, for a live key, its button.
const rowOf = (page: Page, name: string): Locator =>
  page.getByText(name, { exact: true }).locator("xpath=ancestor::div[2]");

const nameColor = (page: Page, name: string) =>
  page.getByText(name, { exact: true }).evaluate((el) => getComputedStyle(el).color);

// Stale personal key: last used 2026-06-05, so it lapsed 2026-09-03.
const STALE = { name: "Portátil viejo", created: "2026-01-10T17:00:00Z", used: "2026-06-05T17:00:00Z" };
const STALE_WORDS = "venció el 3 sep 2026 · sin uso desde el 5 jun 2026";

for (const width of [390, 1440]) {
  test.describe(`an expired key or connection on /conexiones at ${width}`, () => {
    test("a key unused 91 days says when it lapsed and since when it sat unused", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, STALE);
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        await expect(page.getByText(messages.sections.keys, { exact: true })).toBeVisible();
        const row = rowOf(page, STALE.name);
        await expect(row.getByText(STALE_WORDS, { exact: true })).toBeVisible();
        expect(await row.innerText()).not.toContain("creada");
        expect(await row.innerText()).not.toContain("ya no entra");
      } finally {
        await context.close();
      }
    });

    test("a key last used 91 days ago has lapsed and one used 89 days ago has not", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, { name: "Hace 91", created: ago(200), used: ago(91) });
      await seed(db, person, { name: "Hace 89", created: ago(200), used: ago(89) });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        await expect(rowOf(page, "Hace 91").getByText(/^venció el .* · sin uso desde el .*$/)).toBeVisible();
        await expect(rowOf(page, "Hace 91").getByRole("button", { name: /^Revocar/ })).toHaveCount(0);
        await expect(rowOf(page, "Hace 89").getByText(/^creada el .* · usada el .*$/)).toBeVisible();
        await expect(rowOf(page, "Hace 89").getByRole("button", { name: messages.row.revoke })).toBeVisible();
        await expect(page.getByText(/^venció el /)).toHaveCount(1);
      } finally {
        await context.close();
      }
    });

    test("a key never used counts its 90 days from the day it was made", async ({ person, db, browser, baseURL }) => {
      await seed(db, person, { name: "Nunca usada", created: "2026-05-01T17:00:00Z" });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        await expect(
          rowOf(page, "Nunca usada").getByText("venció el 30 jul 2026 · sin usar", { exact: true }),
        ).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("a key never used says «sin usar» and never claims a «sin uso desde» it has no date for", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, { name: "Nunca usada", created: "2026-05-01T17:00:00Z" });
      await seed(db, person, STALE);
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        const never = rowOf(page, "Nunca usada");
        await expect(never.getByText("venció el 30 jul 2026 · sin usar", { exact: true })).toBeVisible();
        expect(await never.innerText()).not.toContain("sin uso desde");
        // The used one keeps the approved phrase.
        await expect(rowOf(page, STALE.name).getByText(STALE_WORDS, { exact: true })).toBeVisible();
        await expect(page.getByText(/sin uso desde/)).toHaveCount(1);
      } finally {
        await context.close();
      }
    });

    test("two lapsed keys each get a «crea otra» that shows the same words and is named after its key", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, { name: "servidor de pruebas", created: ago(120) });
      await seed(db, person, { name: "tablet", created: ago(300), used: ago(200) });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        for (const name of ["servidor de pruebas", "tablet"]) {
          const button = page.getByRole("button", { name: `crea otra en lugar de ${name}`, exact: true });
          await expect(button).toHaveCount(1);
          await expect(button).toHaveText("crea otra");
          await expect(rowOf(page, name).getByRole("button", { name: /^crea otra/ })).toHaveCount(1);
        }
        await expect(page.getByRole("button", { name: /^crea otra/ })).toHaveCount(2);
        await expect(page.getByText("crea otra", { exact: true })).toHaveCount(2);
      } finally {
        await context.close();
      }
    });

    test("a folded never-used lapsed key reads the same once the fold opens", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, { name: "Plegada", created: "2026-05-01T17:00:00Z" });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await expect(page.getByText("Plegada", { exact: true })).toBeHidden();
        await openFolds(page);
        await expect(rowOf(page, "Plegada").getByText("venció el 30 jul 2026 · sin usar", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "crea otra en lugar de Plegada", exact: true })).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("the expired row has no «Revocar» and is muted like a revoked one", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, STALE);
      await seed(db, person, { name: "Vigente", created: "2026-01-01T17:00:00Z", used: ago(0, -60_000) });
      await seed(db, person, {
        name: "Cerrada",
        created: "2026-01-01T17:00:00Z",
        used: "2026-02-01T17:00:00Z",
        revoked: "2026-02-02T17:00:00Z",
      });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        await expect(rowOf(page, STALE.name).getByRole("button", { name: /^Revocar/ })).toHaveCount(0);
        await expect(page.getByRole("button", { name: messages.row.revoke })).toHaveCount(1);
        const expired = await nameColor(page, STALE.name);
        expect(expired).toBe(await nameColor(page, "Cerrada"));
        expect(expired).not.toBe(await nameColor(page, "Vigente"));
      } finally {
        await context.close();
      }
    });

    test("a live key reads as before: used today and «Revocar»", async ({ person, db, browser, baseURL }) => {
      await seed(db, person, { name: "Viva", created: "2026-01-01T17:00:00Z", used: new Date() });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        const row = rowOf(page, "Viva");
        await expect(row.getByText(/^creada el 1 ene 2026 · usada hoy a las \d\d:\d\d$/)).toBeVisible();
        await expect(row.getByRole("button", { name: messages.row.revoke })).toBeVisible();
        await expect(page.getByText(/venció/)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("a revoked key unused for 100 days still reads «revocada», never «venció»", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, {
        name: "Revocada vieja",
        created: ago(300),
        used: ago(100),
        revoked: "2026-10-02T17:00:00Z",
      });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        const row = rowOf(page, "Revocada vieja");
        await expect(row.getByText("revocada el 2 oct 2026 · ya no entra", { exact: true })).toBeVisible();
        expect(await row.innerText()).not.toContain("venció");
        await expect(row.getByRole("button", { name: /^Revocar/ })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("a lapsed claude.ai connection has the same shape under its own section", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      // Same shape the grant leaves: `expires_at` an hour past the last use; it lapses 90 days past its start.
      await seed(db, person, {
        kind: "oauth",
        name: "Claude",
        created: "2026-06-03T17:00:00Z",
        expiresAt: "2026-06-03T18:00:00Z",
      });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        await expect(page.getByText(messages.sections.oauth, { exact: true })).toBeVisible();
        await expect(page.getByText(messages.sections.keys, { exact: true })).toHaveCount(0);
        const row = rowOf(page, "Claude");
        await expect(row.getByText("venció el 1 sep 2026 · sin usar", { exact: true })).toBeVisible();
        await expect(row.getByRole("button", { name: /^Revocar/ })).toHaveCount(0);
        expect(await row.innerText()).not.toContain("conectada");
      } finally {
        await context.close();
      }
    });

    test("a connection that lapsed half an hour ago is expired and one a day short of it is live", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      // Seeded as `scripts/mcp/token-query.ts` does.
      const lapsed = ago(90, -1_800_000);
      const live = ago(89);
      await seed(db, person, {
        kind: "oauth",
        name: "Lapsed",
        created: lapsed,
        expiresAt: new Date(lapsed.getTime() + 3_600_000),
      });
      await seed(db, person, {
        kind: "oauth",
        name: "Alive",
        created: live,
        expiresAt: new Date(live.getTime() + 3_600_000),
      });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        await expect(rowOf(page, "Lapsed").getByText(/^venció /)).toBeVisible();
        await expect(rowOf(page, "Lapsed").getByRole("button", { name: /^Revocar/ })).toHaveCount(0);
        await expect(rowOf(page, "Alive").getByText(/^conectada /)).toBeVisible();
        await expect(rowOf(page, "Alive").getByRole("button", { name: messages.row.revoke })).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("the list runs live, then expired, then revoked, whatever each one's age", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      // Created order is the reverse of the list order, so a plain newest-first sort fails.
      await seed(db, person, { name: "A viva", created: "2026-01-01T17:00:00Z", used: ago(1) });
      await seed(db, person, { name: "B vencida", created: "2026-02-01T17:00:00Z", used: "2026-03-01T17:00:00Z" });
      await seed(db, person, {
        name: "C revocada",
        created: "2026-03-01T17:00:00Z",
        used: "2026-03-02T17:00:00Z",
        revoked: "2026-03-03T17:00:00Z",
      });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        const y = async (name: string) => (await boxOf(page.getByText(name, { exact: true }))).y;
        const [live, expired, revoked] = [await y("A viva"), await y("B vencida"), await y("C revocada")];
        expect(live).toBeLessThan(expired);
        expect(expired).toBeLessThan(revoked);
      } finally {
        await context.close();
      }
    });

    test("with no keys the empty screen is as before and says nothing lapsed", async ({
      person,
      browser,
      baseURL,
    }) => {
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await openFolds(page);
        await expect(page.getByText(messages.sections.first, { exact: true })).toBeVisible();
        await expect(page.getByText(messages.sections.keys, { exact: true })).toHaveCount(0);
        await expect(page.getByText(/venció/)).toHaveCount(0);
        await expect(page.getByRole("button", { name: messages.row.revoke })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });
}

test("at 360 the expired rows do not overflow, long names included", async ({ person, db, browser, baseURL }) => {
  const long = "Mi portátil de la oficina con un nombre largo de verdad";
  await seed(db, person, { ...STALE, name: long });
  await seed(db, person, {
    kind: "oauth",
    name: "Claude",
    created: "2026-06-03T17:00:00Z",
    expiresAt: "2026-06-03T18:00:00Z",
  });
  const { context, page } = await openScreen(browser, baseURL!, person, 360);
  try {
    await openFolds(page);
    await expect(page.getByText(STALE_WORDS, { exact: true })).toBeVisible();
    await expect(page.getByText("venció el 1 sep 2026 · sin usar", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    for (const name of [long, "Claude"]) {
      const row = await rowOf(page, name).boundingBox();
      expect(row!.x + row!.width).toBeLessThanOrEqual(360);
    }
  } finally {
    await context.close();
  }
});
