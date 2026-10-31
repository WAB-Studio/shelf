"use client";

import { useEffect, useRef, useState } from "react";
import NextLink from "next/link";
import { useTranslations } from "next-intl";

import { useDictionary } from "@/lib/dictionary/use-dictionary";
import type { Sense } from "@/lib/dictionary/index-build";
import { cardBack, cardFront } from "@/lib/log/anki";
import { countKind, isPhraseRow } from "@/lib/log/outcome";
import { readWordStudy } from "@/lib/log/summary";
import { buildQueue, isReviewable, type ReviewQueue } from "@/lib/review/deck";
import { GRADES, intervals, intervalUnit, rate, staysInSession, type ReviewGrade } from "@/lib/review/schedule";
import { answerSenses, pickSense } from "@/lib/review/sense";
import { readCards, saveCard } from "@/lib/review/store";
import { TranslationList } from "@/components/translations/translation-list";
import {
  Button,
  Card,
  Flex,
  Grid,
  Headword,
  Link,
  Live,
  MetaLabel,
  PosLabel,
  Separator,
  Skeleton,
  Text,
} from "@/components/ui";

type Item = ReviewQueue["items"][number];

type SessionState =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      // The queue as the screen opened, then every «Otra vez» answer appended behind it.
      items: Item[];
      later: number;
      // «entradas» once a phrase is among the reviewable rows, «palabras» before.
      unit: "entries" | "words";
      index: number;
      saving: boolean;
      // The keys answered so far: an entry answered twice counts once.
      answered: string[];
      // When the answer was shown, or null while it is hidden: the buttons' intervals are read from it.
      revealedAt: number | null;
      // The moment the screen last checked whether a requeued entry came due.
      clock: number;
    };

