import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

// RT-29: on «Hoy» the person sees where the day went at once: the app list starts inside the first screen of a phone and of
// a desktop. RT-30: no screen scrolls sideways. RT-34: the desktop is two columns beside a sidebar. A made-up person is seeded through /api/ingest and removed after.
const base = process.env.HARNESS_BASE_URL ?? "http://localhost:3300";
const email = `e2e-${randomUUID()}@example.invalid`;
const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false, max: 1, onnotice: () => {} });
const admin = (path: string, init: RequestInit) =>
  fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/${path}`, {
    ...init,
    headers: { apikey: process.env.SUPABASE_SECRET_KEY!, authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`, "content-type": "application/json" },
  });

const appNames = ["chrome.exe", "VALORANT-Win64-Shipping.exe", "Code.exe", "WhatsApp.exe", "javaw.exe", "slack.exe", "msedge.exe", "WindowsTerminal.exe", "Figma.exe", "Spotify.exe", "Notion.exe"];
const today = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);

test.beforeAll(async () => {
  await admin("users", { method: "POST", body: JSON.stringify({ email, email_confirm: true }) });
  await sql`insert into timelog.allowed_emails (email) values (${email})`;
  const [{ id }] = await sql`select id from auth.users where email = ${email}`;
  const key = `tl_${randomBytes(32).toString("base64url")}`;
  await sql`insert into timelog.access_keys (user_id, name, key_hash, hint) values (${id}, 'e2e', ${createHash("sha256").update(key).digest()}, ${key.slice(-4)})`;
  const days = [{ day: today, apps: appNames.map((app, index) => ({ app, seconds: 3000 - index * 200 })), sites: [{ host: "claude.ai", seconds: 900 }], claude_code_seconds: 600 }];
  const response = await fetch(`${base}/api/ingest`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ device: "pc", days }) });
  expect(response.status).toBe(200);
});

test.afterAll(async () => {
  const rows = await sql`select id from auth.users where email = ${email}`;
  await sql`delete from timelog.allowed_emails where email = ${email}`;
  for (const row of rows) await admin(`users/${row.id}`, { method: "DELETE" });
  await sql.end();
});

async function signIn(page: Page) {
  const link = await (await admin("generate_link", { method: "POST", body: JSON.stringify({ type: "magiclink", email }) })).json();
  await page.goto(`/auth/confirm?token_hash=${link.hashed_token}&type=magiclink`);
  await expect(page).toHaveURL(`${base}/`);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`the app list starts inside the first screen at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signIn(page);
    const first = page.locator("section", { has: page.getByRole("heading", { name: "Apps" }) }).getByRole("img").first();
    const box = await first.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    // Readable names, no raw process, no day line.
    await expect(page.getByText("Valorant", { exact: true })).toBeVisible();
    await expect(page.getByText("Win64-Shipping")).toHaveCount(0);
    await expect(page.getByText("Claude Code durante el día")).toHaveCount(0);
  });
}

for (const width of [360, 390, 820, 1440]) {
  test(`no screen scrolls sideways at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    for (const path of ["/", "/semana", "/llaves", "/exportar"]) {
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(width);
    }
  });
}

test("at 1440 the sections sit beside the sidebar, Sitios beside Apps, and the week's days side by side", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const nav = await page.getByRole("navigation").boundingBox();
  const apps = await page.locator("section", { has: page.getByRole("heading", { name: "Apps" }) }).boundingBox();
  const sites = await page.locator("section", { has: page.getByRole("heading", { name: /^(Sitios|Sites)$/ }) }).boundingBox();
  expect(nav!.x + nav!.width).toBeLessThanOrEqual(apps!.x);
  expect(sites!.x).toBeGreaterThanOrEqual(apps!.x + apps!.width);
  expect(sites!.y).toBeLessThan(apps!.y + apps!.height);
  await page.goto("/semana");
  const days = page.locator("main ol > li");
  await expect(days).toHaveCount(7);
  const [monday, sunday] = await Promise.all([days.first().boundingBox(), days.last().boundingBox()]);
  expect(Math.abs(monday!.y - sunday!.y)).toBeLessThan(2);
});

test("Semana has no heatmap and names its week's days as rows", async ({ page }) => {
  await signIn(page);
  await page.goto("/semana");
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Semana anterior" })).toHaveCount(0);
  await expect(page.locator("main a[href^='/dia/'], main a[href='/']").filter({ hasText: /min|h/ }).first()).toBeVisible();
});
