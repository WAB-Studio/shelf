"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { previewTranslations } from "@/lib/log/translation-line";
import { Flex, Link, TapTarget, Text } from "@/components/ui";

// The entry's own line shows up to four translations before «ver N más».
const LEAD_SHOWN = 4;

// A word's translations on one comma-separated line, the first three and a «ver N más» for the
// rest (RL-82). The same line serves the word's answer and its history.
export function TranslationList({
  items: rawItems,
  muted,
  lead,
  centred,
}: {
  items: readonly string[];
  muted?: boolean;
  // The first translation set large, as the entry's main one; the rest follow on the same line after « · », muted.
  lead?: boolean;
  // Centres the line and its «ver N más» under it, for a card whose content is centred.
  centred?: boolean;
}) {
  const t = useTranslations("word");
  // The entry's line carries no trailing «...» or «…» a gloss may end on in the data, and no gloss twice.
  const items = lead
    ? [...new Set(rawItems.map((item) => item.replace(/\s*(\.{3}|…)$/, "").trim()).filter((item) => item !== ""))]
    : rawItems;
  const [open, setOpen] = useState(false);
  // One translation behind «ver 1 más» is no saving: the entry's line folds from two.
  const limit = lead && items.length > LEAD_SHOWN + 1 ? LEAD_SHOWN : lead ? items.length : undefined;
  const { shown, hidden } = previewTranslations(items, limit);
  const line = open ? items : shown;
  const [first, ...rest] = line;

  return (
    <Flex direction="column" gap="1" align={centred ? "center" : "start"}>
      <Text variant="translation" muted={muted}>
        {lead && first !== undefined ? (
          <>
            <Text variant="lead">{first}</Text>
            {rest.length > 0 && <Text muted>{` · ${rest.join(", ")}`}</Text>}
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
