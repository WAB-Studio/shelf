/**
 * RF-63 and RF-57 on the category action: a new category says where it goes.
 *
 * The form (M8) will send a `placement`; until then these drive the server action the
 * way a person who skips the form does. The action's id and body shape are learned
 * from the leader's own create on /es/settings/categories, then forged bodies are
 * posted as each caller. The owed outcome is read from the `categories` row: who owns
 * it, and whether any row was written at all.
 */
import { randomUUID } from "node:crypto";

import { expect, type Browser, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  MEMBER_STORAGE_STATE,
  STORAGE_STATE,
  asHarnessUser,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const stamp = randomUUID().slice(0, 8);
const PREFIX = `Harness lugar ${stamp}`;
const COLOR = "#DC2626";

type Learned = { id: string; url: string };
let learned: Learned | null = null;

type Row = { owner_user_id: string | null; group_id: string | null; parent_id: string | null };

function nameFor(label: string): string {
  return `${PREFIX} ${label}`;
}

// The leader's own create through the dialog, caught on the wire.
async function learnAction(browser: Browser): Promise<Learned> {
  if (learned) return learned;
  await seedGroup();
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  try {
    const page = await context.newPage();
    const seen: Learned[] = [];
    page.on("request", (request) => {
      const id = request.headers()["next-action"];
      if (request.method() === "POST" && id) seen.push({ id, url: request.url() });
    });
    await page.goto("/es/settings/categories");
    await page
      .getByRole("button", { name: messages.categories.add, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: messages.categories.nameLabel }).fill(nameFor("aprendida"));
    await dialog.getByRole("button", { name: messages.common.save, exact: true }).click();
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    await expect(dialog).toBeHidden();
    learned = seen[0];
    return learned;
  } finally {
    await context.close();
  }
}

async function forge(page: Page, action: Learned, input: Record<string, unknown>): Promise<string> {
  const answer = await page.request.post(action.url, {
    headers: {
      "next-action": action.id,
      "content-type": "text/plain;charset=UTF-8",
      accept: "text/x-component",
    },
    data: JSON.stringify([{ kind: "expense", parentId: null, color: COLOR, ...input }]),
  });
  return actionResult(await answer.text());
}

// The flight answer carries the refreshed page too; the action's own result is the line holding `data`, `serverError` or `validationErrors`.
function actionResult(flight: string): string {
  const line = flight.split("\n").find((candidate) => /^\w+:\{"(data|serverError|validationErrors)"/.test(candidate));
  expect(line, "the answer carries no action result").toBeDefined();
  return line ?? "";
}

async function rows(name: string): Promise<Row[]> {
  return fixtureSql<Row[]>`
    select owner_user_id, group_id, parent_id from categories where name = ${name}`;
}

test.beforeEach(({}, testInfo) => {
  // A forged call does not depend on the viewport.
  test.skip(testInfo.project.name === "mobile", "the action is the same at both widths");
});

test.afterEach(async () => {
  await fixtureSql`delete from categories where name like ${`${PREFIX}%`}`;
});

test.describe("a plain member in a fund", () => {
  test.use({ storageState: MEMBER_STORAGE_STATE });

  test("asking for their own set writes a category of their own and no fund's", async ({ page, browser }) => {
    // Kills: every placement resolved to the group.
    const action = await learnAction(browser);
    await seedGroup();
    const name = nameFor("miembro propio");

    const text = await forge(page, action, { name, placement: "personal" });

    expect(text).not.toContain("errors.");
    const written = await rows(name);
    expect(written).toHaveLength(1);
    expect(written[0].owner_user_id).toBe(readScope().memberUserId);
    expect(written[0].group_id).toBeNull();
  });

  test("asking for the fund's set is refused by name and writes nothing", async ({ page, browser }) => {
    // Kills: the 42501 mapping dropped (the member reads «something went wrong»).
    const action = await learnAction(browser);
    await seedGroup();
    const name = nameFor("miembro fondo");

    const text = await forge(page, action, { name, placement: "group" });

    expect(text).toContain("errors.notLeader");
    expect(text).not.toContain("errors.unexpected");
    expect(await rows(name)).toHaveLength(0);
  });
});

test.describe("the leader of a fund", () => {
  test("asking for the fund's set writes a category of the fund", async ({ page, browser }) => {
    // Kills: the two placements swapped.
    const action = await learnAction(browser);
    const { groupId } = await seedGroup();
    const name = nameFor("lider fondo");

    const text = await forge(page, action, { name, placement: "group" });

    expect(text).not.toContain("errors.");
    const written = await rows(name);
    expect(written).toHaveLength(1);
    expect(written[0].group_id).toBe(groupId);
    expect(written[0].owner_user_id).toBeNull();
  });

  test("asking for their own set writes a personal category, not the fund's", async ({ page, browser }) => {
    // Kills: the placement ignored for the leader (it falls to the fund).
    const action = await learnAction(browser);
    await seedGroup();
    const name = nameFor("lider propio");

    const text = await forge(page, action, { name, placement: "personal" });

    expect(text).not.toContain("errors.");
    const written = await rows(name);
    expect(written).toHaveLength(1);
    expect(written[0].owner_user_id).toBe(readScope().userId);
    expect(written[0].group_id).toBeNull();
  });

  test("sending no placement keeps today's rule: the fund's set", async ({ page, browser }) => {
    // Kills: an absent placement defaulted to personal (the landed dialog would stop writing to the fund).
    const action = await learnAction(browser);
    const { groupId } = await seedGroup();
    const name = nameFor("lider sin lugar");

    const text = await forge(page, action, { name });

    expect(text).not.toContain("errors.");
    const written = await rows(name);
    expect(written).toHaveLength(1);
    expect(written[0].group_id).toBe(groupId);
    expect(written[0].owner_user_id).toBeNull();
  });

  test("a placement outside the two is refused by its message and writes nothing", async ({ page, browser }) => {
    // Kills: the placement typed as any string (the row lands in the fund or a personal set).
    const action = await learnAction(browser);
    await seedGroup();
    const name = nameFor("lugar raro");

    const text = await forge(page, action, { name, placement: "other" });

    expect(text).toContain("categories.errors.placementInvalid");
    expect(await rows(name)).toHaveLength(0);
  });

  test("a personal category under a parent of the fund is refused by name and writes nothing", async ({ page, browser }) => {
    // Kills: the database's refusal left to reach «something went wrong».
    const action = await learnAction(browser);
    const { groupId } = await seedGroup();
    const parentId = randomUUID();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, group_id, name, kind, color)
        values (${parentId}, ${groupId}, ${nameFor("padre del fondo")}, 'expense', ${COLOR})`;
    });
    const name = nameFor("hija cruzada");

    const text = await forge(page, action, { name, placement: "personal", parentId });

    expect(text).toMatch(/errors\.\w+/);
    expect(text).not.toContain("errors.unexpected");
    expect(await rows(name)).toHaveLength(0);
  });
});

test.describe("a caller with no fund", () => {
  test("asking for the fund's set is refused as absent and writes nothing", async ({ page, browser }) => {
    // Kills: the missing fund falling back to a personal category.
    const action = await learnAction(browser);
    await clearGroup();
    const name = nameFor("sin fondo");

    const text = await forge(page, action, { name, placement: "group" });

    expect(text).toContain("errors.notFound");
    expect(await rows(name)).toHaveLength(0);
  });
});
