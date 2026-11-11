/**
 * «Destinatarios» (RF-189): a person saves a number a bank message names, reads it back with its name and
 * kind, renames it, and removes it. The row is read back from Postgres, never from the screen that wrote it.
 */
import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { readScope, test } from "./global-setup";

const t = messages.recipients;
const scope = readScope();
const digits = `32${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
const stamp = randomUUID().slice(0, 8);

test.afterAll(async () => {
  await fixtureSql`delete from recipients where owner_user_id = ${scope.userId}`;
});

test("a saved number is listed with its name and kind, renamed, and removed", async ({ page }) => {
  await page.goto("/es/settings/recipients");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: t.title })).toBeVisible();
  await expect(main.getByText(t.emptyTitle)).toBeVisible();

  await main.getByRole("button", { name: t.add }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(t.identifierLabel).fill(`*${digits}`);
  await dialog.getByLabel(t.nameLabel).fill(`Doña Rosa ${stamp}`);
  await dialog.getByRole("button", { name: messages.common.save }).click();
  await expect(dialog).toBeHidden();

  await expect(main.getByText(`Doña Rosa ${stamp}`)).toBeVisible();
  await expect(main.getByText(digits)).toBeVisible();
  const [stored] = await fixtureSql<{ identifier: string; kind: string }[]>`
    select identifier, kind from recipients where owner_user_id = ${scope.userId}`;
  expect(stored).toEqual({ identifier: digits, kind: "person" });

  await main.getByRole("button", { name: messages.common.actionsFor.replace("{name}", `Doña Rosa ${stamp}`) }).click();
  await page.getByRole("menuitem", { name: messages.common.edit }).click();
  await dialog.getByLabel(t.nameLabel).fill(`Arriendo ${stamp}`);
  await dialog.getByRole("button", { name: messages.common.save }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByText(`Arriendo ${stamp}`)).toBeVisible();

  await main.getByRole("button", { name: messages.common.actionsFor.replace("{name}", `Arriendo ${stamp}`) }).click();
  await page.getByRole("menuitem", { name: messages.common.delete }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: messages.common.delete }).click();
  await expect(main.getByText(t.emptyTitle)).toBeVisible();
  const [{ left }] = await fixtureSql<{ left: number }[]>`select count(*)::int as left from recipients where owner_user_id = ${scope.userId}`;
  expect(left).toBe(0);
});
