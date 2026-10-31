"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { previewTranslations } from "@/lib/log/translation-line";
import { Flex, Link, TapTarget, Text } from "@/components/ui";

// A word's translations on one comma-separated line, the first three and a «ver N más» for the
// rest (RL-79). The same line serves the word's answer, its row in the record and its history.
export function TranslationList({
  items,
  muted,
  lead,
}: {
  items: readonly string[];
  muted?: boolean;
  // The first translation set large, as the entry's main one; the rest follow on the same line.
  lead?: boolean;
}) {
  const t = useTranslations("word");
  const [open, setOpen] = useState(false);
  const { shown, hidden } = previewTranslations(items);
  const line = open ? items : shown;
  const [first, ...rest] = line;

  return (
    <Flex direction="column" gap="1" align="start">
      <Text variant="translation" muted={muted}>
        {lead && first !== undefined ? (
          <>
            <Text variant="lead">{rest.length > 0 ? `${first},` : first}</Text>
            {rest.length > 0 && ` ${rest.join(", ")}`}
          </>
        ) : (
          line.join(", ")
        )}
      </Text>
      {hidden > 0 && (
        <Link asChild underline="always" muted>
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
            <TapTarget align="center" px="1">
              <Text size="2">{open ? t("translationsLess") : t("translationsMore", { count: hidden })}</Text>
            </TapTarget>
          </button>
        </Link>
      )}
    </Flex>
  );
}
