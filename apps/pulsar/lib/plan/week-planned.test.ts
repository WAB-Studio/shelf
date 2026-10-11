import assert from "node:assert/strict";
import { test } from "node:test";

import { weekPlanned } from "@/lib/plan/week-planned";

// RP-58: the month's planned amount spread evenly over the month's days,
// summed over the week's days inside the goal, in whole minutes.
// A horizon is the first day after the goal (`lib/day/weeks.ts`).

const FAR_PAST = "2026-01-01";
const FAR_FUTURE = "2027-01-01";

// Mon 5 Oct 2026 to Sun 11 Oct 2026: inside October (31 days).
const OCT_WEEK = { weekStart: "2026-10-05", weekEnd: "2026-10-11" };
// Mon 28 Sep 2026 to Sun 4 Oct 2026: 3 days of September (30), 4 of October (31).
const ACROSS_WEEK = { weekStart: "2026-09-28", weekEnd: "2026-10-04" };

test("prorate by day: 12 h in a 31-day month over a 7-day week is floor(7 × 720 / 31) = 162", () => {
  const planned = weekPlanned({
    ...OCT_WEEK,
    budgets: [{ month: "2026-10-01", amount: 720 }],
    openedOn: FAR_PAST,
    horizon: FAR_FUTURE,
  });
  assert.equal(planned, Math.floor((7 * 720) / 31));
  assert.equal(planned, 162);
});

test("prorate by day: a 30-day month divides by 30, not 31", () => {
  // Mon 14 Sep to Sun 20 Sep 2026, September 600 min / 30 d = 20 a day.
  const planned = weekPlanned({
    weekStart: "2026-09-14",
    weekEnd: "2026-09-20",
    budgets: [{ month: "2026-09-01", amount: 600 }],
    openedOn: FAR_PAST,
    horizon: FAR_FUTURE,
  });
  assert.equal(planned, 7 * 20);
});

test("prorate by day: February of a leap year divides by 29", () => {
  // Mon 10 Feb to Sun 16 Feb 2032, 580 min / 29 d = 20 a day.
  const planned = weekPlanned({
    weekStart: "2032-02-09",
    weekEnd: "2032-02-15",
    budgets: [{ month: "2032-02-01", amount: 580 }],
    openedOn: "2032-01-01",
    horizon: "2033-01-01",
  });
  assert.equal(planned, 7 * 20);
});

test("week across months: each part comes from its own month", () => {
  const planned = weekPlanned({
    ...ACROSS_WEEK,
    budgets: [
      { month: "2026-09-01", amount: 600 },
      { month: "2026-10-01", amount: 720 },
    ],
    openedOn: FAR_PAST,
    horizon: FAR_FUTURE,
  });
  // 3 September days at 600/30, 4 October days at 720/31.
  assert.equal(planned, Math.floor((3 * 600) / 30 + (4 * 720) / 31));
  assert.equal(planned, 152);
});

test("week across months: the parts are summed first and floored once", () => {
  // 3 × 605/30 = 60.5 and 4 × 720/31 = 92.90...: 153.40 floors to 153;
  // flooring each part first would give 60 + 92 = 152.
  const planned = weekPlanned({
    ...ACROSS_WEEK,
    budgets: [
      { month: "2026-09-01", amount: 605 },
      { month: "2026-10-01", amount: 720 },
    ],
    openedOn: FAR_PAST,
    horizon: FAR_FUTURE,
  });
  assert.equal(planned, Math.floor((3 * 605) / 30 + (4 * 720) / 31));
  assert.equal(planned, 153);
});

test("week across months: a month with no amount contributes 0, the other still counts", () => {
  const planned = weekPlanned({
    ...ACROSS_WEEK,
    budgets: [{ month: "2026-10-01", amount: 720 }],
    openedOn: FAR_PAST,
    horizon: FAR_FUTURE,
  });
  assert.equal(planned, Math.floor((4 * 720) / 31));
});

test("days outside the goal: a goal opened on Thursday counts Thursday to Sunday only", () => {
  const planned = weekPlanned({
    ...OCT_WEEK,
    budgets: [{ month: "2026-10-01", amount: 720 }],
    openedOn: "2026-10-08",
    horizon: FAR_FUTURE,
  });
  assert.equal(planned, Math.floor((4 * 720) / 31));
});

test("days outside the goal: a goal ending Tuesday counts Monday and Tuesday only", () => {
  // The horizon is the first day after the goal: Wednesday 7 Oct.
  const planned = weekPlanned({
    ...OCT_WEEK,
    budgets: [{ month: "2026-10-01", amount: 720 }],
    openedOn: FAR_PAST,
    horizon: "2026-10-07",
  });
  assert.equal(planned, Math.floor((2 * 720) / 31));
});

test("days outside the goal: opened Tuesday and ending Thursday counts Tuesday to Thursday", () => {
  const planned = weekPlanned({
    ...OCT_WEEK,
    budgets: [{ month: "2026-10-01", amount: 720 }],
    openedOn: "2026-10-06",
    horizon: "2026-10-09",
  });
  assert.equal(planned, Math.floor((3 * 720) / 31));
});

test("days outside the goal: a week wholly before the opening or from the horizon on is null", () => {
  const budgets = [{ month: "2026-10-01", amount: 720 }];
  assert.equal(weekPlanned({ ...OCT_WEEK, budgets, openedOn: "2026-10-12", horizon: FAR_FUTURE }), null);
  assert.equal(weekPlanned({ ...OCT_WEEK, budgets, openedOn: FAR_PAST, horizon: "2026-10-05" }), null);
});

