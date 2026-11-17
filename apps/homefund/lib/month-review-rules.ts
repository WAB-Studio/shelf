// RF-155's four fixed rules, as `transaction_reviews.rule` stores them (migration 0072).
export const REVIEW_RULES = ["above_usual", "twin", "from_words", "reconciliation_gap"] as const;
export type ReviewRule = (typeof REVIEW_RULES)[number];

// «Above usual» compares a movement with the ones before it in this many months.
export const USUAL_WINDOW_MONTHS = 6;

// `spending_patterns` (RF-184) still reads a category's lines: over this many times their median, once
// the median rests on this many lines.
export const ABOVE_USUAL_FACTOR = 3;
export const USUAL_MIN_LINES = 3;

// «Revisar el mes» compares whole movements (RF-239): first with the earlier ones that carry the same
// description, once there are this many; else with the earlier ones of the same category, once there are this many.
export const USUAL_MIN_SAME_DESCRIPTION = 4;
export const USUAL_MIN_SAME_CATEGORY = 8;

// A movement stands out when it is over this percent of the 90th percentile of that history and at least
// this many times its median: in the biggest tenth of what the person paid before, and clearly more.
export const ABOVE_USUAL_P90_PERCENT = 150;
export const ABOVE_USUAL_MEDIAN_FACTOR = 2;

// Below this amount (minor units) nothing stands out, whatever it is compared with; a currency not listed uses COP's.
export const USUAL_MIN_CENTS: Record<string, number> = { COP: 5_000_000, USD: 1_500 };

// What a review item says it was compared with: the earlier movements of its description, or of its category.
export const USUAL_BASES = ["description", "category"] as const;
export type UsualBasis = (typeof USUAL_BASES)[number];
