/**
 * Under an hour: 5-minute steps, four below (>0) and three above; from an hour up, `CantidadHoras.dc.html`'s
 * spread — four 15-minute steps below (>0), three 30-minute steps above — 90 reads 30, 45, 60, 75, 90, 120, 150, 180.
 */
export function timeChipsAround(target: number): number[] {
  const down = target < 60 ? 5 : 15;
  const up = target < 60 ? 5 : 30;
  const chips = [target];
  for (let step = 1; step <= 4; step++) {
    const value = target - down * step;
    if (value > 0) chips.unshift(value);
  }
  for (let step = 1; step <= 3; step++) chips.push(target + up * step);
  return chips;
}
