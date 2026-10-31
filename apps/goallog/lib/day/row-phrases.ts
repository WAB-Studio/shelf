import type { MessageKey } from "@/i18n/translator";
import type { Cadence } from "@/lib/day/types";
import { isTimeUnit } from "@/lib/units/time";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type CadenceNames = {
  // Monday first, three letters each: a weekdays cadence of several days.
  weekdayName: string[];
  // Monday first, «martes», «sábados»: read after «solo los».
  weekdayPlural: string[];
};

// The cadence as a row's second line says it (`HoyDia`): days as a sentence,
// «lun, mié y vie». Null only for «every 1 day», which a daily cadence already says.
export function cadencePhrase(translate: Translate, cadence: Cadence, names: CadenceNames): string | null {
  switch (cadence.kind) {
    case "daily":
      return translate("day.cadence.everyDay");
    case "weekdays":
      return cadence.days.length === 1
        ? translate("day.cadence.onlyWeekday", { weekday: names.weekdayPlural[cadence.days[0] - 1] })
        : cadence.days.length === 7
          ? translate("day.cadence.everyDay")
          : weekdaysSentence(translate, cadence.days, names.weekdayName);
    case "times_per_week":
      return translate("day.cadence.timesPerWeek", { count: cadence.count });
    case "every_n_days":
      return cadence.n === 1 ? null : translate("day.cadence.everyNDays", { n: cadence.n });
    case "times_per_month":
      return translate("day.cadence.timesPerMonth", { count: cadence.count });
  }
}

// Every screen that names a weekdays cadence reads it through here: ISO days
// (1 = Monday), whatever order they were stored in, said Monday first as a
// sentence. `names` is Monday first, in the word length the screen wants.
export function weekdaysSentence(translate: Translate, days: number[], names: string[]): string {
  const said = [...days].sort((a, b) => a - b).map((day) => names[day - 1]);
  if (said.length < 2) return said.join("");
  return translate("day.cadence.daysJoin", { list: said.slice(0, -1).join(", "), last: said[said.length - 1] });
}

// A goal's phase line: «fase 2 de 3 · desbloquear la boca»; a goal with one
// phase says its name alone.
export function phaseLine(
  translate: Translate,
  name: string,
  position: { ordinal: number; total: number },
): string {
  return position.total > 1 ? translate("day.phase.of", { ...position, name }) : name;
}

// Each phase's place among its goal's phases, by `startsOn`.
export function phasePositions(
  phases: { id: string; goalId: string; startsOn: string }[],
): Record<string, { ordinal: number; total: number }> {
  const byGoal = new Map<string, typeof phases>();
  for (const phase of phases) byGoal.set(phase.goalId, [...(byGoal.get(phase.goalId) ?? []), phase]);

  const positions: Record<string, { ordinal: number; total: number }> = {};
  for (const own of byGoal.values()) {
    const ordered = [...own].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
    ordered.forEach((phase, index) => {
      positions[phase.id] = { ordinal: index + 1, total: ordered.length };
    });
  }
  return positions;
}

/**
 * A flexible commitment already met in its period, drawn quiet: «cumplida
 * esta semana · 1 de 1». Past its quota the count is said as times, since
 * «2 de 1» reads as a mistake. Null for a cadence counted by the day, or one
 * not yet met.
 */
export function metPhrase(
  translate: Translate,
  commitment: { cadence: Cadence; periodDone: number | undefined },
): string | null {
  const { cadence, periodDone } = commitment;
  if (periodDone === undefined) return null;
  let period: "week" | "month";
  if (cadence.kind === "times_per_week") period = "week";
  else if (cadence.kind === "times_per_month") period = "month";
  else return null;
  if (periodDone < cadence.count) return null;
  return translate(periodDone > cadence.count ? `day.met.${period}Over` : `day.met.${period}`, {
    done: periodDone,
    total: cadence.count,
  });
}

// The four phrases `flexibleWords` says.
export type FlexibleKey =
  | "week.flexible.week"
  | "week.flexible.month"
  | "week.flexible.weekProgress"
  | "week.flexible.monthProgress";

type Say = (key: FlexibleKey, values?: Record<string, number | string>) => string;

/**
 * A flexible commitment's own two phrases (`SemanaFlexible.dc.html`): its
 * cadence, «3 veces por semana», and the period's count, «1 de 3 esta
 * semana». Null for a cadence counted by the day.
 */
