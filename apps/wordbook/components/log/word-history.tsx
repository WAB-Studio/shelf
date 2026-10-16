"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";

import { readLemmaHistory, readLemmaKey, type WordHistoryRow } from "@/lib/log/summary";
import { recalledFilter } from "@/lib/log/study-filter";
import type { LookupOutcome } from "@/lib/log/types";
import { useDictionary } from "@/lib/dictionary/use-dictionary";
import type { WordAnswer } from "@/lib/dictionary/lookup";
import { NetworkAnswer } from "@/components/search/network-answer";
import { InstallStatus } from "@/components/search/install-status";
import { SenseList } from "@/components/search/sense-list";
import {
  Button,
  Flex,
  Grid,
  Headword,
  Link,
  MetaLabel,
  Separator,
  Skeleton,
  TapTarget,
  Text,
} from "@/components/ui";

// The other half of RL-56: one word's own searches, read off the same
// `normalised` index `HistoryList` groups by. The reader came here to see
// again what the search box showed them, so this mounts the same
// dictionary `SenseList` draws for `/?q=` — its own Worker, its own lookup,
// keyed on the segment's own `normalised` rather than on a box this screen
// never has.

type ViewState =
  | { kind: "loading" }
  | { kind: "empty"; key: string }
  | { kind: "ready"; key: string; rows: WordHistoryRow[]; total: number }
  | { kind: "failed" };

type OutcomeKey = "exact" | "inflected" | "translated" | "miss" | "unlisted";

// Mirrors `history-list.tsx`'s own fold: `untranslated` reads the same as
// `miss` to a reader, neither found an answer.
// `unlisted` is a lookup the network answered; `LookupOutcome` does not name it yet.
function outcomeKey(outcome: LookupOutcome | "unlisted"): OutcomeKey {
  return outcome === "untranslated" ? "miss" : outcome;
}

function BackLink({ label }: { label: string }) {
  const filter = recalledFilter();
  return (
    <Link asChild underline="none">
      <NextLink href={filter === "" ? "/registro" : `/registro?filtro=${encodeURIComponent(filter)}`}>
        <TapTarget align="center">← {label}</TapTarget>
      </NextLink>
    </Link>
  );
}

function WordHistorySkeleton() {
  const t = useTranslations("log");
  return (
    <Flex direction="column" gap="5">
      <Skeleton>
        <Text size="2">← {t("word.back")}</Text>
      </Skeleton>
      <Flex direction="column" gap="2">
        <Skeleton>
          <Headword>{t("word.skeletonHeadword")}</Headword>
        </Skeleton>
        <Skeleton>
          <Text size="2">{t("word.skeletonSubtitle")}</Text>
        </Skeleton>
      </Flex>
      <Flex direction="column" gap="3">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index}>
            <Text size="2">{t("word.skeletonDate")}</Text>
          </Skeleton>
        ))}
      </Flex>
    </Flex>
  );
}

