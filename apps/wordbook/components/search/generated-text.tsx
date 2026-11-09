import { useTranslations } from "next-intl";

import { Box, Flex, Separator, Text } from "@/components/ui";
import type { WordText } from "@/lib/word/protocol";

// The three shapes module 9's hook resolves a word's decoration to. State
// in, DOM out: this file makes no request of its own.
export type GeneratedTextState =
  | { kind: "pending" }
  | { kind: "resolved"; text: WordText }
  | { kind: "absent" };

// A generated definition and translations, marked apart from the dictionary's own
// (docs/wordbook/DESIGN.md "Generated text is marked «generada»" — a model
// mis-defined `abies` in a test of twelve, and the reader has no way to
// doubt a line that looks like every other one).
export function GeneratedText({ state }: { state: GeneratedTextState }) {
  const t = useTranslations("word");

  // `PalabraSinDefinicionOscuroMovil`: no connection, no result, or the
  // daily ceiling reached all read as exactly today's screen — no hairline,
  // no hole, no apology. This is the case RL-41 decorates under RL-35.
  if (state.kind === "absent") return null;

  if (state.kind === "pending") {
    // `PalabraGenerandoOscuroMovil`: the answer above is already whole and
    // waits for nobody (RL-35); this block only holds its own place, no
    // spinner and no «generada» tag — there is nothing generated yet to mark.
    return (
      <Flex direction="column" data-generated-block="">
        <Separator size="4" />
        <Box pt="2" pb="1">
          <Text variant="pendingHint" muted>
            {t("definitionGenerating")}
          </Text>
        </Box>
        <Separator size="4" />
      </Flex>
    );
  }

  const { text } = state;
  // RL-41 / RL-45: the route answers a definition and network translations
  // only; it writes no example. Either is null for an entry that needs none,
  // and an answer with neither draws nothing.
  const hasDefinition = text.definition !== null;
  const hasNetworkTranslations = text.translations !== null && text.translations.length > 0;
  if (!hasDefinition && !hasNetworkTranslations) return null;

  return (
    <Flex direction="column" data-generated-block="">
      <Separator size="4" />
      <Box pt="2" pb="1">
        <Flex direction="column" gap="2">
          {hasDefinition && (
            <Flex direction="column" gap="2">
              <Flex align="center" gap="2">
                <Text variant="definitionLabel" muted>
                  {t("definitionGenerated")}
                </Text>
                <Text variant="generatedMark" muted="quietest">
                  {t("generatedMark")}
                </Text>
              </Flex>
              <Text variant="generatedProse" muted english>
                {text.definition}
              </Text>
            </Flex>
          )}
          {hasNetworkTranslations && (
            // Added under the dictionary's own translations, inside the same
            // sense group (docs/wordbook/DESIGN.md "A dictionary answer that
            // is thin"), never inside `SenseGroup` itself — this block only
            // ever sits below what `sense-list.tsx` already drew.
            <Flex direction="column" gap="2" data-network-translations="">
              <Flex align="center" gap="2">
                <Text variant="definitionLabel" muted>
                  {t("networkTranslations")}
                </Text>
                <Text variant="generatedMark" muted="quietest">
                  {t("networkMark")}
                </Text>
              </Flex>
              <Flex direction="column" gap="1">
                {text.translations?.map((translation) => (
                  <Text variant="translation" key={translation}>
                    {translation}
                  </Text>
                ))}
              </Flex>
            </Flex>
          )}
        </Flex>
      </Box>
      <Separator size="4" />
    </Flex>
  );
}
