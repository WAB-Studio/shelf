"use client";

import NextLink from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";

import type { WordAnswer } from "@/lib/dictionary/lookup";
import { functionWordTranslation } from "@/lib/phrase/function-words";
import { Box, Button, Flex, Headword, Link, Separator, Spinner, TapTarget, Text } from "@/components/ui";
import { SenseList, SpeakButton, leadPronunciation } from "./sense-list";
import type { GeneratedTextState } from "./generated-text";
import type { NetworkAnswerState } from "./network-answer";

export type NoEntryPart = { token: string; answer: WordAnswer | null };

// RL-54's miss and RL-59's translation failure draw the same blocks below
// the title; only the title names which one happened, so both carry a reason.
export type NoEntryReason = "noEntry" | "translationFailed";

export type NoEntryState =
  | { kind: "words"; query: string; parts: NoEntryPart[]; reason: NoEntryReason }
  | { kind: "tooLong"; query: string; tokens: number }
  | { kind: "resolving"; query: string };

// Sixty answers are not an answer, and eight is already a lot to read on a
// bus: the rest folds into one line (docs/voyager/DESIGN.md "Settled").
const MAX_BLOCKS = 8;

// `search-screen.tsx`'s own query name: every door this screen opens is
// `/?q=<word>`.
const QUERY_PARAM = "q";

function wordHref(token: string): string {
  return `/?${QUERY_PARAM}=${encodeURIComponent(token)}`;
}

function hasHit(answer: WordAnswer | null): answer is WordAnswer {
  return answer !== null && (answer.exact !== null || answer.viaInflection.length > 0);
}

// docs/voyager/DESIGN.md "Viewport": stroke-width 1.75, round caps and
// joins, fill none — `sense-list.tsx` draws the same shape for its own
// headword's door; this file has no import onto that one to share it.
function ChevronGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

// A single word's block: SenseList's own headword and senses when the
// dictionary has one, its own heading and its own line — never SenseList's
// generic "not found" copy — when it does not, so the reader reads "tampoco"
// under the word that hit it and not a second "no tiene esa palabra" that
// already answered the phrase above it. The block that carries the
// breakdown's answer draws `compact`: translations alone, no IPA, no
// definition, no voice control (docs/voyager/DESIGN.md "A word block on
// `SinEntradaFrase` carries its translations alone").
function NoEntryWord({ part, t }: { part: NoEntryPart; t: ReturnType<typeof useTranslations> }) {
  if (!hasHit(part.answer)) {
    return (
      <Flex direction="column" gap="3">
        <Link asChild underline="always">
          <NextLink href={wordHref(part.token)}>
            <TapTarget align="center" gap="1">
              <Headword>{part.token}</Headword>
              <ChevronGlyph />
            </TapTarget>
          </NextLink>
        </Link>
        <Text size="3">{t("noEntry.wordMiss")}</Text>
      </Flex>
    );
  }
  const table = functionWordTranslation(part.token);
  if (table === null) {
    return <SenseList answer={part.answer} variant="compact" wordHref={wordHref(part.token)} />;
  }
  // RL-59: a function word leads with the table's translation, the
  // dictionary's own block following whole and muted
  // (docs/voyager/DESIGN.md `SinEntradaFraseFuncion`). `SenseList` draws its
  // exact headword itself, so it is hidden there and drawn here, above the
  // table line.
  const heading = part.answer.exact?.headword ?? part.token;
  return <FunctionWordBlock part={part} answer={part.answer} heading={heading} table={table} t={t} />;
}

// The dictionary block folds behind one ghost control; a word with no block
// of its own draws no control. `alone` is RL-59's word typed by itself: the
// headword is plain and carries the voice control, and the folded block is
// the dictionary's whole answer (IPA, definitions, example) instead of the
// breakdown's translations alone.
export function FunctionWordBlock({
  part,
  answer,
  heading,
  table,
  t,
  alone = false,
  generated,
  networkAnswer,
}: {
  part: NoEntryPart;
  answer: WordAnswer;
  heading: string;
  table: string;
  t: ReturnType<typeof useTranslations>;
  alone?: boolean;
  generated?: GeneratedTextState;
  networkAnswer?: NetworkAnswerState;
}) {
  const [open, setOpen] = useState(false);
  const tWord = useTranslations("word");
  const hit = hasHit(answer);
  return (
    <Flex direction="column" gap="3">
      {alone ? (
        <Flex align="center" gap="1">
          <Headword>{heading}</Headword>
          <SpeakButton headword={heading} ipa={answer.exact ? leadPronunciation(answer.exact.senses) : null} t={tWord} />
        </Flex>
      ) : (
        <Link asChild underline="always">
          <NextLink href={wordHref(part.token)}>
            <TapTarget align="center" gap="1">
              <Headword>{heading}</Headword>
              <ChevronGlyph />
            </TapTarget>
          </NextLink>
        </Link>
      )}
      <Text variant="translation">{table}</Text>
      {hit && (
        <Button
          variant="ghost"
          color="gray"
          size="2"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {t(open ? "noEntry.hideDictionary" : "noEntry.showDictionary")}
          <ChevronGlyph />
        </Button>
      )}
      {hit && open && (
        <Box muted>
          {alone ? (
            <SenseList
              answer={answer}
              showExactHeadword={false}
              showSpeaker={false}
              generated={generated}
              networkAnswer={networkAnswer}
            />
          ) : (
            <SenseList answer={answer} variant="compact" wordHref={wordHref(part.token)} showExactHeadword={false} />
          )}
        </Box>
      )}
    </Flex>
  );
}

// RL-54: the screen a typed word or a short phrase used to leave blank.
// Every branch draws something — that silence is the defect this replaces.
export function NoEntryAnswer({ state }: { state: NoEntryState }) {
  const t = useTranslations("search");

  if (state.kind === "resolving") {
    return (
      <Flex align="center" gap="2">
        <Spinner />
        <Text size="2" muted>
          {t("noEntry.resolving")}
        </Text>
      </Flex>
    );
  }

  if (state.kind === "tooLong") {
    return <Text size="3">{t("noEntry.tooLong", { count: state.tokens })}</Text>;
  }

  const shown = state.parts.slice(0, MAX_BLOCKS);
  const cut = state.parts.slice(MAX_BLOCKS);
  const remaining = cut.length;
  const titleKey = state.reason === "translationFailed" ? "noEntry.titleTranslationFailed" : "noEntry.title";

  return (
    <Flex direction="column" gap="4">
      <Text size="3">{t(titleKey, { query: state.query })}</Text>

      {shown.map((part, index) => (
        <Flex direction="column" gap="3" key={`${part.token}-${index}`}>
          {index > 0 && <Separator size="4" />}
          <NoEntryWord part={part} t={t} />
        </Flex>
      ))}

      {remaining > 0 && (
        <Flex direction="column" gap="3">
          <Separator size="4" />
          {/* Names every cut word, matching `SinEntradaFraseEnlaces`: the
              line wraps on a narrow phone rather than overflow it, checked
              against `docs/voyager/DESIGN.md`'s own 52-word worst case
              (`PHRASE_MAX_TOKENS` minus `MAX_BLOCKS`). One door, to the
              first of them — the same order the blocks above already read
              in. */}
          <Link asChild underline="always">
            <NextLink href={wordHref(cut[0].token)}>
              <TapTarget align="center" gap="1">
                <Text size="2">{t("noEntry.more", { count: remaining, words: cut.map((part) => part.token).join(", ") })}</Text>
                <ChevronGlyph />
              </TapTarget>
            </NextLink>
          </Link>
        </Flex>
      )}
    </Flex>
  );
}
