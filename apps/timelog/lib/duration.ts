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

// A heatmap cell on one line, wide and narrow: «4 h 43» or «57 min» where there is room, «4h» or «57m» where there is not.
export function heatFigure(seconds: number, words: DurationWords, tiny: { hours: string; minutes: string }): { wide: string; narrow: string } {
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return { wide: words.underMinute, narrow: `<1${tiny.minutes}` };
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return { wide: `${rest} ${words.minutes}`, narrow: `${rest}${tiny.minutes}` };
  return { wide: rest === 0 ? `${hours} ${words.hours}` : `${hours} ${words.hours} ${String(rest).padStart(2, "0")}`, narrow: `${hours}${tiny.hours}` };
}
