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
