import { getTranslations } from "next-intl/server";

import { Page, ScreenHeader, Text } from "@/components/ui";
import type { GoalCommitment } from "@/lib/queries/goal";

import { CommitmentActions } from "./commitment-actions";
import { cadenceWords } from "./commitment-list";

/**
 * A commitment a fact already names (RP-127): its name changes, its cadence reads as it was so the weeks it
 * governed keep reading the same, and it can be retired. A commitment no fact names edits its cadence in
 * `CommitmentForm` instead.
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
  return (
    <Page>
      <ScreenHeader
        title={commitment.name}
        back={{ href: `/metas/${goalId}`, place: goalName }}
        eyebrow={t("goal.commitments.editTitle")}
        metaVariant="sentence"
        meta={t("goal.commitments.cadenceNow", { cadence: cadenceWords(commitment.cadence, t) })}
      />
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
