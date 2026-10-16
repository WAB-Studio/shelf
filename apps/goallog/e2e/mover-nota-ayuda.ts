import type { Locator, Page } from "@playwright/test";

import { expect } from "./fixtures";
import type { Db } from "./meta-arbol-seed";

// Helpers of the specs of moving a goal and writing its note (module 872b, RP-82, RP-95).
// A helper file, not a spec.

export const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function parentOf(db: Db, id: string): Promise<string | null> {
  const [row] = await db<{ parent_id: string | null }[]>`select parent_id from goals.goals where id = ${id}`;
  return row.parent_id;
}

export async function noteOf(db: Db, id: string): Promise<string | null> {
  const [row] = await db<{ note: string | null }[]>`select note from goals.goals where id = ${id}`;
  return row.note;
}

export async function setNote(db: Db, id: string, note: string) {
  await db`update goals.goals set note = ${note} where id = ${id}`;
}

export async function noOverflow(page: Page, width = 360) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

export async function openMoveSheet(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Mover bajo otra meta" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "¿Bajo qué meta?" })).toBeVisible();
  return sheet;
}

// The destination row of a goal: a radio whose accessible name carries the goal's name.
export const destination = (sheet: Locator, name: string) =>
  sheet.getByRole("radio", { name: new RegExp(escapeRe(name)) });

export const topDestination = (sheet: Locator) => sheet.getByRole("radio", { name: /Arriba, sin meta encima/ });

// A destination a person can pick: present and enabled. Absent and disabled both read as «not offered».
export async function isPickable(row: Locator): Promise<boolean> {
  return (await row.count()) > 0 && (await row.first().isEnabled());
}

// «19 950»: thousands apart by a space, the way the sheets write a count.
export const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, " ");
