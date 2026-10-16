// RNL-02: one clock for "how long ago", so the last sync and "last seen"
// never disagree on the same fact. Words belong to the catalogue, not here.
export type Elapsed =
  | { unit: "moment" }
  | { unit: "minute" | "hour" | "day"; value: number };

export function elapsed(fromMs: number, nowMs: number): Elapsed {
  const seconds = (nowMs - fromMs) / 1000;
  if (seconds < 60) return { unit: "moment" };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { unit: "minute", value: minutes };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { unit: "hour", value: hours };
  return { unit: "day", value: Math.round(hours / 24) };
}