export function WordHistory() {
  const pathname = usePathname();
  // The offline shell `/registro/_` serves every word, so the address is the
  // only place the word lives; the pathname arrives still percent-encoded.
  const last = pathname.split("/").pop() ?? "";
  let normalised = last;
  try {
    normalised = decodeURIComponent(last);
  } catch {
    // A hand-typed malformed escape: the raw segment is the text the person typed.
  }
  const t = useTranslations("log");
  const tWord = useTranslations("word");
  const format = useFormatter();
  const router = useRouter();
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  // Bumped by the failed state's own retry, since the read runs in an
  // effect and a click cannot call it directly.
  const [attempt, setAttempt] = useState(0);
  const { status: dictionaryStatus, lookup, retry: retryDictionary } = useDictionary();
  // Set once the Worker answers, however long that takes — `dictionaryStatus`
  // is what the render below reads meanwhile.
  const [answer, setAnswer] = useState<WordAnswer | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The URL word may be a form: its lemma comes off its own stored rows,
    // never off a lookup.
    readLemmaKey(normalised)
      .then(async (key) => {
        const { rows, total } = await readLemmaHistory(key);
        if (cancelled) return;
        setState(rows.length === 0 ? { kind: "empty", key } : { kind: "ready", key, rows, total });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [normalised, attempt]);

  const lookupKey = state.kind === "ready" ? state.key : null;

  useEffect(() => {
    if (lookupKey === null) return;
    let cancelled = false;
    lookup(lookupKey)
      .then((result) => {
        if (!cancelled) setAnswer(result);
      })
      .catch(() => {
        // Only reachable in the instant before this hook's own mount
        // effect builds its Worker. A lookup issued after a failed install
        // sits queued instead — no rejection, nothing to show here beyond
        // what `InstallStatus`'s own failed branch already says.
      });
    return () => {
      cancelled = true;
    };
  }, [lookupKey, lookup]);

  if (state.kind === "loading") {
    return <WordHistorySkeleton />;
  }

  if (state.kind === "empty") {
    // Reachable by a hand-typed URL, or a stale link, for a word this
    // record never held — not the same thing as an empty record
    // (`study.empty*`, `RegistroEstudioEstados`): the reader may have
    // searched plenty, just never this one (`PalabraHistorialVacio`).
    // The headword stays up top as it does in the full state below.
    return (
      <Flex direction="column" gap="5">
        <BackLink label={t("word.back")} />
        <Headword>{normalised}</Headword>
        <Separator size="4" />
        <Flex direction="column" gap="3" align="start">
          <Text size="2" muted>
            {t("word.emptyBody", { word: normalised })}
          </Text>
          <Button size="2" onClick={() => router.push(`/?q=${encodeURIComponent(normalised)}`)}>
            {t("word.emptyAction")}
          </Button>
        </Flex>
      </Flex>
    );
  }

  if (state.kind === "failed") {
    // No red in this palette (docs/wordbook/DESIGN.md "Failure"): a hairline
    // sets the break off, full-weight ink says it, the accent lives in
    // retry — the same treatment `history-list.tsx` gives its own failure.
    return (
      <Flex direction="column" gap="5">
        <BackLink label={t("word.back")} />
        <Flex direction="column" gap="3" align="start">
          <Separator size="4" />
          <Text size="2" weight="bold">
            {t("listFailed")}
          </Text>
          <Button
            size="2"
            onClick={() => {
              setState({ kind: "loading" });
              setAttempt((current) => current + 1);
            }}
          >
            {t("retry")}
          </Button>
        </Flex>
      </Flex>
    );
  }

  const { key } = state;
  const latest = state.rows[0];
  const earliest = state.rows[state.rows.length - 1];
  // Every row for one `normalised` shares its `kind` — it is fixed at
  // write time by what the reader typed, not by any one search's outcome.
  const isPhrase = latest.kind === "phrase";
  // Most recent search that actually reached a translation: a later retry
  // that failed must not blank out an answer an earlier one already stored.
  const phraseTranslation = isPhrase
    ? (state.rows.find((row) => row.translation !== null)?.translation ?? null)
    : null;

  // A word the dictionary lacks and the network answered has no stored
  // gloss of its own but the latest network one; a lemma keeps the latest
  // row's.
  const unlistedRow = isPhrase ? undefined : state.rows.find((row) => row.outcome === "unlisted");
  // A dictionary that could not install leaves nothing to contradict the
  // row: the answer the reader saw is still the one worth showing.
  const networkOnly =
    unlistedRow !== undefined &&
    ((dictionaryStatus.state === "failed" && unlistedRow.translation !== null) ||
      (answer !== null && answer.exact === null && answer.viaInflection.length === 0));
  const gloss = isPhrase
    ? null
    : networkOnly ? null : (unlistedRow ?? state.rows[0]).translation;
  // The provider formats in the server's zone; the reader's is the browser's.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const subtitleValues = {
    count: state.total,
    date: format.dateTime(new Date(earliest.at), { day: "numeric", month: "long", timeZone }),
  };
  // The lemma heads the page, in the casing a row wrote it when one did.
  const heading = key.toLowerCase() === latest.text.toLowerCase() ? latest.text : key;

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dayOf = (value: Date) => format.dateTime(value, { year: "numeric", month: "numeric", day: "numeric", timeZone });
  const rowTime = (at: number): string => {
    const moment = new Date(at);
    const time = format.dateTime(moment, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
    const day = dayOf(moment);
    if (day === dayOf(today)) return t("word.timeToday", { time });
    if (day === dayOf(yesterday)) return t("word.timeYesterday", { time });
    return t("word.timeOther", { date: format.dateTime(moment, { day: "numeric", month: "short", timeZone }), time });
  };

  return (
    <Flex direction="column" gap="5">
      <BackLink label={t("word.back")} />

      <Flex direction="column" gap="1">
        <Headword>{heading}</Headword>
        <Text size="2" muted>
          {gloss === null
            ? t("word.subtitle", subtitleValues)
            : t("word.lemmaSubtitle", { ...subtitleValues, translation: gloss })}
        </Text>
      </Flex>

      <Separator size="4" />

      {/* RL-34: a sentence's own answer is the translation already stored
          on its rows, never a dictionary lookup — `he holds a grudge
          against me` is never a headword and asking the Worker for one
          only reproduces the "no tiene esa palabra" miss the record never
          had. The reason the reader opened this screen on a word stays the
          same answer the box gave them, `showExactHeadword` off since the
          heading above already names this word. */}
      {isPhrase ? (
        phraseTranslation !== null ? (
          <Text variant="translation">{phraseTranslation}</Text>
        ) : (
          <Text size="2" muted>
            {t("word.phraseMissing")}
          </Text>
        )
      ) : networkOnly ? (
        unlistedRow!.translation === null ? null : unlistedRow!.exampleEn !== null && unlistedRow!.exampleEs !== null ? (
          <NetworkAnswer
            surface={key}
            state={{
              kind: "resolved",
              answer: {
                translations: [unlistedRow!.translation],
                definition: unlistedRow!.definition,
                example: { en: unlistedRow!.exampleEn, es: unlistedRow!.exampleEs },
                lemma: null,
                rule: null,
              },
            }}
          />
        ) : (
          <Flex direction="column" gap="1">
            <Text variant="definitionLabel" muted>{tWord("networkTranslations")}</Text>
            <Text variant="translation">{unlistedRow!.translation}</Text>
          </Flex>
        )
      ) : dictionaryStatus.state !== "ready" ? (
        <InstallStatus status={dictionaryStatus} onRetry={retryDictionary} query="" hasBox={false} />
      ) : answer ? (
        <SenseList answer={answer} showExactHeadword={false} />
      ) : (
        <Skeleton>
          <Text size="2">{t("word.skeletonAnswer")}</Text>
        </Skeleton>
      )}

      <Separator size="4" />

      {/* Every past search, kept below the answer rather than above it or
          folded away: the answer is why the reader tapped this word, the
          count and dates in the line above already answer "how many, since
          when" for a reader who stops there, and this list stays a plain
          scroll rather than a second tap for the reader who wants every
          date. Each one now carries its own time, not only its own day —
          `dateStyle` alone read identically across a same-day run and told
          the reader nothing the count above had not already said. */}
      <Flex direction="column" gap="3">
        {state.rows.map((row, index) => (
          <Flex direction="column" gap="3" key={`${row.at}-${index}`}>
            {index > 0 && <Separator size="4" />}
            <Grid columns="1fr auto" gap="3" align="center">
              <Flex direction="column" gap="1" minWidth="0">
                <Text size="2" english>{row.text}</Text>
                <Text size="2" muted>
                  {rowTime(row.at)}
                </Text>
              </Flex>
              <MetaLabel>{t(`outcome.${outcomeKey(row.outcome)}`)}</MetaLabel>
            </Grid>
          </Flex>
        ))}
      </Flex>
    </Flex>
  );
}
