import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

import { themeScript } from "./theme";

type Probe = { classes: string[]; colorScheme: string };

// Runs the script against stubs: `stored` is what the storage returns (or a
// function that throws), `dark` what `matchMedia` answers (or a function that throws).
function run(options: {
  stored: string | null | (() => never);
  dark: boolean | (() => never);
}): Probe {
  const classes = new Set<string>();
  const root = {
    classList: {
      add: (name: string) => classes.add(name),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
    },
    style: { colorScheme: "" },
  };
  const { stored, dark } = options;

  runInNewContext(themeScript, {
    document: { documentElement: root },
    localStorage: {
      getItem: () => (typeof stored === "function" ? stored() : stored),
    },
    matchMedia: () => ({ matches: typeof dark === "function" ? dark() : dark }),
  });

  return { classes: [...classes], colorScheme: root.style.colorScheme };
}

const boom = (): never => {
  throw new Error("unavailable");
};

test("a stored theme wins over the system appearance", () => {
  assert.deepEqual(run({ stored: "dark", dark: false }), {
    classes: ["dark"],
    colorScheme: "dark",
  });
  assert.deepEqual(run({ stored: "light", dark: true }).classes, ["light"]);
});

test("an unknown stored value falls to the system appearance", () => {
  assert.deepEqual(run({ stored: "blue", dark: true }).classes, ["dark"]);
  assert.deepEqual(run({ stored: null, dark: true }).classes, ["dark"]);
});

test("a storage that throws falls to the system appearance", () => {
  assert.deepEqual(run({ stored: boom, dark: true }).classes, ["dark"]);
});

test("a matchMedia that throws falls to light", () => {
  assert.deepEqual(run({ stored: "system", dark: boom }), {
    classes: ["light"],
    colorScheme: "light",
  });
});

test("both failing still lands light and never throws", () => {
  assert.deepEqual(run({ stored: boom, dark: boom }).classes, ["light"]);
});
