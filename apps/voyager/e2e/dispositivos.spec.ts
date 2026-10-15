import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import type { Locator, Page } from "@playwright/test";
import postgres from "postgres";

import { closeRun, openRun } from "@repo/harness-registry";

import messages from "../messages/es.json";
import { expect, test } from "./fixtures";

// Module 548, RL-25, RNL-02: the device list. Written from the approved
// boards (DispositivosLista / DispositivosFallo, 2026-10-08) and the catalog,
// not from the component. `GET`/`DELETE /api/devices` are answered by
// `page.route`; the session enters through the harness, never through
// /cuenta's form (no address is ever typed there).

try {
  process.loadEnvFile(path.join(__dirname, "../.env.local"));
} catch {
  // No .env.local: whatever the shell already exported.
}

const d = messages.account.devices;

type Reader = { id: string; email: string };
type Device = { deviceId: string; label: string; createdAt: string; lastSeenAt: string; lookups: number };

async function landToken(sql: postgres.Sql, reader: Reader): Promise<string> {
  const hash = randomBytes(32).toString("hex");
  await sql`
    update auth.users
    set recovery_token = ${hash}, recovery_sent_at = now(), updated_at = now()
    where id = ${reader.id}`;
  await sql`
    insert into auth.one_time_tokens
      (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
    values
      (${randomUUID()}, ${reader.id}, 'recovery_token', ${hash}, ${reader.email}, now(), now())`;
  return hash;
}

async function mintReader(sql: postgres.Sql, runId: string): Promise<Reader> {
  const id = randomUUID();
  const email = `harness-reader-${id}@example.invalid`;
  await sql.begin(async (tx) => {
    await tx`
      insert into auth.users (
        id, instance_id, aud, role, email, email_confirmed_at,
        encrypted_password, confirmation_token, recovery_token,
        email_change, email_change_token_current, email_change_token_new,
        email_change_confirm_status, phone_change, phone_change_token,
        reauthentication_token, raw_app_meta_data, raw_user_meta_data,
        is_sso_user, is_anonymous, created_at, updated_at)
      values (
        ${id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', ${email}, now(),
        '', '', '',
        '', '', '',
        0, '', '',
        '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        false, false, now(), now())`;
    await tx`
      insert into harness.identities (user_id, run_id, email, disposition)
      values (${id}, ${runId}, ${email}, 'ephemeral')`;
  });
  return { id, email };
}

async function signInWith(page: Page, hash: string): Promise<void> {
  const response = await page.request.get(`/auth/confirm?token_hash=${hash}&type=magiclink`, {
    maxRedirects: 0,
  });
  const location = response.headers()["location"];
  expect(location?.includes("error="), `redirected to ${location ?? "nowhere"}`).toBe(false);
}

// A reader signed in on this page's context, torn down afterwards.
async function withReader(page: Page, body: (signIn: () => Promise<void>) => Promise<void>): Promise<void> {
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const runId = await openRun("e2e", sql);
  const reader = await mintReader(sql, runId);
  try {
    await body(async () => signInWith(page, await landToken(sql, reader)));
  } finally {
    await sql`delete from harness.identities where user_id = ${reader.id}`;
    await sql`delete from auth.users where id = ${reader.id}`;
    await closeRun(sql);
    await sql.end();
  }
}

function device(label: string, extra: Partial<Device> = {}): Device {
  return {
    deviceId: randomUUID(),
    label,
    createdAt: "2026-10-03T12:00:00.000Z",
    lastSeenAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    lookups: 1,
    ...extra,
  };
}

type Net = { gets: number; deletes: string[] };

// Answers the list with `answer` (a status and body, or a promise to hold it)
// and every DELETE with `deleteStatus`.
async function stubDevices(
  page: Page,
  answer: () => Promise<{ status: number; devices?: Device[] }> | { status: number; devices?: Device[] },
  deleteStatus = 200,
): Promise<Net> {
  const net: Net = { gets: 0, deletes: [] };
  await page.route("**/api/devices", async (route) => {
    const request = route.request();
    if (request.method() === "DELETE") {
      net.deletes.push((request.postDataJSON() as { deviceId: string }).deviceId);
      await route.fulfill({
        status: deleteStatus,
        contentType: "application/json",
        body: JSON.stringify(deleteStatus === 200 ? { retired: true } : { error: "x" }),
      });
      return;
    }
    net.gets += 1;
    const { status, devices } = await answer();
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(status === 200 ? { devices: devices ?? [] } : { error: "x" }),
    });
  });
  return net;
}

const list = (devices: Device[]) => () => ({ status: 200, devices });

