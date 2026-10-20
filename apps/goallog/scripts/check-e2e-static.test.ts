import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readE2eFiles, scan, scanEntrar, type Allowed } from "./check-e2e-static";

const lines = (...l: string[]) => [{ name: "x.spec.ts", text: ["test(\"a\", async ({ page }) => {", ...l, "});"].join("\n") }];
const run = (l: string[], allowed: Allowed[] = []) => scan(lines(...l), allowed);

const MEASURE = "  const b = await page.locator(\"h1\").boundingBox();";

// campo-chip.spec.ts:44-52 with `visit(` swapped for a bare `goto`.
const CAMPO_CHIP = [
  "  await page.goto(goalUrl.replace(/\\/metas\\/.*/, \"/conexiones\"));",
  "  const gap = await page.evaluate(() => {",
  "    const hint = [...document.querySelectorAll(\"span\")].find((s) => /para reconocerla/i.test(s.textContent ?? \"\"));",
  "    const next = hint?.closest(\"form, div\")?.nextElementSibling ?? hint?.parentElement?.nextElementSibling;",
  "    if (!hint || !next) return null;",
  "    return next.getBoundingClientRect().top - hint.getBoundingClientRect().bottom;",
  "  });",
  "  expect(gap).not.toBeNull();",
];

test("campo-chip's hint gap without its anchor fails; with visit it passes", () => {
  assert.equal(run(CAMPO_CHIP).violations.length, 1);
  assert.equal(run(CAMPO_CHIP).violations[0].line, 7);
  const anchored = [...CAMPO_CHIP];
  anchored[0] = "  await visit(page, \"/conexiones\");";
  assert.equal(run(anchored).violations.length, 0);
});

for (const nav of ["await page.goto(\"/hoy\");", "await page.waitForURL(/\\/metas$/);", "await page.reload();"]) {
  test(`${nav.split("(")[0]} arms the check`, () => {
    assert.equal(run([`  ${nav}`, MEASURE]).violations.length, 1);
  });
}

for (const anchor of [
  "await expect(page.locator(\"main\")).toBeVisible();",
  "await settled(page);",
  "await visit(page, \"/hoy\");",
]) {
  test(`${anchor.split("(")[0]} clears it`, () => {
    assert.equal(run(["  await page.goto(\"/hoy\");", `  ${anchor}`, MEASURE]).violations.length, 0);
  });
}

test("a read with no navigation before it is fine", () => {
  assert.equal(run([MEASURE]).violations.length, 0);
});

test("a new test starts unarmed", () => {
  const text = ["test(\"a\", async () => {", "  await page.goto(\"/\");", "});", "test(\"b\", async () => {", MEASURE, "});"].join("\n");
  assert.equal(scan([{ name: "x.spec.ts", text }], []).violations.length, 0);
});

test("a comment is not a read", () => {
  assert.equal(run(["  await page.goto(\"/\");", "  // getBoundingClientRect comes later"]).violations.length, 0);
});

test("an allowlist entry hides the violation it names", () => {
  const allowed = [{ file: "x.spec.ts", line: 3, why: "reason" }];
  const out = run(["  await page.goto(\"/\");", MEASURE], allowed);
  assert.equal(out.violations.length, 0);
  assert.equal(out.stale.length, 0);
});

test("an allowlist entry that matches nothing is stale", () => {
  const allowed = [{ file: "x.spec.ts", line: 99, why: "reason" }];
  const out = run(["  await page.goto(\"/\");", MEASURE], allowed);
  assert.equal(out.violations.length, 1);
  assert.deepEqual(out.stale, allowed);
});

const GOTO = "  await page.goto(\"/hoy\");";

test("a measure inside the arguments of an expect on the armed line still fails", () => {
  const out = run([GOTO, "  await expect((await el.boundingBox())!.width).toBe(6);"]);
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].line, 3);
});

test("a measure in the arguments of a multi-line awaited expect still fails", () => {
  const out = run([GOTO, "  await expect(", "    await el.evaluate((n) => n.getBoundingClientRect().width),", "  ).toBe(6);"]);
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].line, 4);
});

test("an awaited expect anchors the statement after it, even when it spans lines", () => {
  const out = run([GOTO, "  await expect(", "    page.locator(\"main\"),", "  ).toBeVisible();", MEASURE]);
  assert.equal(out.violations.length, 0);
});

test("a bare expect of a value anchors nothing", () => {
  assert.equal(run([GOTO, "  expect(value).toBe(1);", MEASURE]).violations.length, 1);
});

test("an awaited expect of an awaited read anchors nothing", () => {
  assert.equal(run([GOTO, "  await expect(await page.title()).toBe(\"a\");", MEASURE]).violations.length, 1);
});

test("expect.poll anchors", () => {
  assert.equal(run([GOTO, "  await expect.poll(() => n).toBe(1);", MEASURE]).violations.length, 0);
});

test("every match on a line counts, not the first", () => {
  const out = run(["  await page.goto(a); await settled(page); await page.goto(b); const x = await el.boundingBox();"]);
  assert.equal(out.violations.length, 1);
});

const HELPER = (body: string[]) => ({
  name: "ayuda.ts",
  text: ["import { expect } from \"./fixtures\";", ...body].join("\n"),
});
const SPEC = (l: string[]) => ({ name: "y.spec.ts", text: ["test(\"a\", async ({ page }) => {", ...l, "});"].join("\n") });
const MEASURING = HELPER(["export async function measure(page) {", "  return await page.locator(\"h1\").boundingBox();", "}"]);

