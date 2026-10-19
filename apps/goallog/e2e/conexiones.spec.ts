import { request as playwrightRequest, type APIResponse, type Page } from "@playwright/test";

import messages from "../messages/es/connections.json";
import { test, expect, type Person } from "./fixtures";
import { boxOf } from "./box";
import { civilDateToDate, todayInZone } from "@/lib/zone";

// RP-38, RNP-17 (`ConexionesVacio`, `ConexionesUna`, `ConexionesCreada`,
// `ConexionesRevocada`, `ConexionesFallo`): the key is drawn once, right after
// it is made, and no later render holds it.
const NAME = "Claude Code";
const KEY = /^pls_[A-Za-z0-9_-]{20,}$/;
// What `row.metaUnusedFirst` draws for a key made today and never used.
const FRESH_UNUSED = /^Creada hoy a las \d\d:\d\d · sin usar$/;

// 15:00Z lands on the same calendar day in any zone the specs run in; the day counted back from is Bogotá's.
function daysAgo(days: number): Date {
  const when = civilDateToDate(todayInZone());
  when.setUTCDate(when.getUTCDate() - days);
  when.setUTCHours(15, 0, 0, 0);
  return when;
}

async function openScreen(browser: import("@playwright/test").Browser, baseURL: string, person: Person, width = 360) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL,
    viewport: { width, height: width < 1024 ? 740 : 800 },
    hasTouch: width < 1024,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.goto("/conexiones");
  await expect(page.getByRole("button", { name: messages.create })).toBeVisible();
  return { context, page };
}

async function create(page: Page, name: string): Promise<string> {
  await page.getByLabel(messages.nameLabel).fill(name);
  await page.getByRole("button", { name: messages.create }).click();
  const key = page.locator("pre").first();
  await expect(key).toHaveText(KEY);
  return (await key.textContent())!;
}

// Under 1024 the tab, from 1024 the rail's item: either way only «Metas» is current.
async function expectMetasCurrent(page: Page) {
  const nav = page.getByRole("navigation");
  await expect(nav.locator("[aria-current]")).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "Metas", exact: true })).toHaveAttribute("aria-current", "page");
}

// Dead rows older than 30 days sit behind a fold (RP-64); open every one that is shut.
async function openFolds(page: Page) {
  const shut = page.getByRole("button", { name: /que ya no entran?$/, expanded: false });
  while ((await shut.count()) > 0) await shut.first().click();
}

// The row's button only asks; the sheet's own «Revocar» is what revokes.
async function confirmRevoke(page: Page) {
  await page.getByRole("button", { name: messages.row.revoke }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: messages.revokeSheet.confirm }).click();
  await expect(sheet).toHaveCount(0);
}

// The server rendered nothing a later visit can read the key from.
async function absentEverywhere(page: Page, key: string) {
  expect(await page.content()).not.toContain(key);
  expect(page.url()).not.toContain(key);
  expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain(key);
}

async function mcp(baseURL: string, key: string): Promise<APIResponse> {
  const api = await playwrightRequest.newContext({ baseURL });
  try {
    return await api.post("/mcp", {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "spec", version: "1" } },
      },
    });
  } finally {
    await api.dispose();
  }
}