const row = (page: Page, text: string): Locator =>
  page.locator("div").filter({ has: page.getByText(text, { exact: true }) }).filter({
    has: page.getByRole("button", { name: d.retire, exact: true }),
  }).last();

test("RL-25: while the list is on its way, the panel says it is loading", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await stubDevices(page, async () => {
      await held;
      return { status: 200, devices: [] };
    });
    await page.goto("/cuenta");
    await expect(page.getByText(d.loading)).toBeVisible();
    await expect(page.getByText(d.empty)).toHaveCount(0);
    release();
    await expect(page.getByText(d.empty)).toBeVisible();
    await expect(page.getByText(d.loading)).toHaveCount(0);
  });
});

test("RL-25: a list that cannot load says so, not that an operation failed, and Reintentar asks again", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    const net = await stubDevices(page, () => ({ status: 500 }));
    await page.goto("/cuenta");
    await expect(page.getByText(d.loadFailed, { exact: true })).toBeVisible();
    await expect(page.getByText(d.retireFailed)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: d.title })).toBeVisible();

    const before = net.gets;
    await page.getByRole("button", { name: d.retry, exact: true }).click();
    await expect.poll(() => net.gets).toBe(before + 1);
    await expect(page.getByText(d.loadFailed, { exact: true })).toBeVisible();
  });
});

test("RL-25: with no device copying, the list says so", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    await stubDevices(page, list([]));
    await page.goto("/cuenta");
    await expect(page.getByText(d.empty)).toBeVisible();
    await expect(page.getByText(d.loadFailed)).toHaveCount(0);
  });
});

test("RNL-02: «Visto por última vez» keeps the copy's clock: a moment, then the hours", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    await stubDevices(
      page,
      list([
        device("chrome:linux", { lastSeenAt: new Date(Date.now() - 20_000).toISOString() }),
        device("firefox:windows", { lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString() }),
      ]),
    );
    await page.goto("/cuenta");
    await expect(page.getByText("Visto por última vez: hace un momento", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Visto por última vez: hace 3 horas", { exact: true })).toHaveCount(1);
    await expect(page.getByText(/hace \d+ segundos?/)).toHaveCount(0);
  });
});

test("RNL-02: an unreadable last-seen date reads «Nunca visto», never a guessed time", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    await stubDevices(page, list([device("chrome:linux", { lastSeenAt: "not a date" })]));
    await page.goto("/cuenta");
    await expect(page.getByText(d.neverSeen, { exact: true })).toBeVisible();
    await expect(page.getByText(/Visto por última vez/)).toHaveCount(0);
  });
});

test("RL-25: a retire that fails says so on that row and keeps the list", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    const a = device("chrome:android");
    const b = device("safari:ios");
    const net = await stubDevices(page, list([a, b]), 500);
    await page.goto("/cuenta");
    await expect(page.getByText("Safari en iPhone", { exact: true })).toBeVisible();

    await row(page, "Safari en iPhone").getByRole("button", { name: d.retire, exact: true }).click();
    await row(page, "Safari en iPhone").getByRole("button", { name: d.confirm, exact: true }).click();
    await expect(page.getByText(d.retireFailed, { exact: true })).toHaveCount(1);
    expect(net.deletes).toEqual([b.deviceId]);
    await expect(page.getByText(d.loadFailed)).toHaveCount(0);
    await expect(page.getByText("Chrome en Android", { exact: true })).toBeVisible();
    await expect(page.getByText("Safari en iPhone", { exact: true })).toBeVisible();
  });
});

test("RL-25: cancelling a retire puts the row back at rest and sends nothing", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    const net = await stubDevices(page, list([device("chrome:android"), device("safari:ios")]));
    await page.goto("/cuenta");
    await page.getByRole("button", { name: d.retire, exact: true }).first().click();
    await expect(page.getByRole("button", { name: d.confirm, exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: d.cancel, exact: true }).click();
    await expect(page.getByRole("button", { name: d.confirm, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: d.retire, exact: true })).toHaveCount(2);
    expect(net.deletes).toEqual([]);
  });
});

test("RL-25: one tap on «Retirar», one on «Retirar dispositivo», one DELETE and the row leaves", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    const a = device("chrome:android");
    const net = await stubDevices(page, list([a, device("safari:ios")]));
    await page.goto("/cuenta");
    await row(page, "Chrome en Android").getByRole("button", { name: d.retire, exact: true }).click();
    expect(net.deletes).toEqual([]);
    await row(page, "Chrome en Android").getByRole("button", { name: d.confirm, exact: true }).click();
    await expect(page.getByText("Chrome en Android", { exact: true })).toHaveCount(0);
    expect(net.deletes).toEqual([a.deviceId]);
  });
});