export function flexibleWords(
  commitment: { cadence: Cadence; periodDone: number | null },
  t: Say,
): { cadence: string; progress: string } | null {
  const { cadence, periodDone } = commitment;
  if (cadence.kind === "times_per_week") {
    return {
      cadence: t("week.flexible.week", { count: cadence.count }),
      progress: t("week.flexible.weekProgress", { done: periodDone ?? 0, total: cadence.count }),
    };
  }
  if (cadence.kind === "times_per_month") {
    return {
      cadence: t("week.flexible.month", { count: cadence.count }),
      progress: t("week.flexible.monthProgress", { done: periodDone ?? 0, total: cadence.count }),
    };
  }
  return null;
}

export type RowMetaPieces = {
  kind: "tap" | "quantity" | "evidence";
  done: boolean;
  quiet: boolean;
  // Already null where the status says the cadence: «2 de 3 esta semana»,
  // never «3 veces por semana · 2 de 3 esta semana».
  cadenceText: string | null;
  amount: string | undefined;
  // The met phrase of a quiet row, or the progress of a flexible one.
  status: string | null;
  writtenTime: string | undefined;
  writtenLabel: string | undefined;
  // A `quantity` row with a fact that day under its target: not done, yet the
  // person wrote a number. Both already formatted, a time as «45 min».
  partial?: { logged: string; target: string } | null;
  // An evidence row's ask and, once met, what it got and where from. Already
  // translated. It replaces every other piece: the line is only this.
  // `noted` is the open row's «lo anota el diccionario», said before what it asks.
  evidence?: { asks: string; got: string | null; source: string | null; noted?: string | null };
};

// The line as parts: a figure (a number, a quantity, an hour) is drawn in mono,
// the words around it in Archivo.
export type RowMetaPart = { text: string } | { figure: string };

// A partial quantity says its unit once: «7 de 90 kilómetros». A time unit
// drops the logged word only when both read as one number and one word
// («1 de 3 min»); «1 h 05 min» of «2 h» keeps both.
export function partialPair(logged: string, target: string, unit: string | null): { logged: string; target: string } {
  const [loggedNumber, loggedWord, ...loggedRest] = logged.split(" ");
  const [, targetWord, ...targetRest] = target.split(" ");
  const single = loggedRest.length === 0 && targetRest.length === 0 && loggedWord !== undefined;
  if (!isTimeUnit(unit)) return { logged: loggedNumber, target };
  return { logged: single && loggedWord === targetWord ? loggedNumber : logged, target };
}

/**
 * A row's second line as parts, joined with « · ». «lo dijiste tú» marks a
 * done `tap` or `quantity` row after its hour; A quantity row logged
 * under its target reads «1 de 3 min · 09:22 · lo dijiste tú», its mark still
 * empty. Evidence and quiet rows say neither (`HoyEscritorio.dc.html`). The
 * target of a `quantity` row, what it logged and the hour are figures.
 */
export function rowMeta(translate: Translate, pieces: RowMetaPieces): RowMetaPart[] | undefined {
  const { kind, done, quiet, status } = pieces;
  if (pieces.evidence) {
    const { asks, got, source, noted } = pieces.evidence;
    return [{ text: got === null ? (noted ? `${noted} · ${asks}` : asks) : source ? `${got} · ${source}` : got }];
  }
  const loud = !quiet && kind !== "evidence";
  const partial = loud && !done && kind === "quantity" ? (pieces.partial ?? null) : null;
  const said = loud && (done || partial) ? translate("day.row.saidByYou") : null;

  const amount: RowMetaPart[] | undefined = partial
    ? partialParts(translate("day.row.partialAmount", { logged: LOGGED, target: TARGET }), partial)
    : pieces.amount
      ? [kind === "quantity" ? { figure: pieces.amount } : { text: pieces.amount }]
      : undefined;
  const pieceParts: (RowMetaPart[] | null | undefined)[] = [
    pieces.cadenceText ? [{ text: pieces.cadenceText }] : null,
    amount,
    status ? [{ text: status }] : null,
    pieces.writtenTime ? [{ figure: pieces.writtenTime }] : null,
    said ? [{ text: said }] : null,
    pieces.writtenLabel ? [{ text: pieces.writtenLabel }] : null,
  ];
  const parts = pieceParts
    .filter((piece): piece is RowMetaPart[] => Boolean(piece))
    .flatMap((piece, index) => (index === 0 ? piece : [{ text: " · " }, ...piece]));
  return parts.length > 0 ? parts : undefined;
}

// Markers the catalogue's template carries through, so «{logged} de {target}»
// keeps its own word order.
const LOGGED = "\u0000logged\u0000";
const TARGET = "\u0000target\u0000";

function partialParts(template: string, partial: { logged: string; target: string }): RowMetaPart[] {
  return template
    .split(/(\u0000logged\u0000|\u0000target\u0000)/)
    .filter((piece) => piece !== "")
    .map((piece) =>
      piece === LOGGED ? { figure: partial.logged } : piece === TARGET ? { figure: partial.target } : { text: piece },
    );
}
