import assert from "node:assert/strict";
import { test } from "node:test";

import { projectName } from "./claude-project";

test("a project is named by what follows the folder people keep projects in", () => {
  assert.equal(projectName("-home-cxrkeyb-projects-finances-app"), "finances-app");
  assert.equal(projectName("C--Users-wilson-repos-shelf"), "shelf");
});

test("a folder with no such parent keeps its name without the leading separators", () => {
  assert.equal(projectName("-tmp-scratch"), "tmp-scratch");
  assert.equal(projectName("shelf"), "shelf");
  assert.equal(projectName("---"), "---");
});