async function look(button: Locator) {
  return button.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      color: style.color,
      background: style.backgroundColor,
      accent: el.getAttribute("data-accent-color"),
      variant: [...el.classList].filter((c) => c.startsWith("rt-variant-")),
      radius: style.borderRadius,
      height: el.getBoundingClientRect().height,
    };
  });
}

test("RL-25: «Retirar» weighs like «Cerrar sesión» (gray, soft); «Retirar dispositivo» keeps the accent", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    await stubDevices(page, list([device("chrome:android")]));
    await page.goto("/cuenta");
    const retire = page.getByRole("button", { name: d.retire, exact: true });
    const signOut = page.getByRole("button", { name: messages.account.signOut, exact: true });
    await expect(retire).toBeVisible();

    const resting = await look(retire);
    const anchor = await look(signOut);
    expect(anchor.variant).toEqual(["rt-variant-soft"]);
    expect(resting.accent).toBe(anchor.accent);
    expect(resting.variant).toEqual(anchor.variant);
    expect(resting.color).toBe(anchor.color);
    expect(resting.background).toBe(anchor.background);
    expect(resting.radius).toBe(anchor.radius);
    expect(resting.height).toBeGreaterThanOrEqual(44);

    await retire.click();
    const confirm = await look(page.getByRole("button", { name: d.confirm, exact: true }));
    expect(confirm.accent).not.toBe(anchor.accent);
    expect(confirm.color).not.toBe(anchor.color);
    expect(confirm.background).not.toBe(anchor.background);
  });
});

test("RL-25, RNL-02: a half-known label keeps its known half; unknown or old text reads unknown", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    await stubDevices(
      page,
      list([
        device("chrome:other"),
        device("other:android"),
        device("other:other"),
        device("Chrome on Android"),
        device("chrome:linux"),
      ]),
    );
    await page.goto("/cuenta");
    await expect(page.getByText("Chrome en otro sistema", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Navegador desconocido en Android", { exact: true })).toHaveCount(1);
    await expect(page.getByText(d.labelUnknown, { exact: true })).toHaveCount(2);
    await expect(page.getByText("Chrome en Linux", { exact: true })).toHaveCount(1);
    for (const raw of ["chrome:other", "other:android", "other:other", "Chrome on Android"]) {
      await expect(page.getByText(raw, { exact: true })).toHaveCount(0);
    }
  });
});

test("RL-25: each row says since when it copies; an unreadable date draws no line", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    await stubDevices(
      page,
      list([
        device("chrome:linux", { createdAt: "2026-10-03T12:00:00.000Z" }),
        device("safari:ios", { createdAt: "garbage" }),
      ]),
    );
    await page.goto("/cuenta");
    await expect(page.getByText("Desde el 3 de oct.", { exact: true })).toHaveCount(1);
    await expect(page.getByText(/^Desde el /)).toHaveCount(1);
    await expect(page.getByText(/Invalid|NaN/)).toHaveCount(0);
  });
});

test("RL-25: two alike devices are told apart by the date each began copying", async ({ page }) => {
  test.setTimeout(45_000);
  await withReader(page, async (signIn) => {
    await signIn();
    await stubDevices(
      page,
      list([
        device("chrome:android", { createdAt: "2026-10-03T12:00:00.000Z" }),
        device("chrome:android", { createdAt: "2026-09-21T12:00:00.000Z" }),
      ]),
    );
    await page.goto("/cuenta");
    await expect(page.getByText("Chrome en Android", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Desde el 3 de oct.", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Desde el 21 de sept.", { exact: true })).toHaveCount(1);
  });
});

test.describe("the reader's own zone", () => {
  test.use({ timezoneId: "America/Bogota" });

  test("RL-25: a device added at 21:00 Bogotá reads that Bogotá day, never the UTC one after it", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await withReader(page, async (signIn) => {
      await signIn();
      // 02:00Z on the 7th: the 6th in Bogotá. A server on UTC reads the 7th.
      await stubDevices(
        page,
        list([
          device("chrome:linux", { createdAt: "2026-10-06T21:00:00-05:00" }),
          device("safari:ios", { createdAt: "2026-10-01T00:30:00-05:00" }),
        ]),
      );
      await page.goto("/cuenta");
      await expect(page.getByText("Desde el 6 de oct.", { exact: true })).toHaveCount(1);
      await expect(page.getByText("Desde el 1 de oct.", { exact: true })).toHaveCount(1);
      await expect(page.getByText("Desde el 7 de oct.", { exact: true })).toHaveCount(0);
    });
  });
});
