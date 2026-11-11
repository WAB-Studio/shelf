// RF-155's four fixed rules, as `transaction_reviews.rule` stores them (migration 0072).
export const REVIEW_RULES = ["above_usual", "twin", "from_words", "reconciliation_gap"] as const;
export type ReviewRule = (typeof REVIEW_RULES)[number];

// «Above usual» compares a movement with the median of its category's lines in this many months before it.
export const USUAL_WINDOW_MONTHS = 6;

// It stands out over this many times that median, once the median rests on this many lines.
export const ABOVE_USUAL_FACTOR = 3;
export const USUAL_MIN_LINES = 3;
