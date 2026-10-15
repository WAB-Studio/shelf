import { useTranslations } from "next-intl";

import { Button, Flex, Grid, TapTarget, Text, VisuallyHidden } from "@/components/ui";

// Headwords that begin with the string being typed, offered while it is
// still being treated as a word (RL-18). Silent when there is nothing to
// offer, so an empty prefix never leaves a hollow list on the screen.
export function Suggestions({
  items,
  onPick,
}: {
  items: readonly string[];
  onPick: (headword: string) => void;
}) {
  const t = useTranslations("word");

  if (items.length === 0) return null;

  return (
    <Flex direction="column" gap="1">
      <VisuallyHidden>{t("suggestions")}</VisuallyHidden>
      {items.map((item) => (
        <TapTarget key={item} width="100%">
          {/* Button's own flex-shrink is 0, so it never yields to a flex
              row; a single-column grid track sized minmax(0, 1fr) clamps it
              to the row's width regardless, which real headwords past 80
              characters with no space to break on need to fit at all. */}
          <Grid width="100%">
            <Button variant="ghost" tap onClick={() => onPick(item)}>
              <Text truncate serif>
                {item}
              </Text>
            </Button>
          </Grid>
        </TapTarget>
      ))}
    </Flex>
  );
}
