export type DurationWords = { hours: string; minutes: string; underMinute: string };

// «3 h 12 min», «45 min», «2 h», «< 1 min» (docs/timelog/DESIGN.md): whole minutes, never rounded up.
export function formatDuration(seconds: number, words: DurationWords): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return words.underMinute;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} ${words.minutes}`;
  return rest === 0 ? `${hours} ${words.hours}` : `${hours} ${words.hours} ${rest} ${words.minutes}`;
}

// The same time as figure and unit pairs, for a figure set big: [3 «h»] [12 «min»]. Under a minute is «< 1» «min».
export function durationParts(seconds: number, words: DurationWords): { value: string; unit: string }[] {
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return [{ value: "< 1", unit: words.minutes }];
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return [{ value: String(rest), unit: words.minutes }];
  return rest === 0
    ? [{ value: String(hours), unit: words.hours }]
    : [
        { value: String(hours), unit: words.hours },
        { value: String(rest), unit: words.minutes },
      ];
}

// «12 h», «45 min», «< 1 min»: the largest unit alone, for a column too narrow for both. Floored, never rounded up.
export function briefDuration(seconds: number, words: DurationWords): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return words.underMinute;
  return minutes < 60 ? `${minutes} ${words.minutes}` : `${Math.floor(minutes / 60)} ${words.hours}`;
}
