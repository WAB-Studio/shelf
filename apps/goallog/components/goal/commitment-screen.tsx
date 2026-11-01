import { getTranslations } from "next-intl/server";

import { Figure, Hero, Page, Row, ScreenHeader, Section, Split, Strip, Text } from "@/components/ui";
import { stripCount, strip } from "@/lib/day/constancy";
import type { GoalCommitment } from "@/lib/queries/goal";
import { civilDateToDate, civilDayMonthShort, todayInZone } from "@/lib/zone";
import { partialPair, stripLabel } from "@/lib/day/row-phrases";
import { evidenceUnitWords } from "@/lib/evidence/unit-words";
import { formatTime, isTimeUnit } from "@/lib/units/time";
import { timeWordsOf } from "@/lib/units/time-words";

import { CommitmentActions } from "./commitment-actions";
import { cadenceWords } from "./commitment-list";

// The days listed under the strip: the last ones, not the whole month.
const LISTED_DAYS = 8;

/**
 * A commitment a fact already names (RP-127): its name changes, its cadence reads as it was so the weeks it
 * governed keep reading the same, and it can be retired. Above that, its constancy: the last thirty days as a
 * strip and «26 de 30», with what fulfils it and the amount of each day (no streak, none broken). A commitment
 * no fact names edits its cadence in `CommitmentForm` instead.
 */
export async function CommitmentScreen({
  goalId,
  goalName,
  commitment,
}: {
  goalId: string;
  goalName: string;
  commitment: GoalCommitment;
}) {
  const t = await getTranslations();
  const today = todayInZone();
  const cells = strip(today, commitment, commitment.done);
  const { done, of } = stripCount(cells, commitment.cadence);
  const weekdays = t.raw("day.weekdayLong") as string[];
  const evidence = commitment.satisfiedBy.kind === "evidence" ? commitment.satisfiedBy : null;
  const unitFor = (amount: number): string | undefined =>
    evidence
      ? commitment.sourceLabelKey
        ? evidenceUnitWords({ labelKey: commitment.sourceLabelKey, unit: evidence.unit }, amount, t)
        : evidence.unit
      : commitment.satisfiedBy.kind === "quantity"
        ? commitment.satisfiedBy.unit
        : undefined;

  // Minutes read as every other row says them, «1 h 30 min»; a day under the threshold says «14 de 30 min».
  const timeWords = timeWordsOf(t as unknown as Parameters<typeof timeWordsOf>[0]);
  const timed = evidence !== null && isTimeUnit(evidence.unit);
  const partialOf = (got: number, asks: number): string =>
    timed
      ? t("day.row.partialAmount", partialPair(formatTime(got, timeWords), formatTime(asks, timeWords), "minutos"))
      : t("day.row.partialAmount", { logged: String(got), target: `${asks} ${unitFor(asks)}` });

  return (
    <Page width="full">
      <ScreenHeader
        title={commitment.name}
        back={{ href: `/metas/${goalId}`, place: goalName }}
        eyebrow={t("goal.commitments.editTitle")}
        metaVariant="sentence"
        meta={t("goal.commitments.cadenceNow", { cadence: cadenceWords(commitment.cadence, t) })}
      />
      <Split
        main={
          <>
            <Hero
              label={t("goal.commitments.stripLabel")}
              figure={of === null ? t("goal.commitments.stripFigureDays", { done }) : t("goal.commitments.stripFigure", { done, of })}
              caption={t("goal.commitments.stripCaption")}
              highlight
            >
              <Strip
                cells={cells}
                label={stripLabel((key, values) => t(key, values), { done, of })}
                from={civilDayMonthShort(cells[0].day)}
                to={t("goal.commitments.stripToday")}
              />
            </Hero>
            {evidence && commitment.sourceLabelKey ? (
              <Text as="p" variant="sentence">
                {t.rich("goal.commitments.fulfils", {
                  source: t(commitment.sourceLabelKey),
                  threshold: evidence.threshold,
                  fig: () => <Figure variant="meta" value={evidence.threshold} unit={unitFor(evidence.threshold)} />,
                })}
              </Text>
            ) : null}
            {commitment.done.length > 0 ? (
              <Section label={t("goal.commitments.daysTitle")}>
                {commitment.done.slice(0, LISTED_DAYS).map((entry) => (
                  <Row
                    key={entry.day}
                    note={entry.note}
                    name={t("goal.commitments.dayName", {
                      weekday: weekdays[(civilDateToDate(entry.day).getUTCDay() + 6) % 7],
                      day: Number(entry.day.slice(8, 10)),
                    })}
                    trailing={
                      entry.by === "partial" && evidence && entry.quantity !== null ? (
                        <Figure variant="meta" value={partialOf(entry.quantity, evidence.threshold)} />
                      ) : entry.quantity !== null ? (
                        <Figure
                          variant="meta"
                          value={timed ? formatTime(entry.quantity, timeWords) : entry.quantity}
                          unit={timed ? undefined : unitFor(entry.quantity)}
                        />
                      ) : (
                        <Text as="span" variant="sentence" tone="muted">
                          {t("goal.commitments.dayTap")}
                        </Text>
                      )
                    }
                  />
                ))}
              </Section>
            ) : null}
          </>
        }
        after={
          <>
            <Text as="p" variant="sentence">
              {t("goal.commitments.cadenceLocked")}
            </Text>
            <CommitmentActions
              commitmentId={commitment.id}
              goalId={goalId}
              name={commitment.name}
              factDayCount={commitment.factDayCount}
              evidenceDayCount={commitment.evidenceDayCount}
            />
          </>
        }
      />
    </Page>
  );
}
