// RP-76: a share of the rhythm that rounds to 0 is a month with no amount on
// screen. A budget the person typed as 0 stays 0, and paper and the AI read
// `plannedOf` itself.
export function screenPlanned(planned: number | null, hasOwnBudget: boolean): number | null {
  return planned === 0 && !hasOwnBudget ? null : planned;
}
