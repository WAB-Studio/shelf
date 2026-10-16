import { test, expect } from "./fixtures";

// `lib/theme.ts`'s blocking `<head>` script is the only thing that decides
// the very first frame (RNP-08); React never repaints it correctly a second
// time on its own — a mount effect only reacts to a later click. A read at
// the navigation's "commit" is no observation of that frame: the new
// document may have no `<html>` yet, or an `<html>` the head script has not
// reached. So an init script samples the class on every animation frame of
// the reloaded page — a frame callback runs right before that frame is
// painted — and the test reads the samples once the page has settled.
test("the theme control, used once, survives a reload with no flash of the other face (RNP-08)", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Cambiar a modo oscuro" })).toBeVisible();

  // No choice made yet: opens in the system's mode (RNP-08's own second
  // half), never a face `applyTheme` had to write first. `<html>` also
  // carries the two font-variable classes from `app/layout.tsx`, so a
  // regexp is matched rather than the whole attribute.
  await expect(page.locator("html")).toHaveClass(/\blight\b/);

  await page.getByRole("button", { name: "Cambiar a modo oscuro" }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);

  await page.addInitScript(() => {
    const frames: string[] = [];
    (window as unknown as { __themeFrames: string[] }).__themeFrames = frames;
    const sample = () => {
      const root = document.documentElement;
      if (root) frames.push(root.className);
      if (document.readyState !== "complete") requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.reload();

  // Settled: the content, not the loading fallback, is standing.
  await expect(page.locator("main")).toHaveCount(1);
  const frames = await page.evaluate(
    () => (window as unknown as { __themeFrames: string[] }).__themeFrames,
  );
  expect(frames.length).toBeGreaterThan(0);
  expect(frames[0]).toMatch(/\bdark\b/);
  for (const frame of frames) {
    expect(frame).toMatch(/\bdark\b/);
    expect(frame).not.toMatch(/\blight\b/);
  }

  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
});

// The dark half of RNP-08's «opens in the system's mode». The sampler is
// installed before the very first navigation, so the first load's frames are
// read, not only a reload's. It survives navigations, and each document
// starts its own array.
test("a dark system opens dark from the first frame, and a choice of light outlives it (RNP-08)", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    const frames: string[] = [];
    (window as unknown as { __themeFrames: string[] }).__themeFrames = frames;
    const sample = () => {
      const root = document.documentElement;
      if (root) frames.push(root.className);
      if (document.readyState !== "complete") requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const readFrames = () =>
    page.evaluate(
      () => (window as unknown as { __themeFrames: string[] }).__themeFrames,
    );

  await page.goto("/");
  await expect(page.locator("main")).toHaveCount(1);
  const first = await readFrames();
  expect(first.length).toBeGreaterThan(0);
  for (const frame of first) {
    expect(frame).toMatch(/\bdark\b/);
    expect(frame).not.toMatch(/\blight\b/);
  }

  await page.getByRole("button", { name: "Cambiar a modo claro" }).click();
  await expect(page.locator("html")).toHaveClass(/\blight\b/);

  await page.reload();
  await expect(page.locator("main")).toHaveCount(1);
  const second = await readFrames();
  expect(second.length).toBeGreaterThan(0);
  for (const frame of second) {
    expect(frame).toMatch(/\blight\b/);
    expect(frame).not.toMatch(/\bdark\b/);
  }
  await expect(page.locator("html")).toHaveClass(/\blight\b/);
});