test("no amount: no budgets is null, not 0", () => {
  assert.equal(
    weekPlanned({ ...OCT_WEEK, budgets: [], openedOn: FAR_PAST, horizon: FAR_FUTURE }),
    null,
  );
});

test("no amount: an amount of 0 in every month of the week is null, not 0", () => {
  assert.equal(
    weekPlanned({
      ...ACROSS_WEEK,
      budgets: [
        { month: "2026-09-01", amount: 0 },
        { month: "2026-10-01", amount: 0 },
      ],
      openedOn: FAR_PAST,
      horizon: FAR_FUTURE,
    }),
    null,
  );
});

test("no amount: an amount only in a month the week does not touch is null", () => {
  assert.equal(
    weekPlanned({
      ...OCT_WEEK,
      budgets: [{ month: "2026-09-01", amount: 600 }],
      openedOn: FAR_PAST,
      horizon: FAR_FUTURE,
    }),
    null,
  );
});

test("integer: every result over odd amounts and every month length is a whole number", () => {
  const weeks = [
    ["2026-09-28", "2026-10-04"],
    ["2026-10-05", "2026-10-11"],
    ["2026-02-23", "2026-03-01"],
    ["2032-02-23", "2032-02-29"],
  ] as const;
  for (const [weekStart, weekEnd] of weeks) {
    for (const amount of [1, 7, 13, 100, 333, 719, 721, 9999]) {
      const budgets = ["2026-02-01", "2026-03-01", "2026-09-01", "2026-10-01", "2032-02-01"].map(
        (month) => ({ month, amount }),
      );
      const planned = weekPlanned({ weekStart, weekEnd, budgets, openedOn: "2026-01-01", horizon: "2033-01-01" });
      assert.ok(planned !== null && Number.isInteger(planned), `${weekStart} ${amount}: ${planned}`);
    }
  }
});

test("a leap February at one minute a day plans exactly seven minutes for a week", () => {
  const leap = weekPlanned({
    weekStart: "2028-02-07",
    weekEnd: "2028-02-13",
    budgets: [{ month: "2028-02-01", amount: 29 }],
    openedOn: "2028-01-01",
    horizon: "2028-12-31",
  });
  assert.equal(leap, 7);
});

test("a week over two 31-day months sums to the exact whole minute, not one short", () => {
  // 5 days of July at 1 min / 31 d plus 2 days of August at 13 min / 31 d is exactly 1.
  const fiveAndTwo = weekPlanned({
    weekStart: "2026-07-27",
    weekEnd: "2026-08-02",
    budgets: [
      { month: "2026-07-01", amount: 1 },
      { month: "2026-08-01", amount: 13 },
    ],
    openedOn: FAR_PAST,
    horizon: FAR_FUTURE,
  });
  assert.equal(fiveAndTwo, 1);
  // 3 days of July at 3 min plus 4 of August at 21 is exactly 3.
  const threeAndFour = weekPlanned({
    weekStart: "2026-07-29",
    weekEnd: "2026-08-04",
    budgets: [
      { month: "2026-07-01", amount: 3 },
      { month: "2026-08-01", amount: 21 },
    ],
    openedOn: FAR_PAST,
    horizon: FAR_FUTURE,
  });
  assert.equal(threeAndFour, 3);
});

// RP-58: a month with no amount of its own takes the goal's rhythm.

test("rhythm: a month with no amount takes the rhythm, 720 over a 31-day week is 162", () => {
  const planned = weekPlanned({
    ...OCT_WEEK,
    budgets: [],
    rhythm: 720,
    openedOn: FAR_PAST,
    horizon: FAR_FUTURE,
  });
  assert.equal(planned, 162);
});

test("rhythm: a month's own amount wins over the rhythm", () => {
  const planned = weekPlanned({
    ...OCT_WEEK,
    budgets: [{ month: "2026-10-01", amount: 600 }],
    rhythm: 720,
    openedOn: FAR_PAST,
    horizon: FAR_FUTURE,
  });
  assert.equal(planned, Math.floor((7 * 600) / 31));
  assert.equal(planned, 135);
});

test("rhythm: across two months the rhythm fills the one with no amount, the amount the other", () => {
  const planned = weekPlanned({
    ...ACROSS_WEEK,
    budgets: [{ month: "2026-10-01", amount: 600 }],
    rhythm: 720,
    openedOn: FAR_PAST,
    horizon: FAR_FUTURE,
  });
  // 3 September days at 720/30, 4 October days at 600/31.
  assert.equal(planned, Math.floor((3 * 720) / 30 + (4 * 600) / 31));
  assert.equal(planned, 149);
});

test("rhythm: neither an amount nor a rhythm is null", () => {
  assert.equal(
    weekPlanned({ ...OCT_WEEK, budgets: [], rhythm: null, openedOn: FAR_PAST, horizon: FAR_FUTURE }),
    null,
  );
});

test("rhythm: a rhythm of 0 is null, not 0", () => {
  assert.equal(
    weekPlanned({ ...OCT_WEEK, budgets: [], rhythm: 0, openedOn: FAR_PAST, horizon: FAR_FUTURE }),
    null,
  );
});

test("rhythm: days before the opening or from the horizon on take no rhythm", () => {
  const base = { ...OCT_WEEK, budgets: [], rhythm: 720 };
  assert.equal(weekPlanned({ ...base, openedOn: "2026-10-08", horizon: FAR_FUTURE }), Math.floor((4 * 720) / 31));
  assert.equal(weekPlanned({ ...base, openedOn: FAR_PAST, horizon: "2026-10-07" }), Math.floor((2 * 720) / 31));
  assert.equal(weekPlanned({ ...base, openedOn: "2026-10-12", horizon: FAR_FUTURE }), null);
});
