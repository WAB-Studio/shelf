import assert from "node:assert/strict";
import { test } from "node:test";

import { projectName } from "./claude-project";

test("a project is named by what follows the folder people keep projects in", () => {
  assert.equal(projectName("-home-cxrkeyb-projects-finances-app"), "finances-app");
  assert.equal(projectName("C--Users-wilson-repos-shelf"), "shelf");
});

test("a project outside those folders is named by what follows the home folder and its own folders", () => {
  assert.equal(projectName("C--Users-wilson-Documents-un-proyecto-largo"), "un-proyecto-largo");
  assert.equal(projectName("-home-cxrkeyb-Desktop-notas"), "notas");
  assert.equal(projectName("-Users-ana-mi-app"), "mi-app");
});

test("a folder with no such parent is named by its last piece", () => {
  assert.equal(projectName("-tmp-scratch"), "scratch");
  assert.equal(projectName("shelf"), "shelf");
  assert.equal(projectName("---"), "---");
});