test.describe("the connections screen (RP-38)", () => {
  test("with no key it reads the empty board and offers the first key and the connector", async ({
    person,
    browser,
    baseURL,
  }) => {
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      await expect(page.getByRole("heading", { level: 1, name: messages.title })).toBeVisible();
      await expectMetasCurrent(page);
      await expect(page.getByText(messages.intro, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.sections.first, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.nameHint, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.connector.note, { exact: true })).toBeVisible();
      await expect(page.locator("pre").first()).toHaveText(/\/mcp$/);
      await expect(page.getByText(messages.sections.keys, { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: messages.row.revoke })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("a created key shows once with its command, then lives in no render", async ({ person, browser, baseURL, db }) => {
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      const key = await create(page, NAME);

      await expect(page.getByText(messages.created.once, { exact: true })).toBeVisible();
      await expect(page.getByRole("note")).toHaveText(messages.created.once);
      await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
      const command = page.locator("pre").nth(1);
      await expect(command).toContainText("/mcp");
      await expect(command).toContainText(key);
      await expect(command).toContainText("claude mcp add --transport http goallog ");

      await page.getByRole("button", { name: messages.created.copyName }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);

      // The database keeps a hash and the last four letters, never the key.
      const stored = await db`select hint, token_hash from goals.access_tokens where user_id = ${person.id}`;
      expect(stored).toHaveLength(1);
      expect(stored[0].hint).toBe(key.slice(-4));
      expect(Buffer.from(stored[0].token_hash).includes(Buffer.from(key))).toBe(false);
      // No column of the row, whole, carries the key.
      const [row] = await db`select to_jsonb(t)::text as doc from goals.access_tokens t where user_id = ${person.id}`;
      expect(row.doc).not.toContain(key);

      await page.reload();
      await expect(page.getByRole("button", { name: messages.create })).toBeVisible();
      await absentEverywhere(page, key);
      await expect(page.getByText(NAME, { exact: true })).toBeVisible();
      await expect(page.getByText(FRESH_UNUSED)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("«Listo» returns to the list, and a reload after it holds no key", async ({ person, browser, baseURL }) => {
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      const key = await create(page, NAME);
      await page.getByRole("button", { name: messages.created.done }).click();

      await expect(page.getByText(messages.sections.keys, { exact: true })).toBeVisible();
      await expect(page.getByText(NAME, { exact: true })).toBeVisible();
      await absentEverywhere(page, key);

      await page.reload();
      await expect(page.getByText(NAME, { exact: true })).toBeVisible();
      await absentEverywhere(page, key);
      expect(await (await page.request.get("/conexiones")).text()).not.toContain(key);
    } finally {
      await context.close();
    }
  });

  test("the key works at /mcp, stamps its last use, and «Revocar» shuts it", async ({ person, browser, baseURL }) => {
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      const key = await create(page, NAME);
      await page.getByRole("button", { name: messages.created.done }).click();
      await expect(page.getByText(FRESH_UNUSED)).toBeVisible();

      expect((await mcp(baseURL!, key)).status()).toBe(200);
      await page.reload();
      await expect(page.getByText(FRESH_UNUSED)).toHaveCount(0);
      await expect(page.getByText(/usada hoy a las \d\d:\d\d$/)).toBeVisible();

      await confirmRevoke(page);
      await expect(page.getByText(/^revocada el .* · ya no entra$/)).toBeVisible();
      await expect(page.getByRole("button", { name: messages.row.revoke })).toHaveCount(0);
      expect((await mcp(baseURL!, key)).status()).toBe(401);

      // Still listed after a reload: a revoked key is never deleted.
      await page.reload();
      await expect(page.getByText(NAME, { exact: true })).toBeVisible();
      await expect(page.getByText(/^revocada el /)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  // `token_hash` is unique and never read back: a seeded row needs only a distinct one.
  async function seed(
    db: import("postgres").Sql,
    person: Person,
    row: { kind: "personal" | "oauth"; name: string; created: string; revoked?: string; used?: string },
  ) {
    await db`
      insert into goals.access_tokens (user_id, kind, name, token_hash, hint, created_at, last_used_at, revoked_at)
      values (${person.id}, ${row.kind}, ${row.name}, ${Buffer.from(`${row.name}-${Math.random()}`)},
        ${row.kind === "personal" ? "abcd" : null}, ${row.created}, ${row.used ?? null}, ${row.revoked ?? null})`;
  }

  test("live keys are listed before revoked ones, even when the revoked one is newer", async ({
    person,
    db,
    browser,
    baseURL,
  }) => {
    await seed(db, person, { kind: "personal", name: "Vieja viva", created: daysAgo(30).toISOString() });
    await seed(db, person, {
      kind: "personal",
      name: "Nueva revocada",
      created: daysAgo(20).toISOString(),
      revoked: daysAgo(19).toISOString(),
    });
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      const text = await page.locator("main").innerText();
      expect(text.indexOf("Vieja viva")).toBeGreaterThan(-1);
      expect(text.indexOf("Vieja viva")).toBeLessThan(text.indexOf("Nueva revocada"));
    } finally {
      await context.close();
    }
  });

  test("a claude.ai connection has its own section and «Revocar» shuts it", async ({
    person,
    db,
    browser,
    baseURL,
  }) => {
    const created = daysAgo(10);
    const used = daysAgo(9);
    await seed(db, person, {
      kind: "oauth",
      name: "Claude",
      created: created.toISOString(),
      used: used.toISOString(),
    });
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      await expect(page.getByText(messages.sections.oauth, { exact: true })).toBeVisible();
      await expect(page.getByText("Claude", { exact: true })).toBeVisible();
      const stamp = (d: Date) => `${d.getUTCDate()} \\p{L}+\\.? ${d.getUTCFullYear()}`;
      await expect(
        page.getByText(new RegExp(`^conectada el ${stamp(created)} · usada el ${stamp(used)} \\d\\d:\\d\\d$`, "u")),
      ).toBeVisible();
      await expect(page.getByText(messages.sections.keys, { exact: true })).toHaveCount(0);

      await confirmRevoke(page);
      await expect(page.getByText(/^revocada el .* · ya no entra$/)).toBeVisible();
      await expect(page.getByRole("button", { name: messages.row.revoke })).toHaveCount(0);
      const [row] = await db`select revoked_at from goals.access_tokens where user_id = ${person.id}`;
      expect(row.revoked_at).not.toBeNull();
    } finally {
      await context.close();
    }
  });

  test("revoking a key already revoked elsewhere refreshes the list and shows no failure", async ({
    person,
    db,
    browser,
    baseURL,
  }) => {
    await seed(db, person, { kind: "personal", name: "Doble", created: new Date().toISOString() });
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      await db`update goals.access_tokens set revoked_at = now() where user_id = ${person.id}`;
      await confirmRevoke(page);
      await expect(page.getByText(/^revocada el .* · ya no entra$/)).toBeVisible();
      await expect(page.getByRole("button", { name: messages.row.revoke })).toHaveCount(0);
      await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("an empty name and a name already taken say why and keep the field", async ({ person, browser, baseURL }) => {
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      await page.getByRole("button", { name: messages.create }).click();
      await expect(page.getByText(messages.errors.nameEmpty, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.nameHint, { exact: true })).toHaveCount(0);

      await create(page, NAME);
      await page.getByRole("button", { name: messages.created.done }).click();

      await page.getByLabel(messages.nameLabel).fill(NAME);
      await page.getByRole("button", { name: messages.create }).click();
      await expect(page.getByText(messages.errors.nameTaken, { exact: true })).toBeVisible();
      await expect(page.getByLabel(messages.nameLabel)).toHaveValue(NAME);
    } finally {
      await context.close();
    }
  });

  for (const width of [360, 1280]) {
    test(`holds at ${width}: no sideways scroll on the list or on the key`, async ({ person, browser, baseURL }) => {
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(await overflow()).toBeLessThanOrEqual(0);
        await expectMetasCurrent(page);

        await create(page, NAME);
        expect(await overflow()).toBeLessThanOrEqual(0);
        await expect(page.getByRole("button", { name: messages.created.done })).toBeVisible();

        await page.getByRole("button", { name: messages.created.done }).click();
        await expect(page.getByRole("button", { name: messages.row.revoke })).toBeVisible();
        expect(await overflow()).toBeLessThanOrEqual(0);
        // 44px at least, the target the design asks of a row's act.
        const box = await page.getByRole("button", { name: messages.row.revoke }).boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      } finally {
        await context.close();
      }
    });
  }

  test("a fresh key reads «creada hoy … · sin usar», never «usada sin usar»", async ({ person, browser, baseURL }) => {
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      await create(page, NAME);
      await page.getByRole("button", { name: messages.created.done }).click();
      await expect(page.getByText(/^Creada hoy a las \d\d:\d\d · sin usar$/)).toBeVisible();
      expect(await page.locator("main").innerText()).not.toContain("usada sin usar");
      // 318: a key's row is a row (56 px, padded), and the header carries no second eyebrow over the title.
      const row = page.getByText(NAME, { exact: true }).locator("xpath=ancestor::div[2]");
      expect((await boxOf(row)).height).toBeGreaterThanOrEqual(56);
      // The chat entry's row (`ChatEntrada`) is not an eyebrow.
      await expect(page.locator('main > header > div:not(:has(a[href="/chat"]))')).toHaveCount(1);
      await expect(
        page.getByText("Claude lee tus metas, anota lo hecho y reorganiza tus meses. Nunca borra ni archiva.", { exact: true }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("«Revocar» asks first, «Dejarla» closes the sheet and the key still works", async ({
    person,
    browser,
    baseURL,
  }) => {
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      const key = await create(page, NAME);
      await page.getByRole("button", { name: messages.created.done }).click();

      await page.getByRole("button", { name: messages.row.revoke }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByRole("heading", { name: `¿Revocar «${NAME}»?` })).toBeVisible();
      await expect(sheet.getByText(messages.revokeSheet.keyLabel, { exact: true })).toBeVisible();
      await expect(sheet.getByText(messages.revokeSheet.keyBody, { exact: true })).toBeVisible();
      expect((await mcp(baseURL!, key)).status()).toBe(200);

      await sheet.getByRole("button", { name: messages.revokeSheet.cancel }).click();
      await expect(sheet).toHaveCount(0);
      await expect(page.getByRole("button", { name: messages.row.revoke })).toBeVisible();
      expect((await mcp(baseURL!, key)).status()).toBe(200);
    } finally {
      await context.close();
    }
  });

  test("a claude.ai connection asks first too, in its own words", async ({ person, db, browser, baseURL }) => {
    await seed(db, person, { kind: "oauth", name: "Claude", created: "2026-03-01T10:00:00Z" });
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      await page.getByRole("button", { name: messages.row.revoke }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByText(messages.revokeSheet.oauthLabel, { exact: true })).toBeVisible();
      await sheet.getByRole("button", { name: messages.revokeSheet.cancel }).click();
      const [open] = await db`select revoked_at from goals.access_tokens where user_id = ${person.id}`;
      expect(open.revoked_at).toBeNull();
    } finally {
      await context.close();
    }
  });

  test("every date carries its year, a fresh row and one from another year alike", async ({
    person,
    db,
    browser,
    baseURL,
  }) => {
    await seed(db, person, { kind: "personal", name: "Antigua", created: "2025-10-05T15:00:00Z", used: "2025-12-31T15:00:00Z" });
    await seed(db, person, { kind: "personal", name: "Revocada", created: "2025-01-02T15:00:00Z", revoked: "2026-02-03T15:00:00Z" });
    await seed(db, person, { kind: "personal", name: "Viva", created: "2025-10-05T15:00:00Z", used: new Date().toISOString() });
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      await openFolds(page);
      await expect(page.getByText(/^creada el 5 oct 2025 · usada hoy a las \d\d:\d\d$/)).toBeVisible();
      // Unused for over 90 days, so it reads expired: both its dates still carry the year.
      await expect(page.getByText("venció el 31 mar 2026 · sin uso desde el 31 dic 2025", { exact: true })).toBeVisible();
      await expect(page.getByText("revocada el 3 feb 2026 · ya no entra", { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("«Copiar» answers «Copiada.» under the row for a moment, then goes quiet", async ({ person, browser, baseURL }) => {
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      const copy = page.getByRole("button", { name: messages.connector.copyName });
      await copy.click();
      const line = page.getByRole("status").filter({ hasText: messages.connector.copied });
      await expect(line).toBeVisible();
      await expect(copy).toHaveText(messages.connector.copy);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/mcp$/);
      await expect(line).toHaveCount(0, { timeout: 4000 });
    } finally {
      await context.close();
    }
  });

  test("when the clipboard refuses, the same place says so and the label stays", async ({ person, browser, baseURL }) => {
    const { context, page } = await openScreen(browser, baseURL!, person);
    try {
      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
        });
      });
      const copy = page.getByRole("button", { name: messages.connector.copyName });
      await copy.click();
      await expect(page.getByRole("status").filter({ hasText: messages.connector.copyFailed })).toBeVisible();
      await expect(page.getByText(messages.connector.copied)).toHaveCount(0);
      await expect(copy).toHaveText(messages.connector.copy);
    } finally {
      await context.close();
    }
  });
});
