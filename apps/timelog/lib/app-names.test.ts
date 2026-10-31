import assert from "node:assert/strict";
import { test } from "node:test";

import { readableApp, readableApps } from "./app-names";

test("an app drops its extension and well-known ones read as people say them", () => {
  assert.equal(readableApp("Code.exe"), "VS Code");
  assert.equal(readableApp("msedge.exe"), "Edge");
  assert.equal(readableApp("chrome.exe"), "Chrome");
  assert.equal(readableApp("Microsoft.Teams.Collaboration.Experience.Host.exe"), "Teams");
  assert.equal(readableApp("Teams.exe"), "Teams");
  assert.equal(readableApp("Obscure Tool.EXE"), "Obscure Tool");
});

test("Windows background hosts are system noise", () => {
  for (const raw of ["LockApp.exe", "SearchHost.exe", "msedgewebview2.exe", "ShellExperienceHost.exe"]) assert.equal(readableApp(raw), null);
});

test("updaters, helpers and services are system noise; javaw reads Java", () => {
  for (const raw of ["AdobeAcrobatReaderDCUpdaterServiceHelper64.exe", "GoogleUpdate Broker.exe", "OneDriveStandaloneUpdater.exe", "RuntimeBroker.exe"]) assert.equal(readableApp(raw), null);
  assert.equal(readableApp("javaw.exe"), "Java");
  assert.equal(readableApp("Obscure Tool.exe"), "Obscure Tool");
});

test("apps group under their readable names, system noise as one row", () => {
  const rows = readableApps(
    [
      { app: "chrome.exe", seconds: 100 },
      { app: "Code.exe", seconds: 300 },
      { app: "LockApp.exe", seconds: 20 },
      { app: "SearchHost.exe", seconds: 30 },
      { app: "Chrome", seconds: 50 },
    ],
    "Sistema",
  );
  assert.deepEqual(rows, [
    { app: "VS Code", seconds: 300 },
    { app: "Chrome", seconds: 150 },
    { app: "Sistema", seconds: 50 },
  ]);
});
