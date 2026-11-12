/**
 * «Entre miembros» in Planeación → Deudas (RF-183): a member records that another owes them, records a payment
 * from the pair's card, and the pair reads what is still owed. Runs on both projects; on the phone (360 px)
 * the page never scrolls sideways.
 */
import { expect, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { pageOverflow } from "./fit";
import { LEADER_MEMBER_NAME, PLAIN_MEMBER_NAME, clearGroup, seedGroup, test } from "./global-setup";

const t = messages.memberDebts;

test.beforeEach(async () => {
  await seedGroup();
});

test.afterAll(async () => {
  await clearGroup();
});

async function pick(page: Page, label: string, option: string) {
  await page.getByRole("dialog").getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("a debt between members and a payment of it leave what is still owed, with no sideways scroll", async ({ page }) => {
  await page.goto("/es/planning/debts");
  const section = page.getByRole("main");
  await expect(section.getByRole("heading", { name: t.title })).toBeVisible();
  await expect(section.getByText(t.empty)).toBeVisible();

  await section.getByRole("button", { name: t.recordDebt }).click();
  const dialog = page.getByRole("dialog");
  await pick(page, t.debtorLabel, PLAIN_MEMBER_NAME);
  await pick(page, t.creditorLabel, LEADER_MEMBER_NAME);
  await dialog.getByLabel(t.amountLabel).fill("200000");
  await dialog.getByLabel(t.descriptionLabel).fill("préstamo para la moto");
  await dialog.getByRole("button", { name: t.save }).click();
  await expect(dialog).toBeHidden();

  const owes = new RegExp(`${PLAIN_MEMBER_NAME} le debe .*200\\.000 a ${LEADER_MEMBER_NAME}`);
  await expect(section.getByText(owes)).toBeVisible();

  await section.getByRole("button", { name: t.recordPayment }).last().click();
  await dialog.getByLabel(t.amountLabel).fill("50000");
  await dialog.getByRole("button", { name: t.save }).click();
  await expect(dialog).toBeHidden();

  await expect(section.getByText(new RegExp(`${PLAIN_MEMBER_NAME} le debe .*150\\.000 a ${LEADER_MEMBER_NAME}`))).toBeVisible();
  await section.getByRole("button", { name: /Ver 2 asientos/ }).click();
  await expect(section.getByText(/préstamo para la moto/)).toBeVisible();
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
});

test("a debt paid in full reads «Saldada» and waits in the collapsed «Saldadas» section", async ({ page }) => {
  await page.goto("/es/planning/debts");
  const section = page.getByRole("main");
  const dialog = page.getByRole("dialog");

  await section.getByRole("button", { name: t.recordDebt }).click();
  await pick(page, t.debtorLabel, PLAIN_MEMBER_NAME);
  await pick(page, t.creditorLabel, LEADER_MEMBER_NAME);
  await dialog.getByLabel(t.amountLabel).fill("80000");
  await dialog.getByRole("button", { name: t.save }).click();
  await expect(dialog).toBeHidden();

  await section.getByRole("button", { name: /Ver 1 asiento/ }).click();
  await expect(section.getByText(/Pendiente · .*80\.000/)).toBeVisible();

  await section.getByRole("button", { name: t.recordPayment }).last().click();
  await dialog.getByLabel(t.amountLabel).fill("80000");
  await dialog.getByRole("button", { name: t.save }).click();
  await expect(page.getByText(new RegExp(`Quedó saldada la deuda de ${PLAIN_MEMBER_NAME} por .*80\\.000`))).toBeVisible();

  await expect(section.getByText(t.allSquare)).toBeVisible();
  await section.getByRole("button", { name: /Ver saldadas \(1\)/ }).click();
  await expect(section.getByText(/Saldada el /)).toBeVisible();
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
});
