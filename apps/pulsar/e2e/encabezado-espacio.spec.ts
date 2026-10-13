import { test, expect, visit } from "./fixtures";

// The header spaces eyebrow -> title at 6 px and title -> lead at 12 px (`SistemaEspacio.dc.html`).

for (const path of ["/metas/nueva", "/semana"]) {
  test(`${path} holds 6 px between its eyebrow and its title`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const eyebrow = (await page.locator("main > header > div").first().boundingBox())!;
    const title = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
    const gap = title.y - (eyebrow.y + eyebrow.height);
    expect(gap).toBeGreaterThanOrEqual(6);
    expect(gap).toBeLessThanOrEqual(8);
  });
}

test("Hoy holds 12 px between its title and the line under it", async ({ person, browser, db }) => {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${person.id}, ${`Meta lead ${Date.now()}`}, (now() + interval '90 days')::date) returning id`;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${person.id}, ${goal.id}, 'Tocar', 'daily', 'tap')
  `;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/");
    const title = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
    const lead = (await page.getByText(/^hechos \d+ de \d+/).boundingBox())!;
    expect(lead.y - (title.y + title.height)).toBeCloseTo(12, 0);
  } finally {
    await context.close();
  }
});

test("Hoy's controls row sits 12 px from the date, 6 px over the title, and its toggle sits before the chat entry that ends the line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await visit(page, "/");
  const header = page.locator("main > header:visible").first();
  await expect(header.getByRole("heading", { level: 1 })).toBeVisible();
  const row = header.locator("> div").first();
  const title = (await header.getByRole("heading", { level: 1 }).boundingBox())!;
  const rowBox = (await row.boundingBox())!;
  const gap = title.y - (rowBox.y + rowBox.height);
  expect(gap).toBeGreaterThanOrEqual(6);
  expect(gap).toBeLessThanOrEqual(8);
  expect(await row.evaluate((el) => getComputedStyle(el).columnGap)).toBe("12px");
  // The chat entry ends the line (`ChatEntrada`); the toggle sits right before it.
  const toggle = (await header.getByRole("button", { name: /modo (oscuro|claro)/ }).boundingBox())!;
  const chat = (await header.getByRole("link", { name: "Abrir el chat" }).boundingBox())!;
  expect(chat.x + chat.width).toBeGreaterThan(rowBox.x + rowBox.width - 12);
  expect(toggle.x + toggle.width).toBeGreaterThan(chat.x - 12);
  expect(toggle.x + toggle.width).toBeLessThanOrEqual(chat.x + 1);
});
