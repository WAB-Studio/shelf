import type { ReviewWeek } from "@/lib/day/types";
import type { Level } from "@/lib/goals/tree";
import type { MonthRow } from "@/lib/plan/months";

export type CarriedReport = {
  name: string;
  note: string | null;
  from: string;
  owes: number;
  hasAmount: boolean;
  children: { name: string; note: string | null; owes: number; hasAmount: boolean }[];
};

export type ReportTask = {
  name: string;
  from: string | null;
  done: boolean;
  doneOn: string | null;
  estimate: number | null;
  // The share of the estimate that falls in this month; null when the task
  // does not split across months or carries no amount.
  part: number | null;
  continuesIn: string | null;
  owes: number;
  hasAmount: boolean;
  note: string | null;
  children: { name: string; done: boolean; doneOn: string | null; estimate: number | null; note: string | null }[];
};

export type WeekSplit = { index: number; month: string; startsOn: string; endsOn: string; total: number };

export type GoalReport = {
  id: string;
  name: string;
  horizon: string | null;
  endedOn: string | null;
  unit: string | null;
  // The word the person gave the measure; «mide {measureName}» reads it, never the unit.
  measureName: string | null;
  // The goal's own note, printed whole on paper (RP-84).
  note?: string | null;
  // A source feeds the measure (RP-14): an evidence commitment in the goal's unit.
  measureFed: boolean;
  // The goal's own monthly rhythm; null for a goal with none and for one that holds goals (RP-80).
  rhythm: number | null;
  thisMonth: { planned: number | null; reached: number; underPace: boolean };
  toDate: { planned: number; reached: number };
  // Months whose amount the person typed: paper prints every planned 0, the screen only these (RP-76).
  ownMonths?: string[];
  phases: { aim: string; startsOn: string; endsOn: string; current: boolean }[];
  tasks: ReportTask[];
  carried: CarriedReport[];
  // `tasks` is read for a goal that measures nothing: the months it prints on paper are its tasks' (RP-71).
  months: (MonthRow & { carried: number | null; endless?: true; tasks?: { done: number; total: number } })[];
  weeks: ReviewWeek[];
  // The current week's planned minutes (RP-58); null when it has no amount.
  weekPlanned?: number | null;
  // A week crossing two months, cut at the month's edge: each part holds the
  // week's days that fall in `month` (the first of it), so a month's parts add up to it.
  weekSplits: WeekSplit[];
  // The tree's place (RP-84); absent on a hand-built report, where each goal stands alone.
  parentId?: string | null;
  level?: Level | null;
  rootId?: string;
  rootName?: string;
  // The goal above, for «de X».
  aboveName?: string | null;
  holdsGoals?: boolean;
  // Goals under it that measure in another unit and add nothing to its figures.
  outOfUnit?: { id: string; name: string; unit: string }[];
};

export type Report = {
  today: string;
  evidence: "read" | "unreadable";
  // In the tree's order: each goal after the one above it.
  goals: GoalReport[];
  // One entry per general (or lone goal), `goalIds` in preorder.
  groups?: { rootId: string; goalIds: string[] }[];
};
