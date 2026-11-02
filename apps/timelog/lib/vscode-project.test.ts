import assert from "node:assert/strict";
import { test } from "node:test";

import { projectOfWindow, projectsOf } from "./vscode-project";

test("a window title names its workspace folder", () => {
  assert.equal(projectOfWindow("Code.exe", "route.ts — shelf — Visual Studio Code"), "shelf");
  assert.equal(projectOfWindow("Code.exe", "route.ts - shelf - Visual Studio Code"), "shelf");
  assert.equal(projectOfWindow("Code.exe", "● route.ts - shelf - Visual Studio Code"), "shelf");
  assert.equal(projectOfWindow("Code.exe", "shelf - Visual Studio Code"), "shelf");
});

test("remote and workspace decorations are not part of the folder", () => {
  assert.equal(projectOfWindow("Code.exe", "a.py - shelf [WSL: Ubuntu] - Visual Studio Code"), "shelf");
  assert.equal(projectOfWindow("Code.exe", "a.py - api [Remote - SSH: box] - Visual Studio Code"), "api");
  assert.equal(projectOfWindow("Code.exe", "a.py - mono (Workspace) - Visual Studio Code"), "mono");
});

test("Insiders and Cursor read the same", () => {
  assert.equal(projectOfWindow("Code - Insiders.exe", "a.ts - shelf - Visual Studio Code - Insiders"), "shelf");
  assert.equal(projectOfWindow("Cursor.exe", "a.ts - shelf - Cursor"), "shelf");
});

test("no folder, another app or an editor screen names no project", () => {
  assert.equal(projectOfWindow("Code.exe", "notes.txt - Visual Studio Code"), null);
  assert.equal(projectOfWindow("Code.exe", "Welcome - Visual Studio Code"), null);
  for (const lone of ["Makefile", "Dockerfile", "LICENSE", "Untitled-1", "Keyboard Shortcuts", "Untitled (Workspace)", ".gitignore"]) {
    assert.equal(projectOfWindow("Code.exe", `${lone} - Visual Studio Code`), null, lone);
  }
  assert.equal(projectOfWindow("chrome.exe", "a - b - Visual Studio Code"), null);
  assert.equal(projectOfWindow("Code.exe", "Visual Studio Code"), null);
});

test("projects add up across files, longest first", () => {
  const rows = [
    { app: "Code.exe", title: "a.ts - shelf - Visual Studio Code", seconds: 100 },
    { app: "Code.exe", title: "b.ts - shelf - Visual Studio Code", seconds: 50 },
    { app: "Cursor.exe", title: "x.py - tools - Cursor", seconds: 200 },
    { app: "Slack.exe", title: "general", seconds: 999 },
  ];
  assert.deepEqual(projectsOf(rows), [{ project: "tools", seconds: 200 }, { project: "shelf", seconds: 150 }]);
});

test("a profile name before the product is not the project", () => {
  assert.equal(projectOfWindow("Code.exe", "route.ts - shelf - Work - Visual Studio Code"), "shelf");
  assert.equal(projectOfWindow("Code.exe", "\u25CF Makefile - shelf - Work - Visual Studio Code"), "shelf");
});

test("a dotted folder alone is the project", () => {
  assert.equal(projectOfWindow("Code.exe", "next.js - Visual Studio Code"), "next.js");
  assert.equal(projectOfWindow("Code.exe", "shelf - Work - Visual Studio Code"), "shelf");
});

test("bracketed text after the product and any remote tag are dropped", () => {
  assert.equal(projectOfWindow("Code.exe", "a.ts - shelf - Visual Studio Code [Administrator]"), "shelf");
  assert.equal(projectOfWindow("Code.exe", "a.ts - shelf [Tunnel: box] - Visual Studio Code"), "shelf");
  assert.equal(projectOfWindow("Code.exe", "a.ts - shelf [Container node] - Visual Studio Code [Unsupported]"), "shelf");
});

test("VSCodium and Code - OSS read the same", () => {
  assert.equal(projectOfWindow("VSCodium.exe", "a.ts - shelf - VSCodium"), "shelf");
  assert.equal(projectOfWindow("code-oss", "a.ts - shelf - Code - OSS"), "shelf");
});