test("a non-spec file is scanned like a spec", () => {
  const out = scan([HELPER(["export async function go(page) {", "  await page.goto(\"/\");", "  return await page.locator(\"h1\").boundingBox();", "}"])], []);
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].file, "ayuda.ts");
});

test("a call to a helper that measures with no anchor fails after goto, naming the helper", () => {
  const out = scan([MEASURING, SPEC(["  await page.goto(\"/\");", "  await measure(page);"])], []);
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].helper, "measure");
  assert.equal(out.violations[0].file, "y.spec.ts");
});

test("a helper that anchors before it measures is not a measure", () => {
  const boxOf = HELPER(["export const boxOf = async (loc) => {", "  await expect(loc).toBeVisible();", "  return (await loc.boundingBox())!;", "};"]);
  assert.equal(scan([boxOf, SPEC(["  await page.goto(\"/\");", "  await boxOf(page);"])], []).violations.length, 0);
});

test("an anchor between the goto and the helper call clears it", () => {
  const out = scan([MEASURING, SPEC(["  await page.goto(\"/\");", "  await settled(page);", "  await measure(page);"])], []);
  assert.equal(out.violations.length, 0);
});

test("a helper that calls a measuring helper measures too", () => {
  const outer = HELPER(["export async function outer(page) {", "  return measure(page);", "}"]);
  const out = scan([MEASURING, outer, SPEC(["  await page.goto(\"/\");", "  await outer(page);"])], []);
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].helper, "outer");
});

test("a helper that calls a measuring helper declared after it measures too", () => {
  const outer = HELPER(["export async function outer(page) {", "  return measure(page);", "}"]);
  const out = scan([outer, MEASURING, SPEC(["  await page.goto(\"/\");", "  await outer(page);"])], []);
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].helper, "outer");
});

test("a chain of three helpers, the measuring one declared last, measures at the top", () => {
  const top = HELPER(["export async function top(page) {", "  return middle(page);", "}"]);
  const middle = HELPER(["export async function middle(page) {", "  return measure(page);", "}"]);
  const out = scan([top, middle, MEASURING, SPEC(["  await page.goto(\"/\");", "  await top(page);"])], []);
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].helper, "top");
});

test("a function a spec exports is not a helper", () => {
  const exporting = { name: "z.spec.ts", text: ["export async function measure(page) {", "  return await page.locator(\"h1\").boundingBox();", "}"].join("\n") };
  const out = scan([exporting, SPEC(["  await page.goto(\"/\");", "  await measure(page);"])], []);
  assert.equal(out.violations.length, 0);
});

test("the files the check reads are every .ts of the folder: helpers beside specs, nothing else", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "e2e-static-"));
  try {
    mkdirSync(path.join(dir, "data"));
    writeFileSync(path.join(dir, "data", "inner.ts"), "export const nested = 1;");
    writeFileSync(path.join(dir, "b.spec.ts"), "// spec");
    writeFileSync(path.join(dir, "ayuda.ts"), "// helper");
    writeFileSync(path.join(dir, "notes.json"), "{}");
    assert.deepEqual(
      readE2eFiles(dir).map((f) => f.name),
      ["ayuda.ts", "b.spec.ts"],
    );
    assert.equal(readE2eFiles(dir)[0].text, "// helper");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// RNP-09: no spec submits `/entrar` with a typed address unless it answers the send action itself.
const TYPES_AND_SENDS = [
  "  await page.goto(\"/entrar\");",
  "  await page.getByLabel(\"Correo electrónico\").fill(\"a@b.co\");",
  "  await page.getByRole(\"button\", { name: \"Enviar código\", exact: true }).click();",
];
const FAKED = [
  "  await page.route(\"**/*\", async (route) => {",
  "    if (!route.request().headers()[\"next-action\"]) return route.continue();",
  "    await route.fulfill({ status: 200, contentType: \"text/x-component\", body });",
  "  });",
];

test("a spec that fills /entrar's address and submits is reported", () => {
  const out = scanEntrar([SPEC(TYPES_AND_SENDS)], []);
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].file, "y.spec.ts");
  assert.equal(out.violations[0].line, 3);
});

for (const verb of ["type", "pressSequentially"]) {
  test(`${verb} on the address field counts as typing`, () => {
    const lines = TYPES_AND_SENDS.map((l) => l.replace(".fill(", `.${verb}(`));
    assert.equal(scanEntrar([SPEC(lines)], []).violations.length, 1);
  });
}

test("a spec that fakes the send action's answer is not reported", () => {
  assert.equal(scanEntrar([SPEC([...FAKED, ...TYPES_AND_SENDS])], []).violations.length, 0);
});

test("a spec that visits /entrar and types nothing is not reported", () => {
  assert.equal(scanEntrar([SPEC([TYPES_AND_SENDS[0]])], []).violations.length, 0);
});

test("a spec that types the address and never submits is not reported", () => {
  assert.equal(scanEntrar([SPEC(TYPES_AND_SENDS.slice(0, 2))], []).violations.length, 0);
});

test("a comment is not a typed address", () => {
  const commented = TYPES_AND_SENDS.map((l) => l.replace(/^ {2}/, "  // "));
  assert.equal(scanEntrar([SPEC(commented)], []).violations.length, 0);
});

test("a file in the local-mailbox list is not reported, and a listed file that no longer types is stale", () => {
  const allowed = [{ file: "y.spec.ts", why: "reason" }];
  assert.equal(scanEntrar([SPEC(TYPES_AND_SENDS)], allowed).violations.length, 0);
  const out = scanEntrar([SPEC([TYPES_AND_SENDS[0]])], allowed);
  assert.deepEqual(out.stale, allowed);
});
