import { daysBetween } from "@/lib/day/weeks";

export type TimelineSegment = {
  id: string;
  name: string;
  // Percent of the track, from its start.
  left: number;
  width: number;
  state: "past" | "current" | "coming";
};

export type Timeline = {
  segments: TimelineSegment[];
  // Where «hoy» stands, or null before the goal opened or after it ended.
  today: number | null;
  // The share of the span already lived, 0 to 100.
  lived: number;
};

const clamp = (value: number) => Math.min(100, Math.max(0, value));

// A goal's span, from the day it opened to its horizon, as percentages of one track: each phase a segment and
// «hoy» a mark. A goal with no end has no span to draw, so no timeline.
export function timeline(input: {
  openedOn: string;
  horizon: string | null;
  today: string;
  phases: readonly { id: string; name: string; startsOn: string; endsOn: string }[];
}): Timeline | null {
  const { openedOn, horizon, today, phases } = input;
  if (horizon === null) return null;
  const span = daysBetween(openedOn, horizon);
  if (span <= 0) return null;
  const at = (day: string) => clamp((daysBetween(openedOn, day) * 100) / span);
  const segments = phases.map((phase) => {
    const left = at(phase.startsOn);
    // A phase ends at the close of its last day.
    const right = at(phase.endsOn) + 100 / span;
    return {
      id: phase.id,
      name: phase.name,
      left,
      width: Math.max(0, Math.min(100, right) - left),
      state: today > phase.endsOn ? ("past" as const) : today >= phase.startsOn ? ("current" as const) : ("coming" as const),
    };
  });
  return {
    segments: segments.sort((a, b) => a.left - b.left),
    today: today < openedOn || today >= horizon ? null : at(today),
    lived: at(today),
  };
}
