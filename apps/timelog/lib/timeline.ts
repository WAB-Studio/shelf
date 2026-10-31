import { addDays, dayStart, TIME_ZONE } from "@/lib/zone";

export type TimedSession = { key: string; label: string; first: Date; last: Date };

// A session as a stretch of the day's line: `left` and `width` are shares of the line (as drawn, with the minimum
// width), `lane` the row it sits on, `from` and `to` its minutes inside the day. `first` and `last` stay the session's
// own instants, for the clock a person reads.
export type Segment = { key: string; label: string; left: number; width: number; lane: number; from: number; to: number; first: Date; last: Date };

export type Layout = { startHour: number; lanes: number; segments: Segment[] };

const DAY_START_HOUR = 6;
const DAY_MINUTES = 1440;
// A session shorter than this still leaves a mark you can read and press.
const MIN_SHARE = 0.012;

const CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// Minutes since midnight on Bogotá's clock.
export function minuteOfDay(at: Date): number {
  const parts = CLOCK.formatToParts(at);
  const part = (type: string) => Number(parts.find((one) => one.type === type)?.value ?? 0);
  return part("hour") * 60 + part("minute");
}

// The line of civil day `day` runs from 6:00 to 24:00; a session that began earlier pulls its start back to the hour it
// began in. A session that crosses midnight is cut at the day's bounds, one wholly outside it is left out. Sessions
// that overlap as drawn take separate lanes, the earliest on the top one.
export function layoutSessions(sessions: TimedSession[], day: string): Layout {
  const begin = dayStart(day).getTime();
  const end = dayStart(addDays(day, 1)).getTime();
  const timed = sessions
    .filter((one) => one.last.getTime() >= begin && one.first.getTime() < end && one.last.getTime() >= one.first.getTime())
    .map((one) => ({
      ...one,
      from: (Math.max(one.first.getTime(), begin) - begin) / 60_000,
      to: (Math.min(one.last.getTime(), end) - begin) / 60_000,
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const startHour = Math.min(DAY_START_HOUR, ...timed.map((one) => Math.floor(one.from / 60)));
  const start = startHour * 60;
  const span = DAY_MINUTES - start;
  const laneEnds: number[] = [];
  const segments = timed.map((one) => {
    const left = (one.from - start) / span;
    const width = Math.min(1 - left, Math.max(MIN_SHARE, (one.to - one.from) / span));
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= left);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = left + width;
    return { key: one.key, label: one.label, left, width, lane, from: one.from, to: one.to, first: one.first, last: one.last };
  });
  return { startHour, lanes: Math.max(1, laneEnds.length), segments };
}

// Where the line opens: the share of its length to bring to the middle of the screen. Today, the hour it is now;
// another day, the start of its first session.
export function focusShare(layout: Layout, nowMinute: number | null): number {
  const start = layout.startHour * 60;
  const minute = nowMinute ?? layout.segments[0]?.from ?? start;
  return Math.max(0, Math.min(1, (minute - start) / (DAY_MINUTES - start)));
}

// Hour marks every three hours from the line's start: «6:00», «9:00», … «24:00» shown as «0:00».
export function hourMarks(startHour: number): { hour: number; left: number }[] {
  const marks: { hour: number; left: number }[] = [];
  for (let hour = Math.ceil(startHour / 3) * 3; hour <= 24; hour += 3) marks.push({ hour, left: (hour - startHour) / (24 - startHour) });
  return marks;
}
