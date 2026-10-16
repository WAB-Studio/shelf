import type { Browser } from "@playwright/test";

import { test, expect } from "./fixtures";
import chat from "../messages/es/chat.json";

// RP-91, RP-94, RNP-21 (`ChatVacio`, `ChatSinClave`, `ChatEscritorio`): the chat screen against the
// main server, which holds no OpenAI key and no stub, so the model is unavailable and nothing here
// can spend. The answers, changes and states that need a model are `chat-modelo.spec.ts`'s.

async function open(browser: Browser, baseURL: string, sessionFile: string, width = 360) {
  const context = await browser.newContext({
    storageState: sessionFile,
    baseURL,
    viewport: { width, height: width === 360 ? 740 : 800 },
    hasTouch: width === 360,
  });
  const page = await context.newPage();
  await page.goto("/chat");
  return { context, page };
}

test.describe("the chat without a model (RP-91, RNP-21)", () => {
  test("a fresh tab shows the empty chat: title, examples, field, the privacy line, and «Enviar» shut while the field is blank", async ({
    person,
    browser,
    baseURL,
  }) => {
    const { context, page } = await open(browser, baseURL!, person.sessionFile);
    try {
      await expect(page.getByRole("heading", { name: chat.title, exact: true })).toBeVisible();
      await expect(page).toHaveTitle(new RegExp(chat.title));
      await expect(page.getByRole("link", { name: new RegExp(chat.back) }).first()).toBeVisible();
      await expect(page.getByText(chat.tryWith, { exact: true })).toBeVisible();
      await expect(page.getByText(chat.examples.month, { exact: true })).toBeVisible();
      await expect(page.getByText(chat.examples.amount, { exact: true })).toBeVisible();
      await expect(page.getByText(chat.privacy, { exact: true })).toBeVisible();
      await expect(page.getByText(chat.you, { exact: true })).toHaveCount(0);
      await expect(page.getByText(chat.chat, { exact: true })).toHaveCount(0);

      const input = page.getByLabel(chat.field);
      const send = page.getByRole("button", { name: chat.send, exact: true });
      await expect(input).toHaveAttribute("placeholder", chat.placeholder);
      await expect(send).toBeDisabled();
      await input.fill("   ");
      await expect(send).toBeDisabled();
      await input.fill("hola");
      await expect(send).toBeEnabled();
      await input.fill("");
      await expect(send).toBeDisabled();
    } finally {
      await context.close();
    }
  });

  test("the field lives in the flow, never fixed to the foot", async ({ person, browser, baseURL }) => {
    const { context, page } = await open(browser, baseURL!, person.sessionFile);
    try {
      await expect(page.getByLabel(chat.field)).toBeVisible();
      const fixed = await page.getByLabel(chat.field).evaluate((el) => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          if (getComputedStyle(node).position === "fixed" || getComputedStyle(node).position === "sticky") return true;
        }
        return false;
      });
      expect(fixed).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("with no key a send says the chat is unavailable, shuts the field, and claims nothing", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const { context, page } = await open(browser, baseURL!, person.sessionFile);
    try {
      await expect(page.getByLabel(chat.field)).toBeVisible();
      await page.getByLabel(chat.field).fill("hola");
      await page.getByRole("button", { name: chat.send, exact: true }).click();

      await expect(page.getByText(chat.errors.noKey, { exact: true })).toBeVisible();
      await expect(page.getByLabel(chat.field)).toBeDisabled();
      await expect(page.getByRole("button", { name: chat.send, exact: true })).toBeDisabled();
      await expect(page.getByText(chat.privacy, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: chat.do, exact: true })).toHaveCount(0);

      const [{ count }] = await db<{ count: string }[]>`
        select count(*) from goals.model_calls where user_id = ${person.id}
      `;
      expect(Number(count)).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("at 360 the empty chat overflows nothing, every control reaches 32 px and the field clears the tab bar", async ({
    person,
    browser,
    baseURL,
  }) => {
    const { context, page } = await open(browser, baseURL!, person.sessionFile);
    try {
      await expect(page.getByLabel(chat.field)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll("main button, main a, main input, main textarea")) {
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          if (Math.min(box.width, box.height) < 32) out.push(`${el.tagName}[${(el.textContent ?? "").trim().slice(0, 20)}] ${box.width}x${box.height}`);
        }
        return out;
      });
      expect(small).toEqual([]);

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const nav = await page.getByRole("navigation").boundingBox();
      const box = await page.getByLabel(chat.field).boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(nav!.y + 0.5);
    } finally {
      await context.close();
    }
  });

  test("at 1280 the empty chat keeps the rail and holds a column no wider than 640 px", async ({ person, browser, baseURL }) => {
    const { context, page } = await open(browser, baseURL!, person.sessionFile, 1280);
    try {
      const rail = page.getByRole("navigation");
      await expect(rail.getByRole("link").filter({ hasText: /^(Hoy|Semana|Mes|Metas)$/ })).toHaveCount(4);
      await expect(page.getByLabel(chat.field)).toBeVisible();
      const input = await page.getByLabel(chat.field).boundingBox();
      expect(input!.width).toBeLessThanOrEqual(640);
      expect(input!.width).toBeGreaterThan(400);
      const go = await page.getByRole("button", { name: chat.send, exact: true }).boundingBox();
      expect(go!.width).toBeLessThan(input!.width / 2);
    } finally {
      await context.close();
    }
  });

  test("without a session /chat sends the person to sign in and draws no chat", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/chat");
      await expect(page).toHaveURL(/\/entrar/);
      await expect(page.getByLabel(chat.field)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
