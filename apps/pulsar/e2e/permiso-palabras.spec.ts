import { createHash, randomBytes } from "node:crypto";

import type { Page } from "@playwright/test";
import { registerOAuthClient } from "@repo/harness-registry";
import postgres from "postgres";

import { test, expect } from "./fixtures";

// PermisoPalabras (RP-60): what the consent screen says it may and
// never may do, in the board's own words. Every string is a literal: a spec
// that read them from oauth.json would pass on whatever the catalogue says.
const REDIRECT = "http://localhost:6274/oauth/callback";
const from = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::1`;
const asRun = { "x-forwarded-for": from };

const MAY = [
  "leer tus metas, meses, tareas, sueltas e informe",
  "marcar hecho y anotar cantidades",
  "abrir metas, escribir tareas y sus notas",
  "renombrar una meta y mover su final",
  "agregar fases y compromisos, y retirar un compromiso",
  "darle mes o día a una tarea, devolverla al plan y cambiar el monto de un mes",
  "poner la medida y el ritmo de una meta",
];
const NEVER = ["borrar ni archivar nada", "desmarcar lo que ya hiciste"];
const REVOKE = "Metas › Conectar una IA";

// HARNESS_RUN_ID reaches this process, not the server: the spec notes its own client.
async function note(clientId: string): Promise<void> {
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    await registerOAuthClient(sql, clientId);
  } finally {
    await sql.end();
  }
}

async function isNoted(clientId: string): Promise<boolean> {
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const rows = await sql`select 1 from harness.oauth_clients where client_id = ${clientId}`;
    return rows.length === 1;
  } finally {
    await sql.end();
  }
}

const challengeOf = (value: string) => createHash("sha256").update(value).digest("base64url");

async function consentPage(page: Page, baseURL: string): Promise<string> {
  const resource = (
    (await (await fetch(`${baseURL}/.well-known/oauth-protected-resource`)).json()) as { resource: string }
  ).resource;
  const registered = await fetch(`${baseURL}/oauth/registro`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...asRun },
    body: JSON.stringify({ client_name: `Claude ${randomBytes(3).toString("hex")}`, redirect_uris: [REDIRECT] }),
  });
  expect(registered.status).toBe(201);
  const { client_id } = (await registered.json()) as { client_id: string };
  await note(client_id);
  const params = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challengeOf(randomBytes(32).toString("base64url")),
    code_challenge_method: "S256",
    state: "palabras",
    resource,
  });
  await page.goto(`/oauth/autorizar?${params.toString()}`);
  return client_id;
}

for (const width of [360, 1280]) {
  test.describe(`the consent words at ${width}`, () => {
    test.use({ viewport: { width, height: 740 }, extraHTTPHeaders: asRun });

    test("it lists what the tools do, never what they do not, and names one place to revoke", async ({
      page,
      baseURL,
    }) => {
      const clientId = await consentPage(page, baseURL!);
      expect(await isNoted(clientId), "the spec's client is in harness.oauth_clients").toBe(true);
      const main = page.getByRole("main");

      await expect(page.getByText("bitácora de metas", { exact: true })).toBeVisible();
      await expect(page.getByText("Podrá leer tus metas y anotar lo que hagas.", { exact: true })).toBeVisible();
      for (const line of [...MAY, ...NEVER]) {
        await expect(page.getByText(line, { exact: true }), line).toBeVisible();
      }
      // The lists are exactly these lines, in this order, each led by its glyph.
      const lines = async (n: number, mark: string) =>
        (await page.locator("ul").nth(n).locator("li").allInnerTexts()).map((t) => t.replace(mark, "").trim());
      expect(await lines(0, "+")).toEqual(MAY);
      expect(await lines(1, "–")).toEqual(NEVER);
      await expect(page.getByRole("button", { name: "Permitir", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "No permitir", exact: true })).toBeVisible();

      const text = await main.innerText();
      // The rhythm moved from «nunca» to «podrá»: it is said once, in the may list.
      expect(text).not.toContain("cambiar el ritmo");
      // Words for tools that do not exist (`reorganize`'s old line).
      expect(text).not.toMatch(/correr el plan/i);
      expect(text).not.toMatch(/mover tareas de mes/i);
      // One place to revoke, and it is the footer's.
      expect(text).not.toContain("Conexiones");
      expect(text.split(REVOKE)).toHaveLength(2);
      await expect(page.getByText(/^entraste como \S+ · lo revocas cuando quieras en Metas › Conectar una IA$/)).toBeVisible();

      const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(scroll).toBeLessThanOrEqual(inner);
    });
  });
}
