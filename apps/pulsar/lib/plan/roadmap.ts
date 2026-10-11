import { daysBetween, dayBefore } from "@/lib/day/weeks";
import { monthOfTask, type Task } from "./carry";
import { monthOf, nextMonth, plannedOf, type MonthBudget } from "./months";

export type PlanTask = Task & {
  inPlan: boolean;
  createdOn: string;
  position: number;
};

export type PlanInput = {
  rhythm: number | null;
  budgets: MonthBudget[];
  tasks: PlanTask[];
  openedOn: string;
  horizon: string;
  today: string;
  doneBy?: string;
};

export type PlanItem = {
  task: PlanTask;
  children: PlanTask[];
  hours: number;
  part: number;
  from: string | null;
  to: string | null;
  fixed: boolean;
  carriedFrom: string | null;
  done: boolean;
  endsOn: string | null;
  pastEnd: boolean;
};

export type PlanMonth = { month: string; amount: number | null; filled: number; items: PlanItem[] };

export type Roadmap = {
  state: "noRhythm" | "planned" | "empty";
  months: PlanMonth[];
  unplaced: PlanItem[];
  end: string | null;
  lastDay: string;
};

// Filling stops this many months past the current one.
const WINDOW = 120;

// The month's planned amount (RP-74); past the goal's last month the plan
// still projects, at the whole rhythm.
export function amountOf(
  month: string,
  input: Pick<PlanInput, "budgets" | "rhythm" | "openedOn" | "horizon">,
): number | null {
  if (month > monthOf(dayBefore(input.horizon))) {
    return input.budgets.find((budget) => budget.month === month)?.amount ?? input.rhythm ?? null;
  }
  return plannedOf(month, input);
}

type Entry = {
  task: PlanTask;
  children: PlanTask[];
  hours: number;
  done: boolean;
  doneOn: string | null;
  fixedMonth: string | null;
};

type Placed = { month: string; part: number; endsOn: string | null };

// The last day of a task's children, once all are done; a leaf's own.
export function doneDayOf(task: PlanTask, children: PlanTask[]): string | null {
  if (children.length === 0) return task.doneOn;
  let last: string | null = null;
  for (const child of children) {
    if (child.doneOn === null) return null;
    if (last === null || child.doneOn > last) last = child.doneOn;
  }
  return last;
}

function sum(tasks: PlanTask[]): number {
  return tasks.reduce((total, task) => total + (task.estimate ?? 0), 0);
}

// The days of `month` its amount spreads over: the goal's own in it, or the
// whole month outside the goal.
function spanOf(month: string, openedOn: string, lastDay: string): [number, number] {
  const days = daysBetween(month, nextMonth(month));
  if (month > lastDay || monthOf(openedOn) > month) return [1, days];
  const first = monthOf(openedOn) === month ? Number(openedOn.slice(8, 10)) : 1;
  const last = monthOf(lastDay) === month ? Number(lastDay.slice(8, 10)) : days;
  return [first, last];
}

