import { civilDateInZone } from "@/lib/zone";
import type { Cadence, DayView, WeekView } from "@/lib/day/types";

// What `tallyDays` reads of `loadWeek`'s answer, spelled structurally so this
// file stays pure and DB-free.
type TallyInput = {
  view: WeekView;
  goals: { id: string; horizon: string | null; createdAt: string }[];
  commitments: { id: string; goalId: string | null; cadence?: Cadence }[];
};

export type DayTally = { day: string; done: number; total: number; partial: number };

type OpenGoal = { id: string; openedOn: string; horizon: string | null };

// One day's tally: the commitment slots of goals open that day
// (`openedOn <= d < horizon`), flexible and evidence rows included. One-off
// facts never count here. `partial` counts the partial slots among those; they
// never add to `done`. Hoy and the Semana both count through here, so they
// never disagree.
export function tallyDay(input: {
  view: DayView;
  goals: OpenGoal[];
  commitments: { id: string; goalId: string | null; cadence?: Cadence }[];
}): DayTally {
  const { view } = input;
  const goalOf = new Map(input.commitments.map((c) => [c.id, c.goalId]));
  const goals = new Map(input.goals.map((g) => [g.id, g]));
  const openOn = (goalId: string): boolean => {
    const goal = goals.get(goalId);
    return goal !== undefined && goal.openedOn <= view.day && (goal.horizon === null || view.day < goal.horizon);
  };

  const slots = view.slots.filter((slot) => {
    const goalId = goalOf.get(slot.commitmentId);
    // A habit with no goal (RP-100) counts every day it has a slot.
    if (goalId === null) return true;
    return goalId !== undefined && openOn(goalId);
  });
  return {
    day: view.day,
    done: slots.filter((slot) => slot.satisfied).length,
    total: slots.length,
    partial: slots.filter((slot) => slot.partial).length,
  };
}

// Per day of the week. An archived goal never reaches `goals`, so it counts
// nowhere.
export function tallyDays(week: TallyInput): DayTally[] {
  const goals = week.goals.map((g) => ({
    id: g.id,
    openedOn: civilDateInZone(new Date(g.createdAt)),
    horizon: g.horizon,
  }));
  return week.view.days.map((view) =>
    tallyDay({ view, goals, commitments: week.commitments }),
  );
}
