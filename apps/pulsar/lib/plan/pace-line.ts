interface PaceLineInput {
  planned: number | null;
  underPace: boolean;
  unreadable: boolean;
  ended: boolean;
}

// An ended goal has no running month to pace; underPace already holds the 20th and 60 % rule.
export function showsPaceLine({ planned, underPace, unreadable, ended }: PaceLineInput): boolean {
  return !ended && planned !== null && planned > 0 && underPace && !unreadable;
}
