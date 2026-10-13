import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { correctionKeys, declinedKeys, formKey, noticeKey, outKey, remapped } from "./reason-key";

const catalogue = JSON.parse(readFileSync(new URL("../../messages/es/import.json", import.meta.url), "utf8"));

// The catalogues the keys resolve against: `import` is the one a code's sentence lives in.
function leaf(key: string): string | undefined {
  const value = key.split(".").reduce<unknown>(
    (node, part, i) => (i === 0 ? (part === "import" ? catalogue : undefined) : (node as Record<string, unknown> | undefined)?.[part]),
    undefined,
  );
  return typeof value === "string" ? value : undefined;
}

const CORRECTIONS = [
  "nameShortened",
  "parentEstimateDropped",
  "parentEstimateDiffers",
  "cadenceClamped",
  "rateToRhythm",
  "holderRhythmToNote",
  "holderMonthsToNote",
  "endWithinAbove",
  "measureInHours",
  "monthSumDiffers",
  "monthOverRhythm",
  "cadenceToWeekdays",
];
const FORMS = [
  "import.errors.form.goal",
  "import.errors.form.goalLong",
  "import.errors.form.horizon",
  "import.errors.form.measure",
  "import.errors.form.rhythmPlace",
  "import.errors.form.rhythmUnit",
  "import.errors.form.rhythmAmount",
  "import.errors.form.firstLine",
  "import.errors.form.section",
  "import.errors.form.phase",
  "import.errors.form.month",
  "import.errors.form.monthReal",
  "import.errors.form.monthUnit",
  "import.errors.form.monthTime",
  "import.errors.form.monthWhole",
  "import.errors.form.commitment",
  "import.errors.form.commitmentUnit",
  "import.errors.form.commitmentTime",
  "import.errors.estimateNotTime",
  "import.errors.form.task",
  "import.errors.form.child",
  "import.errors.form.note",
  "inside",
  "insideUnknown",
  "insideTooDeep",
  "goalNameRepeated",
  "goalNote",
];

test("every correction code has its said, proposed and why, each a message", () => {
  assert.deepEqual(Object.keys(correctionKeys).sort(), [...CORRECTIONS].sort());
  for (const [code, keys] of Object.entries(correctionKeys)) {
    assert.deepEqual(Object.keys(keys).sort(), ["proposed", "said", "why"], code);
    for (const key of Object.values(keys)) assert.equal(typeof leaf(key), "string", `${code}: ${key}`);
  }
});

test("the weekly rule notice, the four out reasons and the two declines each have a message", () => {
  assert.deepEqual(Object.keys(noticeKey), ["weekRuleBroken", "rhythmWithoutTasks"]);
  assert.deepEqual(Object.keys(outKey).sort(), ["noteFull", "notPlaced", "refused", "unmarked"].sort());
  assert.deepEqual(Object.keys(declinedKeys).sort(), ["keepsPlan", "leavesOut"]);
  for (const key of [...Object.values(noticeKey), ...Object.values(outKey), ...Object.values(declinedKeys)]) {
    assert.equal(typeof leaf(key), "string", key);
  }
});

test("every form code, the bare ones of the second template included, has a message", () => {
  assert.deepEqual(Object.keys(formKey).sort(), [...FORMS].sort());
  for (const [code, key] of Object.entries(formKey)) {
    assert.equal(typeof leaf(key), "string", `${code}: ${key}`);
    if (code.startsWith("import.")) assert.equal(key, code, "a catalogue key names itself");
  }
});

test("the four remapped refusal ids name a refusal sentence of the review", () => {
  assert.deepEqual(Object.keys(remapped).sort(), [
    "import.errors.amountNoMeasure",
    "import.errors.monthAfterEnd",
    "import.errors.monthBeforeStart",
    "import.errors.quantityNoMeasure",
  ]);
  for (const key of Object.values(remapped)) assert.equal(typeof leaf(key), "string", key);
});

test("the bare form codes say their rule in a sentence", () => {
  assert.match(leaf(formKey.inside)!, /dentro de/);
  assert.match(leaf(formKey.goalNameRepeated)!, /mismo nombre/);
});

test("903: each out reason and each form code names its own sentence, none another's", () => {
  assert.deepEqual(outKey, {
    notPlaced: "import.review.out.notPlaced",
    unmarked: "import.review.out.unmarked",
    refused: "import.review.out.refused",
    noteFull: "import.review.out.noteFull",
  });
  assert.equal(formKey.goalNote, "import.errors.form.goalNote");
  assert.equal(formKey.insideTooDeep, "import.errors.form.insideTooDeep");
  assert.equal(formKey.insideUnknown, "import.errors.form.insideUnknown");
  assert.equal(formKey.inside, "import.errors.form.inside");
  assert.equal(formKey.goalNameRepeated, "import.errors.form.goalNameRepeated");
});
