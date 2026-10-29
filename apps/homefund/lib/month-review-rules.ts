// RF-155's four fixed rules, as `transaction_reviews.rule` stores them (migration 0072).
export const REVIEW_RULES = ["above_usual", "twin", "from_words", "reconciliation_gap"] as const;
export type ReviewRule = (typeof REVIEW_RULES)[number];
