import { civilDateToDate } from "@/lib/dates";

// What the month's budget leaves, for the widget (RF-215): the remainder (negative once passed), the days left
// counting `today`, and the remainder spread over them, floored and never below zero. Integer cents throughout.
export type MonthLeft = { remainingCents: number; daysLeft: number; perDayCents: number };

/** `today` is a Bogota civil date, the dashboard's own clock; a month with no budget leaves a zero per day. */
export function monthLeft(spentCents: number, budgetedCents: number, today: string): MonthLeft {
  const date = civilDateToDate(today);
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeft = daysInMonth - date.getUTCDate() + 1;
  const remainingCents = budgetedCents - spentCents;

  return {
    remainingCents,
    daysLeft,
    perDayCents: budgetedCents > 0 ? Math.max(0, Math.floor(remainingCents / daysLeft)) : 0,
  };
}
