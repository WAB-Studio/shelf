"use client";

import { useCallback, useEffect, useState } from "react";
import NextLink from "next/link";
import { useTranslations } from "next-intl";

import { readWordStudy } from "@/lib/log/summary";
import { buildQueue, type ReviewQueue } from "@/lib/review/deck";
import { GRADES, intervals, intervalUnit, rate, type ReviewGrade } from "@/lib/review/schedule";
import { readCards, saveCard } from "@/lib/review/store";
import { Button, Flex, Grid, Headword, Link, Live, MetaLabel, Separator, Skeleton, Text } from "@/components/ui";

type SessionState =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      queue: ReviewQueue;
      index: number;
      revealed: boolean;
      saving: boolean;
      done: number;
      // When the word on screen came up: the buttons' intervals are read from it, never from render.
      shownAt: number;
    };

// RL-68: one word at a time — the word, then its answer on demand, then how well it was recalled.
// The queue is fixed when the screen opens: a word answered «Otra vez» waits for the next visit.
export function ReviewSession() {
  const t = useTranslations("review");
  const [state, setState] = useState<SessionState>({ kind: "loading" });
  const [failedSave, setFailedSave] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([readWordStudy(), readCards()])
      .then(([{ rows }, cards]) => {
        const now = Date.now();
        if (live) {
          setState({ kind: "ready", queue: buildQueue(rows, cards, now), index: 0, revealed: false, saving: false, done: 0, shownAt: now });
        }
      })
      .catch(() => {
        if (live) setState({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, []);

  const answer = useCallback(
    async (grade: ReviewGrade) => {
      if (state.kind !== "ready" || state.saving) return;
      const item = state.queue.items[state.index];
      setState({ ...state, saving: true });
      setFailedSave(false);
      try {
        const now = Date.now();
        await saveCard(rate(item.row.key, item.card, grade, now));
        setState({ ...state, index: state.index + 1, revealed: false, saving: false, done: state.done + 1, shownAt: Date.now() });
      } catch {
        setState({ ...state, saving: false });
        setFailedSave(true);
      }
    },
    [state],
  );

  if (state.kind === "loading") return <Skeleton height="160px" />;
  if (state.kind === "failed") return <Text muted>{t("loadFailed")}</Text>;

  const { queue, index, revealed, saving, done, shownAt } = state;
  const item = queue.items[index];

  if (item === undefined) {
    return (
      <Flex direction="column" gap="3" align="start">
        <Text size="4">{queue.items.length === 0 && done === 0 ? t("nothingDue") : t("finished", { count: done })}</Text>
        {queue.later > 0 && <Text muted>{t("later", { count: queue.later })}</Text>}
        {queue.items.length === 0 && queue.later === 0 && <Text muted>{t("empty")}</Text>}
        <Link asChild>
          <NextLink href="/registro">{t("backToRecord")}</NextLink>
        </Link>
      </Flex>
    );
  }

  const { row, card } = item;
  const span = intervals(card, shownAt);
  const formsLine =
    row.forms.length === 1 && row.forms[0]?.text === row.key ? null : row.forms.map((form) => form.text).join(", ");

  return (
    <Flex direction="column" gap="5">
      <MetaLabel>{t("progress", { current: index + 1, total: queue.items.length })}</MetaLabel>
      <Flex direction="column" gap="2">
        <Headword>{row.lastOutcome === "unlisted" ? row.display : row.key}</Headword>
        {card === null && <Text size="2" muted>{t("newWord")}</Text>}
      </Flex>

      {revealed ? (
        <Flex direction="column" gap="2">
          <Live>{row.lastTranslation ?? row.lastDefinition}</Live>
          <Separator size="4" />
          <Text variant="translation" aria-hidden>
            {row.lastTranslation ?? row.lastDefinition}
          </Text>
          {formsLine !== null && (
            <Text size="2" muted>
              {t("forms", { forms: formsLine })}
            </Text>
          )}
        </Flex>
      ) : (
        <Button size="3" onClick={() => setState({ ...state, revealed: true })}>
          {t("show")}
        </Button>
      )}

      {revealed && (
        <Grid columns={{ initial: "2", sm: "4" }} gap="2">
          {GRADES.map((grade) => {
            const { unit, count } = intervalUnit(span[grade]);
            return (
              <Button
                key={grade}
                size="3"
                variant={grade === "good" ? "solid" : "soft"}
                disabled={saving}
                onClick={() => void answer(grade)}
              >
                <Flex direction="column" align="center">
                  {t(`grade.${grade}`)}
                  <Text size="1">{t(`in.${unit}`, { count })}</Text>
                </Flex>
              </Button>
            );
          })}
        </Grid>
      )}
      {failedSave && <Text color="red">{t("saveFailed")}</Text>}
    </Flex>
  );
}