// The day `filled` of `amount` reaches through the month's span, integers only.
function endDay(month: string, filled: number, amount: number, [first, last]: [number, number]): string {
  const days = last - first + 1;
  const day =
    amount <= 0 ? last : first - 1 + Math.min(days, Math.max(1, Math.floor((days * filled + amount - 1) / amount)));
  return `${month.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

function toItem(
  entry: Entry,
  placed: Placed[],
  index: number,
  carriedFrom: string | null,
  pastEnd: boolean,
): PlanItem {
  return {
    task: entry.task,
    children: entry.children,
    hours: entry.hours,
    part: placed[index].part,
    from: index > 0 ? placed[index - 1].month : null,
    to: index < placed.length - 1 ? placed[index + 1].month : null,
    fixed: entry.fixedMonth !== null,
    carriedFrom,
    done: entry.done,
    endsOn: placed[placed.length - 1].endsOn,
    pastEnd,
  };
}

export function fillPlan(input: PlanInput): Roadmap {
  const { today, horizon } = input;
  const doneBy = input.doneBy ?? today;
  const current = monthOf(today);
  const lastDay = dayBefore(horizon);
  const amounts = (month: string) => amountOf(month, input);

  // What the reading day sees: nothing created later, nothing done later. A task fixed to
  // a month (or a child of one) belongs to that month whenever it was created.
  const fixedIds = new Set(input.tasks.filter((task) => task.parentId === null && monthOfTask(task) !== null).map((task) => task.id));
  const visible = input.tasks
    .filter((task) => task.createdOn <= today || fixedIds.has(task.parentId ?? task.id))
    .map((task) => (task.doneOn !== null && task.doneOn > doneBy ? { ...task, doneOn: null } : task));

  const roomTaken = new Map<string, number>();
  const take = (month: string, hours: number) => roomTaken.set(month, (roomTaken.get(month) ?? 0) + hours);

  const entries: Entry[] = [];
  for (const task of visible) {
    if (task.parentId !== null) continue;
    if (!task.inPlan && task.day === null && task.plannedMonth === null) continue;
    const children = visible.filter((other) => other.parentId === task.id);
    const doneOn = doneDayOf(task, children);
    const done = doneOn !== null;
    const hours = done
      ? children.length === 0
        ? (task.estimate ?? 0)
        : sum(children)
      : children.length === 0
        ? (task.estimate ?? 0)
        : sum(children.filter((child) => child.doneOn === null));
    entries.push({ task, children, hours, done, doneOn, fixedMonth: monthOfTask(task) });
    // Work done inside an undone parent still spent its own month.
    if (!done) {
      for (const child of children) {
        if (child.doneOn !== null && monthOf(child.doneOn) === current) take(current, child.estimate ?? 0);
      }
    }
  }
  entries.sort((a, b) => a.task.position - b.task.position);

  type Row = { month: string; item: PlanItem; carried: boolean };
  const rows: Row[] = [];
  const unplaced: PlanItem[] = [];
  const ends: string[] = [];
  const endOf = (month: string, filled: number) =>
    endDay(month, filled, amounts(month) ?? 0, spanOf(month, input.openedOn, lastDay));
  const pastEndOf = (day: string | null) => day !== null && day > lastDay;

  // Done items sit whole in their fixed month, else in their done day's month.
  for (const entry of entries) {
    if (!entry.done) continue;
    const doneMonth = monthOf(entry.doneOn ?? today);
    // A task fixed to an earlier month and done later sits where it was done, carried from its own.
    const carriedFrom = entry.fixedMonth !== null && entry.fixedMonth < doneMonth ? entry.fixedMonth : null;
    const month = carriedFrom !== null ? doneMonth : (entry.fixedMonth ?? doneMonth);
    if (month < current) continue;
    if (month === current) take(month, entry.hours);
    rows.push({
      month,
      carried: carriedFrom !== null,
      item: toItem(entry, [{ month, part: entry.hours, endsOn: null }], 0, carriedFrom, false),
    });
  }

  // Undone fixed items sit whole in their month, a past one in the current.
  const undone = entries.filter((entry) => !entry.done);
  const running = new Map(roomTaken);
  for (const entry of undone) {
    if (entry.fixedMonth === null) continue;
    const carried = entry.fixedMonth < current;
    const month = carried ? current : entry.fixedMonth;
    take(month, entry.hours);
    running.set(month, (running.get(month) ?? 0) + entry.hours);
    const endsOn = endOf(month, running.get(month) ?? 0);
    ends.push(endsOn);
    rows.push({
      month,
      carried,
      item: toItem(entry, [{ month, part: entry.hours, endsOn }], 0, carried ? entry.fixedMonth : null, pastEndOf(endsOn)),
    });
  }

  // Unfixed items flow through the rooms, in position order.
  const months: string[] = [];
  for (let month = current, i = 0; i <= WINDOW; i += 1, month = nextMonth(month)) months.push(month);
  const roomOf = (index: number) =>
    Math.max(0, (amounts(months[index]) ?? 0) - (roomTaken.get(months[index]) ?? 0));
  let cursor = 0;
  let failed = input.rhythm === null;

  for (const entry of undone.filter((candidate) => candidate.fixedMonth === null)) {
    const loose = () => toItem(entry, [{ month: current, part: 0, endsOn: null }], 0, null, false);
    if (failed) {
      unplaced.push(loose());
      continue;
    }
    const taken: Placed[] = [];
    let left = entry.hours;
    let at = cursor;
    let ok = true;
    do {
      while (at < months.length && roomOf(at) === 0) at += 1;
      if (at >= months.length) {
        ok = false;
        break;
      }
      const month = months[at];
      const part = Math.min(roomOf(at), left);
      take(month, part);
      left -= part;
      taken.push({ month, part, endsOn: left === 0 ? endOf(month, roomTaken.get(month) ?? 0) : null });
    } while (left > 0);

    if (!ok) {
      for (const part of taken) take(part.month, -part.part);
      failed = true;
      unplaced.push(loose());
      continue;
    }
    cursor = at;
    const endsOn = taken[taken.length - 1].endsOn;
    if (endsOn !== null) ends.push(endsOn);
    const past = pastEndOf(endsOn);
    const finished = taken.map((part) => ({ ...part, endsOn }));
    finished.forEach((part, index) => {
      rows.push({ month: part.month, carried: false, item: toItem(entry, finished, index, null, past) });
    });
  }

  rows.sort((a, b) =>
    a.carried === b.carried ? a.item.task.position - b.item.task.position : a.carried ? -1 : 1,
  );

  let lastPartMonth: string | null = null;
  for (const row of rows) if (lastPartMonth === null || row.month > lastPartMonth) lastPartMonth = row.month;
  const planMonths: PlanMonth[] = [];
  if (lastPartMonth !== null) {
    for (let month = current; month <= lastPartMonth; month = nextMonth(month)) {
      planMonths.push({
        month,
        amount: amounts(month),
        filled: roomTaken.get(month) ?? 0,
        items: rows.filter((row) => row.month === month).map((row) => row.item),
      });
    }
  }

  const state = undone.length === 0 ? "empty" : input.rhythm === null ? "noRhythm" : "planned";
  const end = unplaced.length > 0 || ends.length === 0 ? null : ends.reduce((a, b) => (a > b ? a : b));
  return { state, months: planMonths, unplaced, end, lastDay };
}
