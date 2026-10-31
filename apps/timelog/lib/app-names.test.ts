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

test("a game or launcher is no background process for holding a word inside its name", () => {
  for (const raw of ["GhostOfTsushima.exe", "RiotClientServices.exe", "Hostess.exe", "Shostakovich Player.exe"]) assert.notEqual(readableApp(raw), null);
  assert.equal(readableApp("GhostOfTsushima.exe"), "GhostOfTsushima");
  assert.equal(readableApp("steamwebhelper.exe"), "Steam");
  assert.equal(readableApp("RiotClientServices.exe"), "Riot Client");
  assert.equal(readableApp("OneDriveStandaloneUpdater.exe"), null);
  assert.equal(readableApp("Some Update.Service.exe"), null);
});

test("raw process names read as people say them", () => {
  const names: Record<string, string> = { "WhatsApp.Root.exe": "WhatsApp", "idea64.exe": "IntelliJ IDEA", "vlc.exe": "VLC", "mpc-hc64.exe": "MPC-HC", "PowerToys.PowerLauncher.exe": "PowerToys" };
  for (const [raw, name] of Object.entries(names)) assert.equal(readableApp(raw), name);
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
