import type { Browser, Locator, Page } from "@playwright/test";
import type { Sql } from "postgres";

import { test, expect, type Person } from "./fixtures";
import { boxOf } from "./box";

// RP-38, RP-60, RP-64, RNP-20: boards `ConexionesConDominio`, `ConexionesPlegadas`,
// `ConexionesPlegadasAbiertas`, `ConexionesVencidaCreaOtra`, `ConexionesSeccionConexiones`, `ConexionesDesktopConector`.
// The words are the boards', typed here on purpose: a message key renamed or reworded in the
// catalogue must not drag the assertion with it.
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const KEY = /^pls_[A-Za-z0-9_-]{20,}$/;

async function openScreen(browser: Browser, baseURL: string, person: Person, width: number) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL,
    viewport: { width, height: width < 1024 ? 740 : 900 },
    hasTouch: width < 1024,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.goto("/conexiones");
  await expect(page.getByRole("heading", { level: 1, name: "Conectar una IA" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Crear llave" })).toBeVisible();
  return { context, page };
}

type Seed = {
  kind?: "personal" | "oauth";
  name: string;
  created: Date;
  used?: Date;
  revoked?: Date;
  redirect?: string;
};

// `token_hash` is unique and never read back: a seeded row needs only a distinct one.
async function seed(db: Sql, person: Person, row: Seed) {
  const kind = row.kind ?? "personal";
  await db`
    insert into goals.access_tokens (user_id, kind, name, token_hash, hint, created_at, last_used_at, revoked_at, redirect_uri)
    values (${person.id}, ${kind}, ${row.name}, ${Buffer.from(`${row.name}-${Math.random()}`)},
      ${kind === "personal" ? "abcd" : null}, ${row.created}, ${row.used ?? null}, ${row.revoked ?? null},
      ${row.redirect ?? null})`;
}

// Stopped entering `days` ago.
const revokedAgo = (name: string, days: number, kind: "personal" | "oauth" = "personal"): Seed => ({
  kind,
  name,
  created: ago(days + 60),
  used: ago(days + 5),
  revoked: ago(days),
});
// A key whose 90 idle days ended `days` ago.
const lapsedAgo = (name: string, days: number): Seed => ({
  name,
  created: ago(days + 200),
  used: ago(days + 90),
});
const live = (name: string): Seed => ({ name, created: ago(12), used: new Date() });

const fold = (page: Page, text: string | RegExp): Locator => page.getByRole("button", { name: text });
// The row's own act sits beside its text column in one line.
const rowOfButton = (button: Locator): Locator => button.locator("xpath=..");

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

for (const width of [390, 1440]) {
  test.describe(`/conexiones at ${width}`, () => {
    test("two «Claude» connections are told apart by the host each returns to, with no path", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, {
        kind: "oauth",
        name: "Claude",
        created: ago(10),
        used: ago(9),
        redirect: "https://claude.ai/api/mcp/auth_callback?state=zz#frag",
      });
      await seed(db, person, {
        kind: "oauth",
        name: "Claude",
        created: ago(8),
        used: ago(7),
        redirect: "http://localhost:33418/callback",
      });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        for (const host of ["claude.ai", "localhost:33418"]) {
          const button = page.getByRole("button", { name: `Revocar Claude, vuelve a ${host}`, exact: true });
          await expect(button).toBeVisible();
          const row = rowOfButton(button);
          const text = await row.innerText();
          expect(text).toContain(`vuelve a ${host}`);
          // Line one is the destination; line two the dates.
          expect(text.indexOf("vuelve a")).toBeLessThan(text.indexOf("conectada el"));
          expect(text).toMatch(/conectada el .* · usada el /);
          await expect(row.locator("strong")).toHaveText(host);
          expect(text).not.toMatch(/https?:|\/callback|auth_callback|state=|frag/);
        }
        // Each host once: the other row does not borrow it.
        await expect(page.getByText("vuelve a claude.ai")).toHaveCount(1);
        await expect(page.getByText("vuelve a localhost:33418")).toHaveCount(1);
      } finally {
        await context.close();
      }
    });

    test("a connection with no known address keeps today's row, with no «vuelve a»", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, { kind: "oauth", name: "Claude", created: ago(10), used: ago(9) });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        const button = page.getByRole("button", { name: /^Revocar Claude, conectada el \d{1,2} \p{L}+\.?( \d{4})?$/u });
        await expect(button).toBeVisible();
        const text = await rowOfButton(button).innerText();
        expect(text).toMatch(/Claude\s+conectada el .* · usada el /);
        expect(text).not.toContain("vuelve a");
        await expect(rowOfButton(button).locator("strong")).toHaveCount(0);
        await expect(page.getByText(/vuelve a/)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("every «Revocar» names what it revokes, and none is just «Revocar»", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, live("portátil del trabajo"));
      await seed(db, person, live("teléfono"));
      await seed(db, person, { kind: "oauth", name: "Claude", created: ago(5), redirect: "https://claude.ai/cb" });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await expect(page.getByRole("button", { name: "Revocar la llave portátil del trabajo", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Revocar la llave teléfono", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Revocar Claude, vuelve a claude.ai", exact: true })).toBeVisible();
        // The visible word stays «Revocar».
        await expect(page.getByRole("button", { name: "Revocar la llave teléfono" })).toHaveText("Revocar");
        await expect(page.getByRole("button", { name: "Revocar", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Revocar/ })).toHaveCount(3);
      } finally {
        await context.close();
      }
    });

    test("dead rows older than 30 days fold shut under «3 llaves que ya no entran»", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, live("viva uno"));
      await seed(db, person, live("viva dos"));
      await seed(db, person, revokedAgo("muerta revocada", 40));
      await seed(db, person, lapsedAgo("muerta vencida", 40));
      await seed(db, person, revokedAgo("muerta otra", 45));
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        const toggle = fold(page, "3 llaves que ya no entran");
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByText("viva uno", { exact: true })).toBeVisible();
        await expect(page.getByText("viva dos", { exact: true })).toBeVisible();
        for (const name of ["muerta revocada", "muerta vencida", "muerta otra"]) {
          await expect(page.getByText(name, { exact: true })).toBeHidden();
        }
        await expect(page.getByText(/ya no entra$|^venció el /)).toHaveCount(0);
        // The only buttons shut are the three dead rows'; the two live ones keep theirs.
        await expect(page.getByRole("button", { name: /^Revocar/ })).toHaveCount(2);
      } finally {
        await context.close();
      }
    });

    test("opening the fold shows the three dead rows, dimmed, none with «Revocar»", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, live("viva uno"));
      await seed(db, person, live("viva dos"));
      await seed(db, person, revokedAgo("muerta revocada", 40));
      await seed(db, person, lapsedAgo("muerta vencida", 40));
      await seed(db, person, revokedAgo("muerta otra", 45));
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        const toggle = fold(page, "3 llaves que ya no entran");
        await expect(toggle).toBeVisible();
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        for (const name of ["muerta revocada", "muerta vencida", "muerta otra"]) {
          await expect(page.getByText(name, { exact: true })).toBeVisible();
        }
        await expect(page.getByText(/^revocada el .* · ya no entra$/)).toHaveCount(2);
        await expect(page.getByText(/^venció el .* · sin uso desde el /)).toHaveCount(1);
        // Only the two live keys can be revoked.
        await expect(page.getByRole("button", { name: /^Revocar/ })).toHaveCount(2);
        // Dimmed like any dead row, unlike a live name.
        const color = (name: string) =>
          page.getByText(name, { exact: true }).evaluate((el) => getComputedStyle(el).color);
        expect(await color("muerta revocada")).not.toBe(await color("viva uno"));
        // The expired one still offers the next step; the revoked ones do not.
        await expect(page.getByText("crea otra", { exact: true })).toHaveCount(1);

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByText("muerta revocada", { exact: true })).toBeHidden();
      } finally {
        await context.close();
      }
    });

    test("a row that stopped 5 days ago stays in view, with «crea otra» and no fold; 29 days stays, 31 folds", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, lapsedAgo("vencida reciente", 5));
      await seed(db, person, revokedAgo("revocada reciente", 5));
      await seed(db, person, revokedAgo("revocada veintinueve", 29));
      await seed(db, person, revokedAgo("revocada treinta y una", 31));
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        for (const name of ["vencida reciente", "revocada reciente", "revocada veintinueve"]) {
          await expect(page.getByText(name, { exact: true })).toBeVisible();
        }
        await expect(page.getByText("revocada treinta y una", { exact: true })).toBeHidden();
        await expect(fold(page, "1 llave que ya no entra")).toBeVisible();
        const recent = page.getByText("vencida reciente", { exact: true }).locator("xpath=ancestor::div[2]");
        await expect(recent.getByText("crea otra", { exact: true })).toBeVisible();
        await expect(recent.getByRole("button", { name: /^Revocar/ })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Revocar/ })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("with nothing dead there is no fold, and with no keys the empty screen is as before", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      const empty = await openScreen(browser, baseURL!, person, width);
      try {
        await expect(empty.page.getByText("una llave para claude code", { exact: true })).toBeVisible();
        await expect(empty.page.getByRole("button", { name: /que ya no entra/ })).toHaveCount(0);
        await expect(empty.page.getByText("llaves", { exact: true })).toHaveCount(0);
      } finally {
        await empty.context.close();
      }
      await seed(db, person, live("sola"));
      await seed(db, person, { kind: "oauth", name: "Claude", created: ago(3), redirect: "https://claude.ai/x" });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await expect(page.getByText("sola", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: /ya no entra/ })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("each section folds its own dead: «1 llave que ya no entra» and «2 conexiones que ya no entran»", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, live("viva"));
      await seed(db, person, revokedAgo("llave muerta", 50));
      await seed(db, person, { kind: "oauth", name: "Claude", created: ago(4), redirect: "https://claude.ai/x" });
      await seed(db, person, revokedAgo("Claude", 40, "oauth"));
      await seed(db, person, { ...revokedAgo("Claude", 60, "oauth"), redirect: "http://localhost:33418/x" });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        const keys = fold(page, "1 llave que ya no entra");
        const conns = fold(page, "2 conexiones que ya no entran");
        await expect(keys).toHaveAttribute("aria-expanded", "false");
        await expect(conns).toHaveAttribute("aria-expanded", "false");
        // Keys' fold sits above the «conexiones» label, the connections' fold below it.
        const y = async (l: Locator) => (await boxOf(l)).y;
        // The host in a row is a <strong>; the section label is the one that is not.
        await expect(page.getByText("claude.ai", { exact: true }).and(page.locator(":not(strong)"))).toHaveCount(0);
        const label = (await boxOf(page.getByText("conexiones", { exact: true }))).y;
        expect(await y(keys)).toBeLessThan(label);
        expect(await y(conns)).toBeGreaterThan(label);

        // Opening one leaves the other shut.
        await conns.click();
        await expect(conns).toHaveAttribute("aria-expanded", "true");
        await expect(keys).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByText("llave muerta", { exact: true })).toBeHidden();
        await expect(page.getByText(/^revocada el .* · ya no entra$/)).toHaveCount(2);
        await expect(page.getByRole("button", { name: /^Revocar/ })).toHaveCount(2);
      } finally {
        await context.close();
      }
    });

    test("«crea otra» lands on the name field, focused, with the lapsed key's name in it", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, live("portátil del trabajo"));
      await seed(db, person, lapsedAgo("portátil de la casa", 5));
      await seed(db, person, lapsedAgo("tableta", 60));
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        const field = page.getByLabel("nombre de la llave");
        await expect(field).toHaveValue("");
        await expect(field).not.toBeFocused();

        await expect(page.getByText("crea otra", { exact: true })).toBeVisible();
        await page.getByText("crea otra", { exact: true }).click();
        await expect(field).toBeFocused();
        await expect(field).toHaveValue("portátil de la casa");
        expect((await boxOf(field)).y).toBeLessThan(page.viewportSize()!.height);

        // A folded lapsed key offers the same step, with its own name.
        await expect(fold(page, "1 llave que ya no entra")).toBeVisible();
        await fold(page, "1 llave que ya no entra").click();
        await page.getByLabel("nombre de la llave").fill("");
        await page.getByText("tableta", { exact: true }).locator("xpath=ancestor::div[2]").getByText("crea otra", { exact: true }).click();
        await expect(field).toBeFocused();
        await expect(field).toHaveValue("tableta");

        await page.getByRole("button", { name: "Crear llave" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Tu llave" })).toBeVisible();
        await expect(page.locator("pre").first()).toHaveText(KEY);
      } finally {
        await context.close();
      }
    });

    test("«Revocar» → «Revocar» disables the sheet's act while it works, then the row is revoked", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, live("portátil"));
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await page.route("**/conexiones", async (route) => {
          if (route.request().method() === "POST") await new Promise((done) => setTimeout(done, 1500));
          await route.continue();
        });
        const ask = page.getByRole("button", { name: "Revocar la llave portátil", exact: true });
        await expect(ask).toBeVisible();
        await ask.click();
        const sheet = page.getByRole("dialog");
        const confirm = sheet.getByRole("button", { name: "Revocar", exact: true });
        await confirm.click();
        await expect(confirm).toBeDisabled();
        await expect(sheet).toHaveCount(0, { timeout: 8000 });
        await expect(page.getByText(/^revocada el .* · ya no entra$/)).toBeVisible();
        await expect(page.getByRole("button", { name: /^Revocar/ })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("«Dejarla» closes the sheet and the row is still revocable by its name", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, live("portátil"));
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        const button = page.getByRole("button", { name: "Revocar la llave portátil", exact: true });
        await expect(button).toBeVisible();
        await button.click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("heading", { name: "¿Revocar «portátil»?" })).toBeVisible();
        await sheet.getByRole("button", { name: "Dejarla", exact: true }).click();
        await expect(sheet).toHaveCount(0);
        await expect(button).toBeVisible();
        const [row] = await db`select revoked_at from goals.access_tokens where user_id = ${person.id}`;
        expect(row.revoked_at).toBeNull();
      } finally {
        await context.close();
      }
    });

    test("a name already held by a live key is refused in the field, with the key kept", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, live("portátil"));
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await page.getByLabel("nombre de la llave").fill("portátil");
        await page.getByRole("button", { name: "Crear llave" }).click();
        await expect(page.getByText("Ya tienes una llave con ese nombre. Dale otro.", { exact: true })).toBeVisible();
        await expect(page.getByLabel("nombre de la llave")).toHaveValue("portátil");
        await expect(page.getByRole("heading", { level: 1, name: "Tu llave" })).toHaveCount(0);
        const rows = await db`select 1 from goals.access_tokens where user_id = ${person.id}`;
        expect(rows).toHaveLength(1);
      } finally {
        await context.close();
      }
    });

    test("the section of authorizations is «conexiones», between the keys and the form, and Claude Code is not filed under «claude.ai»", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      await seed(db, person, live("portátil del trabajo"));
      await seed(db, person, {
        kind: "oauth",
        name: "Claude",
        created: ago(8),
        used: new Date(),
        redirect: "https://claude.ai/api/mcp/auth_callback",
      });
      await seed(db, person, {
        kind: "oauth",
        name: "Claude Code",
        created: ago(6),
        used: ago(1),
        redirect: "http://localhost:33418/callback",
      });
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        const label = page.getByText("conexiones", { exact: true });
        await expect(label).toHaveCount(1);
        await expect(page.getByText("claude.ai", { exact: true }).and(page.locator(":not(strong)"))).toHaveCount(0);
        const y = async (l: Locator) => (await boxOf(l)).y;
        const keysLabel = await y(page.getByText("llaves", { exact: true }));
        const conns = await y(label);
        const another = await y(page.getByText("otra llave", { exact: true }));
        expect(keysLabel).toBeLessThan(conns);
        // Both OAuth rows sit under the one label, above the form.
        for (const name of ["Revocar Claude, vuelve a claude.ai", "Revocar Claude Code, vuelve a localhost:33418"]) {
          const row = await y(page.getByRole("button", { name, exact: true }));
          expect(row).toBeGreaterThan(conns);
          expect(row).toBeLessThan(another);
        }
        // The key's row is above the label.
        expect(await y(page.getByRole("button", { name: "Revocar la llave portátil del trabajo", exact: true }))).toBeLessThan(conns);
      } finally {
        await context.close();
      }
    });

    test("with only a key, no «conexiones» label stands over nothing", async ({ person, db, browser, baseURL }) => {
      await seed(db, person, live("portátil del trabajo"));
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        await expect(page.getByText("llaves", { exact: true })).toBeVisible();
        await expect(page.getByText("conexiones", { exact: true })).toHaveCount(0);
        await expect(page.getByText("claude.ai", { exact: true }).and(page.locator(":not(strong)"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("the connector section names claude.ai and Claude Desktop, shows the address on the main screen, and keeps it with no keys at all", async ({
      person,
      db,
      browser,
      baseURL,
    }) => {
      // Empty first: no key, no connection.
      let opened = await openScreen(browser, baseURL!, person, width);
      try {
        const page = opened.page;
        await expect(page.getByText("en claude.ai o claude desktop", { exact: true })).toBeVisible();
        await expect(page.getByText("Agrega un conector con esta dirección y entra con tu correo.", { exact: true })).toBeVisible();
        await expect(page.locator("pre").filter({ hasText: /^\S+\/mcp$/ })).toHaveCount(1);
        await expect(page.getByRole("button", { name: "Copiar la dirección" })).toBeVisible();
        await expect(page.getByText("en claude.ai", { exact: true })).toHaveCount(0);
      } finally {
        await opened.context.close();
      }
      await seed(db, person, live("portátil"));
      opened = await openScreen(browser, baseURL!, person, width);
      try {
        const page = opened.page;
        await expect(page.getByText("en claude.ai o claude desktop", { exact: true })).toBeVisible();
        await expect(page.locator("pre").filter({ hasText: /^\S+\/mcp$/ })).toHaveCount(1);
      } finally {
        await opened.context.close();
      }
    });

    test("the created key gives Claude Code its command and a generic try-it line, with no Claude Desktop file and the address not repeated", async ({
      person,
      browser,
      baseURL,
    }) => {
      const { context, page } = await openScreen(browser, baseURL!, person, width);
      try {
        const address = (await page.locator("pre").filter({ hasText: /^\S+\/mcp$/ }).textContent())!;
        await page.getByLabel("nombre de la llave").fill("portátil del trabajo");
        await page.getByRole("button", { name: "Crear llave" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Tu llave" })).toBeVisible();
        await expect(page.getByRole("note")).toHaveText("No la volverás a ver. Si la pierdes, revócala y crea otra.");
        await expect(page.getByText("portátil del trabajo", { exact: true })).toBeVisible();

        const keyBlock = page.locator("pre").first();
        await expect(keyBlock).toHaveText(KEY);
        const key = (await keyBlock.textContent())!;
        await expect(page.getByText("claude code · pégalo en tu terminal", { exact: true })).toBeVisible();

        await page.getByRole("button", { name: "Copiar el comando de Claude Code" }).click();
        const command = await page.evaluate(() => navigator.clipboard.readText());
        expect(command).toBe(`claude mcp add --transport http pulsar ${address} --header "Authorization: Bearer ${key}"`);

        // Key and command only: no Claude Desktop file, no JSON, no address of its own.
        await expect(page.locator("pre")).toHaveCount(2);
        await expect(page.locator("pre").filter({ hasText: /^\S+\/mcp$/ })).toHaveCount(0);
        await expect(page.getByText("claude_desktop_config.json")).toHaveCount(0);
        await expect(page.getByText("mcpServers")).toHaveCount(0);
        await expect(page.getByText("mcp-remote")).toHaveCount(0);
        await expect(page.getByText("reinicia Claude Desktop")).toHaveCount(0);
        await expect(page.getByRole("button", { name: /Claude Desktop/ })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Copiar la dirección" })).toHaveCount(0);
        await expect(page.getByText("en claude.ai o claude desktop")).toHaveCount(0);

        const sentence = page.getByText("Prueba: «lee mis metas y dime qué sigue».", { exact: true });
        await expect(sentence).toBeVisible();
        await expect(page.getByText(/inglés/)).toHaveCount(0);
        await expect(page.getByText(/queda conectado/)).toHaveCount(0);

        const y = async (l: Locator) => (await boxOf(l)).y;
        const terminal = await y(page.getByText("claude code · pégalo en tu terminal", { exact: true }));
        const line = await y(sentence);
        const done = await y(page.getByRole("button", { name: "Listo", exact: true }));
        expect(terminal).toBeLessThan(line);
        expect(line).toBeLessThan(done);
        expect(await overflow(page)).toBeLessThanOrEqual(0);

        // «Listo» brings the address back to the main screen.
        await page.getByRole("button", { name: "Listo", exact: true }).click();
        await expect(page.locator("pre").filter({ hasText: /^\S+\/mcp$/ })).toHaveCount(1);
      } finally {
        await context.close();
      }
    });
  });
}

test.describe("/conexiones at 360", () => {
  test("a 63-character host and the fold do not overflow the screen", async ({ person, db, browser, baseURL }) => {
    const host = `${"x".repeat(51)}.example.com`;
    expect(host).toHaveLength(63);
    await seed(db, person, {
      kind: "oauth",
      name: "Claude",
      created: ago(5),
      used: ago(4),
      redirect: `https://${host}/callback`,
    });
    await seed(db, person, live("Mi portátil de la oficina con un nombre largo de verdad"));
    await seed(db, person, revokedAgo("muerta", 40));
    await seed(db, person, revokedAgo("conexión muerta", 40, "oauth"));
    const { context, page } = await openScreen(browser, baseURL!, person, 360);
    try {
      const button = page.getByRole("button", { name: `Revocar Claude, vuelve a ${host}`, exact: true });
      await expect(button).toBeVisible();
      await expect(rowOfButton(button).getByText(host)).toBeVisible();
      for (const toggle of [fold(page, "1 llave que ya no entra"), fold(page, "1 conexión que ya no entra")]) {
        await expect(toggle).toBeVisible();
        const box = (await boxOf(toggle));
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(360);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      const row = (await boxOf(rowOfButton(button)));
      expect(row.x + row.width).toBeLessThanOrEqual(360);
      const hostBox = (await boxOf(rowOfButton(button).getByText(host)));
      expect(hostBox.x + hostBox.width).toBeLessThanOrEqual(360);
      expect((await boxOf(button)).height).toBeGreaterThanOrEqual(44);
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await fold(page, "1 llave que ya no entra").click();
      await fold(page, "1 conexión que ya no entra").click();
      await expect(page.getByText("conexión muerta", { exact: true })).toBeVisible();
      await expect(page.getByText("muerta", { exact: true })).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });
});