// RL-68 and RL-79: one entry at a time — the word or phrase, then its answer on demand, then how well it
// was recalled. An entry answered «Otra vez» is due again in a minute, so it joins the end of this
// session and the session is not over while one waits.
export function ReviewSession() {
  const t = useTranslations("review");
  const tWord = useTranslations("word");
  const { lookup } = useDictionary();
  const [state, setState] = useState<SessionState>({ kind: "loading" });
  const [failedSave, setFailedSave] = useState(false);
  // The one sense the card draws, for the word on screen.
  const [sense, setSense] = useState<{ key: string; sense: Sense } | null>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const goodRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    Promise.all([readWordStudy(), readCards()])
      .then(([{ rows }, cards]) => {
        if (!live) return;
        const queue = buildQueue(rows, cards, Date.now());
        setState({
          kind: "ready",
          items: queue.items,
          later: queue.later,
          unit: countKind(rows.filter(isReviewable)),
          index: 0,
          saving: false,
          answered: [],
          revealedAt: null,
          clock: Date.now(),
        });
      })
      .catch(() => {
        if (live) setState({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, []);

  const current = state.kind === "ready" ? state.items[state.index] : undefined;
  const currentKey = current?.row.key;
  const currentIsPhrase = current !== undefined && isPhraseRow(current.row);
  const currentTranslation = current?.row.lastTranslation ?? null;

  // A word asks the dictionary on the device for its senses; a phrase has none, and a dictionary that
  // never answers leaves the card on the line the record kept.
  useEffect(() => {
    if (currentKey === undefined || currentIsPhrase) return;
    let live = true;
    lookup(currentKey)
      .then((answer) => {
        const picked = pickSense(answerSenses(answer), currentTranslation);
        if (live && picked !== null) setSense({ key: currentKey, sense: picked });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [currentKey, currentIsPhrase, currentTranslation, lookup]);

  // An entry put back for a minute shows again once it is due.
  const dueAt = current?.card != null && state.kind === "ready" && current.card.due > state.clock ? current.card.due : null;
  useEffect(() => {
    if (dueAt === null) return;
    const timer = setTimeout(
      () => setState((prev) => (prev.kind === "ready" ? { ...prev, clock: Date.now() } : prev)),
      Math.max(0, dueAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [dueAt]);

  // A keyboard never loses its place: the answer's grades take focus when shown, the next entry's
  // «Mostrar respuesta» when a grade is pressed.
  const index = state.kind === "ready" ? state.index : -1;
  const revealed = state.kind === "ready" && state.revealedAt !== null;
  useEffect(() => {
    if (index < 0 || dueAt !== null) return;
    (revealed ? goodRef : showRef).current?.focus();
  }, [index, revealed, dueAt]);

  async function answer(grade: ReviewGrade, now: number) {
    if (state.kind !== "ready" || state.saving || state.revealedAt === null) return;
    const item = state.items[state.index];
    setFailedSave(false);
    setState((prev) => (prev.kind === "ready" ? { ...prev, saving: true } : prev));
    try {
      const next = rate(item.row.key, item.card, grade, now);
      await saveCard(next);
      setState((prev) =>
        prev.kind === "ready"
          ? {
              ...prev,
              items: staysInSession(next, now) ? [...prev.items, { row: item.row, card: next }] : prev.items,
              index: prev.index + 1,
              saving: false,
              answered: prev.answered.includes(item.row.key) ? prev.answered : [...prev.answered, item.row.key],
              revealedAt: null,
              clock: Date.now(),
            }
          : prev,
      );
    } catch {
      setState((prev) => (prev.kind === "ready" ? { ...prev, saving: false } : prev));
      setFailedSave(true);
    }
  }

  if (state.kind === "loading") return <Skeleton height="160px" />;
  if (state.kind === "failed") return <Text muted>{t("loadFailed")}</Text>;

  const { items, saving, answered, revealedAt, clock } = state;
  const kind = state.unit;
  const item = items[state.index];

  if (item === undefined) {
    // Every entry answered here is scheduled again, so it joins the ones already waiting.
    const later = state.later + answered.length;
    return (
      <Card>
        <Flex direction="column" gap="3" align="start">
          <Text size="4">
            {answered.length === 0 ? t("nothingDue") : t("finished", { count: answered.length, kind })}
          </Text>
          {later > 0 && <Text muted>{t("later", { count: later, kind })}</Text>}
          {later === 0 && <Text muted>{t("empty")}</Text>}
          <Link asChild>
            <NextLink href="/registro">{t("backToRecord")}</NextLink>
          </Link>
        </Flex>
      </Card>
    );
  }

  if (item.card !== null && item.card.due > clock) {
    const waiting = items.length - state.index;
    const minutes = Math.max(1, Math.ceil((item.card.due - clock) / 60_000));
    return (
      <Card>
        <Flex direction="column" gap="3" align="start">
          <Text size="4">{t("waiting", { count: waiting })}</Text>
          <Text muted>{t("waitingIn", { minutes })}</Text>
          <Button
            ref={showRef}
            size="3"
            onClick={() => setState({ ...state, clock: item.card!.due })}
          >
            {t("reviewNow")}
          </Button>
        </Flex>
      </Card>
    );
  }

  const { row, card } = item;
  const back = cardBack(row);
  const drawn = sense !== null && sense.key === row.key && !isPhraseRow(row) ? sense.sense : null;
  const formsLine =
    row.forms.length === 1 && row.forms[0]?.text === row.key ? null : row.forms.map((form) => form.text).join(", ");

  return (
    <Card>
      <Flex direction="column" gap="5">
        <MetaLabel>{t("progress", { current: state.index + 1, total: items.length })}</MetaLabel>
        <Flex direction="column" gap="2">
          <Headword>{cardFront(row)}</Headword>
          {card === null && (
            <Text size="2" muted>
              {t("newWord")}
            </Text>
          )}
        </Flex>
        {/* Mounted before the answer it carries, so a screen reader hears it arrive. */}
        <Live>{revealedAt === null ? "" : drawn !== null ? drawn.translations.slice(0, 3).join(", ") : back}</Live>

        {revealedAt === null ? (
          <Button ref={showRef} size="3" onClick={() => setState({ ...state, revealedAt: Date.now() })}>
            {t("show")}
          </Button>
        ) : (
          <>
            <Flex direction="column" gap="2">
              <Separator size="4" />
              {drawn !== null ? (
                <>
                  <PosLabel>{tWord(`pos.${drawn.pos}`)}</PosLabel>
                  <TranslationList items={drawn.translations} />
                  {drawn.definition !== null && (
                    <Text size="2" muted english>
                      {drawn.definition}
                    </Text>
                  )}
                </>
              ) : (
                <Text variant="translation">{back}</Text>
              )}
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
    </Card>
  );
}
