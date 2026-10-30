"use client";

import { useEffect, useRef, useState } from "react";
import NextLink from "next/link";
import { useTranslations } from "next-intl";

import { cardBack, cardFront } from "@/lib/log/anki";
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
      saving: boolean;
      done: number;
      // When the answer was shown, or null while it is hidden: the buttons' intervals are read from it.
      revealedAt: number | null;
    };

// RL-68: one word at a time — the word, then its answer on demand, then how well it was recalled.
// The queue is fixed when the screen opens: a word answered «Otra vez» waits for the next visit.
export function ReviewSession() {
  const t = useTranslations("review");
  const [state, setState] = useState<SessionState>({ kind: "loading" });
  const [failedSave, setFailedSave] = useState(false);
  const showRef = useRef<HTMLButtonElement>(null);
  const goodRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    Promise.all([readWordStudy(), readCards()])
      .then(([{ rows }, cards]) => {
        if (live) {
          setState({ kind: "ready", queue: buildQueue(rows, cards, Date.now()), index: 0, saving: false, done: 0, revealedAt: null });
        }
      })
      .catch(() => {
        if (live) setState({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, []);

  // A keyboard never loses its place: the answer's grades take focus when shown, the next word's
  // «Mostrar respuesta» when a grade is pressed.
  const index = state.kind === "ready" ? state.index : -1;
  const revealed = state.kind === "ready" && state.revealedAt !== null;
  useEffect(() => {
    if (index < 0) return;
    (revealed ? goodRef : showRef).current?.focus();
  }, [index, revealed]);

  async function answer(grade: ReviewGrade, now: number) {
    if (state.kind !== "ready" || state.saving || state.revealedAt === null) return;
    const item = state.queue.items[state.index];
    setFailedSave(false);
    setState((prev) => (prev.kind === "ready" ? { ...prev, saving: true } : prev));
    try {
      await saveCard(rate(item.row.key, item.card, grade, now));
      setState((prev) =>
        prev.kind === "ready"
          ? { ...prev, index: prev.index + 1, saving: false, done: prev.done + 1, revealedAt: null }
          : prev,
      );
    } catch {
      setState((prev) => (prev.kind === "ready" ? { ...prev, saving: false } : prev));
      setFailedSave(true);
    }
  }

  if (state.kind === "loading") return <Skeleton height="160px" />;
  if (state.kind === "failed") return <Text muted>{t("loadFailed")}</Text>;

  const { queue, saving, done, revealedAt } = state;
  const item = queue.items[state.index];

  if (item === undefined) {
    // Every word answered here is scheduled again, so it joins the ones already waiting.
    const later = queue.later + done;
    return (
      <Flex direction="column" gap="3" align="start">
        <Text size="4">{done === 0 ? t("nothingDue") : t("finished", { count: done })}</Text>
        {later > 0 && <Text muted>{t("later", { count: later })}</Text>}
        {later === 0 && <Text muted>{t("empty")}</Text>}
        <Link asChild>
          <NextLink href="/registro">{t("backToRecord")}</NextLink>
        </Link>
      </Flex>
    );
  }

  const { row, card } = item;
  const back = cardBack(row);
  const formsLine =
    row.forms.length === 1 && row.forms[0]?.text === row.key ? null : row.forms.map((form) => form.text).join(", ");

  return (
    <Flex direction="column" gap="5">
      <MetaLabel>{t("progress", { current: state.index + 1, total: queue.items.length })}</MetaLabel>
      <Flex direction="column" gap="2">
        <Headword>{cardFront(row)}</Headword>
        {card === null && (
          <Text size="2" muted>
            {t("newWord")}
          </Text>
        )}
      </Flex>
      {/* Mounted before the answer it carries, so a screen reader hears it arrive. */}
      <Live>{revealedAt === null ? "" : back}</Live>

      {revealedAt === null ? (
        <Button ref={showRef} size="3" onClick={() => setState({ ...state, revealedAt: Date.now() })}>
          {t("show")}
        </Button>
      ) : (
        <>
          <Flex direction="column" gap="2">
            <Separator size="4" />
            <Text variant="translation">{back}</Text>
            {formsLine !== null && (
              <Text size="2" muted>
                {t("forms", { forms: formsLine })}
              </Text>
            )}
          </Flex>
          <Grid columns={{ initial: "2", sm: "4" }} gap="2">
            {GRADES.map((grade) => {
              const { unit, count } = intervalUnit(intervals(card, revealedAt)[grade]);
              return (
                <Button
                  key={grade}
                  ref={grade === "good" ? goodRef : undefined}
                  size="3"
                  variant={grade === "good" ? "solid" : "soft"}
                  disabled={saving}
                  onClick={() => void answer(grade, Date.now())}
                >
                  <Flex direction="column" align="center">
                    {t(`grade.${grade}`)}
                    <Text size="1">{t(`in.${unit}`, { count })}</Text>
                  </Flex>
                </Button>
              );
            })}
          </Grid>
        </>
      )}
      {failedSave && <Text color="red">{t("saveFailed")}</Text>}
    </Flex>
  );
}
