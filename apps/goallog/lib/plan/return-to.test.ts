import assert from "node:assert/strict";
import test from "node:test";

import { planHrefFrom, returnTo } from "./return-to";

const GOAL = "0b9c8c1e-6f43-4b8e-9a2d-5d1c3f0a7e11";
const OTHER = "1b9c8c1e-6f43-4b8e-9a2d-5d1c3f0a7e11";
const FALLBACK = `/metas/${GOAL}/meses`;

test("returnTo: each accepted form passes through", () => {
  for (const path of [
    `/metas/${GOAL}`,
    `/metas/${GOAL}/meses`,
    `/metas/${GOAL}/meses/2026-10`,
    "/mes",
    "/mes?month=2026-10&x=a%20b",
  ]) {
    assert.equal(returnTo(path, GOAL), path);
  }
});

test("returnTo: anything else falls back to the goal's months", () => {
  for (const raw of [
    null,
    "",
    "//evil.example",
    "//evil.example/mes",
    "https://evil.example",
    "http://evil.example/mes",
    "javascript:alert(1)",
    "/\\evil.example",
    `/metas/${OTHER}`,
    `/metas/${OTHER}/meses/2026-10`,
    `/metas/${GOAL}/meses/2026-13`,
    `/metas/${GOAL}/meses/2026-10/tarea/nueva`,
    `/metas/${GOAL}/`,
    "/mes/otro",
    "/mes?x=//evil",
    "/mes?x=<script>",
    "/meses",
  ]) {
    assert.equal(returnTo(raw, GOAL), FALLBACK, String(raw));
  }
});

test("planHrefFrom: the origin rides encoded and reads back through returnTo", () => {
  const href = planHrefFrom(GOAL, "2026-10", "/mes?month=2026-10");
  const volver = new URL(href, "http://x").searchParams.get("volver");
  assert.equal(returnTo(volver, GOAL), "/mes?month=2026-10");
});
