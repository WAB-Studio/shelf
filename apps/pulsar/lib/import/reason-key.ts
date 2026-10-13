import type { MessageKey } from "@/i18n/translator";

import type { CorrectionCode, Correction, NoticeCode } from "./draft";
import type { OutReason } from "./coverage";
import type { FormCode } from "./template";

// Each code the importer returns names its sentence here. A code added without words does not compile.
// The sentences take the arguments the review has for the part: `{name}`, `{said}`, `{proposed}`, and the
// ones in the correction's `values`, formatted by the screen.

export const correctionKeys = {
  nameShortened: sentence("nameShortened"),
  parentEstimateDropped: sentence("parentEstimateDropped"),
  parentEstimateDiffers: sentence("parentEstimateDiffers"),
  cadenceClamped: sentence("cadenceClamped"),
  cadenceToWeekdays: sentence("cadenceToWeekdays"),
  rateToRhythm: sentence("rateToRhythm"),
  holderRhythmToNote: sentence("holderRhythmToNote"),
  holderMonthsToNote: sentence("holderMonthsToNote"),
  endWithinAbove: sentence("endWithinAbove"),
  measureInHours: sentence("measureInHours"),
  monthSumDiffers: sentence("monthSumDiffers"),
  monthOverRhythm: sentence("monthOverRhythm"),
} satisfies Record<CorrectionCode, { said: MessageKey; proposed: MessageKey; why: MessageKey }>;

function sentence<C extends CorrectionCode>(code: C) {
  return {
    said: `import.review.correction.${code}.said`,
    proposed: `import.review.correction.${code}.proposed`,
    why: `import.review.correction.${code}.why`,
  } as const;
}

export const noticeKey = {
  weekRuleBroken: "import.review.notice.weekRuleBroken",
} satisfies Record<NoticeCode, MessageKey>;

export const outKey = {
  notPlaced: "import.review.out.notPlaced",
  unmarked: "import.review.out.unmarked",
  refused: "import.review.out.refused",
  noteFull: "import.review.out.noteFull",
} satisfies Record<OutReason, MessageKey>;

// What declining a correction does; the sentence of `leavesOut` takes `{code}`.
export const declinedKeys = {
  keepsPlan: "import.review.correction.keepsPlan",
  leavesOut: "import.review.correction.leavesOut",
} satisfies Record<Correction["declined"], MessageKey>;

// The 22 forms of the first template are catalogue keys already; the five of the second are bare codes.
export const formKey = {
  "import.errors.form.goal": "import.errors.form.goal",
  "import.errors.form.goalLong": "import.errors.form.goalLong",
  "import.errors.form.horizon": "import.errors.form.horizon",
  "import.errors.form.measure": "import.errors.form.measure",
  "import.errors.form.rhythmPlace": "import.errors.form.rhythmPlace",
  "import.errors.form.rhythmUnit": "import.errors.form.rhythmUnit",
  "import.errors.form.rhythmAmount": "import.errors.form.rhythmAmount",
  "import.errors.form.firstLine": "import.errors.form.firstLine",
  "import.errors.form.section": "import.errors.form.section",
  "import.errors.form.phase": "import.errors.form.phase",
  "import.errors.form.month": "import.errors.form.month",
  "import.errors.form.monthReal": "import.errors.form.monthReal",
  "import.errors.form.monthUnit": "import.errors.form.monthUnit",
  "import.errors.form.monthTime": "import.errors.form.monthTime",
  "import.errors.form.monthWhole": "import.errors.form.monthWhole",
  "import.errors.form.commitment": "import.errors.form.commitment",
  "import.errors.form.commitmentUnit": "import.errors.form.commitmentUnit",
  "import.errors.form.commitmentTime": "import.errors.form.commitmentTime",
  "import.errors.estimateNotTime": "import.errors.estimateNotTime",
  "import.errors.form.task": "import.errors.form.task",
  "import.errors.form.child": "import.errors.form.child",
  "import.errors.form.note": "import.errors.form.note",
  inside: "import.errors.form.inside",
  insideUnknown: "import.errors.form.insideUnknown",
  insideTooDeep: "import.errors.form.insideTooDeep",
  goalNameRepeated: "import.errors.form.goalNameRepeated",
  goalNote: "import.errors.form.goalNote",
} satisfies Record<FormCode, MessageKey>;

// Refusal ids the draft carries, not catalogue keys: each names the review's own sentence.
export const remapped = {
  "import.errors.monthBeforeStart": "import.review.blocked.monthBeforeStart",
  "import.errors.monthAfterEnd": "import.review.blocked.monthAfterEnd",
  "import.errors.amountNoMeasure": "import.review.blocked.amountNoMeasure",
  "import.errors.quantityNoMeasure": "import.review.blocked.quantityNoMeasure",
} satisfies Record<string, MessageKey>;
