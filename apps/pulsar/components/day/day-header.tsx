import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Face, Flex, ScreenHeader, Text, TextLink, ThemeToggle } from "@/components/ui";

type HeaderLink = { href: string; label: string };

// The day's own header (`ArmazonEncabezado.dc.html` case 4,
// `DiaPasadoEscritorio.dc.html`): the shared `ScreenHeader`, its controls row
// holding the step back to the day before. Today's title is its `h1`, with the
// date as its eyebrow and the light/dark control at its end (RNP-08):
// docs/pulsar/DESIGN.md "Decisions taken here" puts it here and nowhere else —
// there is no `/cuenta` screen in this app. A past day's date is its `h1`, and
// «volver a hoy» takes the control's place.
export function DayHeader({
  date,
  title,
  back,
  forward,
  limitNote,
  toToday,
  theme,
  tally,
  ended,
}: {
  date: string;
  title?: string;
  // Absent on the oldest day a fact may still name (`PAST_DAY_LIMIT`).
  back?: HeaderLink;
  // A past day's step to the day after; the last one before today lands on Hoy.
  forward?: HeaderLink;
  // Said in the step's place on that oldest day: why there is no way further.
  limitNote?: string;
  toToday?: HeaderLink;
  theme?: { toLightLabel: string; toDarkLabel: string };
  // «hechos 3 de 5»: a sentence with its figures in mono, under the title (a
  // past day's, under its date), absent when the day counts nothing.
  tally?: ReactNode;
  // One quiet line per goal that ended this week, under the title.
  ended?: { id: string; text: string; href: string; see: string; seeLabel: string }[];
}) {
  // A past day (`DiaPasadoPasos.dc.html`): both steps are words with their
  // chevron, «volver a hoy» pushed to the end.
  const controls = title === undefined ? (
    <Flex align="center" gap="5">
      {back ? (
        <TextLink href={back.href}>
          <Flex as="span" align="center" gap="1">
            <ChevronLeft size={16} aria-hidden />
            {back.label}
          </Flex>
        </TextLink>
      ) : limitNote ? (
        <Flex width="14px" flexShrink="0" aria-hidden />
      ) : null}
      {forward ? (
        <TextLink href={forward.href}>
          <Flex as="span" align="center" gap="1">
            {forward.label}
            <ChevronRight size={16} aria-hidden />
          </Flex>
        </TextLink>
      ) : null}
      {toToday ? (
        <Flex ml="auto">
          <TextLink href={toToday.href}>{toToday.label}</TextLink>
        </Flex>
      ) : null}
    </Flex>
  ) : (
    <Flex justify="end" align="center" gap="5">
      {back ? (
        <TextLink href={back.href}>
          <Flex as="span" align="center" gap="1">
            <ChevronLeft size={16} aria-hidden />
            {back.label}
          </Flex>
        </TextLink>
      ) : limitNote ? (
        <Flex width="14px" flexShrink="0" aria-hidden />
      ) : null}
      {toToday ? <TextLink href={toToday.href}>{toToday.label}</TextLink> : null}
      {theme ? (
        <Face on="phone">
          <ThemeToggle toLightLabel={theme.toLightLabel} toDarkLabel={theme.toDarkLabel} />
        </Face>
      ) : null}
    </Flex>
  );

  return (
    <>
      <ScreenHeader
        chat
        title={title ?? date}
        eyebrow={title ? date : undefined}
        controls={controls}
        meta={tally}
        metaVariant="sentence"
      />
      {limitNote ? (
        <Text as="p" variant="sentence">
          {limitNote}
        </Text>
      ) : null}
      {ended && ended.length > 0 ? (
        <Flex direction="column" gap="1">
          {ended.map((line) => (
            <Flex key={line.id} align="center" gap="3" wrap="wrap">
              <Text as="p" variant="sentence">
                {line.text}
              </Text>
              <TextLink href={line.href} aria-label={line.seeLabel}>
                {line.see}
              </TextLink>
            </Flex>
          ))}
        </Flex>
      ) : null}
    </>
  );
}
