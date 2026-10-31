import { getTranslations } from "next-intl/server";

import { Figure, Hero, Page, Row, ScreenHeader, Section, Strip, Text } from "@/components/ui";
import { stripCount, strip } from "@/lib/day/constancy";
import type { GoalCommitment } from "@/lib/queries/goal";
import { civilDateToDate, civilDayMonthShort, todayInZone } from "@/lib/zone";
import { evidenceUnitWords } from "@/lib/evidence/unit-words";

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
  const cells = strip(today, commitment.createdOn, commitment.done);
  const { done, of } = stripCount(cells);
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

  return (
    <Page>
      <ScreenHeader
        title={commitment.name}
        back={{ href: `/metas/${goalId}`, place: goalName }}
        eyebrow={t("goal.commitments.editTitle")}
        metaVariant="sentence"
        meta={t("goal.commitments.cadenceNow", { cadence: cadenceWords(commitment.cadence, t) })}
      />
      <Hero
        label={t("goal.commitments.stripLabel")}
        figure={t("goal.commitments.stripFigure", { done, of })}
        caption={t("goal.commitments.stripCaption")}
        highlight
      >
        <Strip
          cells={cells}
          label={t("goal.commitments.stripAria", { done, of })}
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
              name={t("goal.commitments.dayName", {
                weekday: weekdays[(civilDateToDate(entry.day).getUTCDay() + 6) % 7],
                day: Number(entry.day.slice(8, 10)),
              })}
              trailing={
                entry.quantity !== null ? (
                  <Figure variant="meta" value={entry.quantity} unit={unitFor(entry.quantity)} />
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
      <Text as="p" variant="sentence">
        {t("goal.commitments.cadenceLocked")}
      </Text>
      <CommitmentActions
        commitmentId={commitment.id}
        goalId={goalId}
        name={commitment.name}
        factDayCount={commitment.factDayCount}
      />
    </Page>
  );
}
