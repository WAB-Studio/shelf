import assert from "node:assert/strict";
import { test } from "node:test";

import { appClass, timeByClass } from "./app-classes";

test("an app takes its class by its readable name; Sistema is its own and an unknown app is «other»", () => {
  assert.equal(appClass("VS Code", "Sistema"), "code");
  assert.equal(appClass("Chrome", "Sistema"), "browser");
  assert.equal(appClass("Discord", "Sistema"), "comms");
  assert.equal(appClass("Steam", "Sistema"), "leisure");
  assert.equal(appClass("Sistema", "Sistema"), "system");
  assert.equal(appClass("GhostOfTsushima", "Sistema"), "other");
});

test("time adds up by class, longest first, and a class with nothing is left out", () => {
  const rows = timeByClass(
    [
      { app: "VS Code", seconds: 600 },
      { app: "Terminal", seconds: 300 },
      { app: "Chrome", seconds: 800 },
      { app: "Figma", seconds: 100 },
      { app: "Sistema", seconds: 0 },
    ],
    "Sistema",
  );
  assert.deepEqual(rows, [
    { kind: "code", seconds: 900 },
    { kind: "browser", seconds: 800 },
    { kind: "other", seconds: 100 },
  ]);
});
