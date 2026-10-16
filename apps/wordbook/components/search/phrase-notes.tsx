"use client";

import { useTranslations } from "next-intl";

import { usePhraseNotes } from "@/lib/phrase/use-phrase-notes";
import { Flex, Live, Text } from "@/components/ui";

// The one leaf in this slice that asks for its own data (RL-46).
// `search-screen.tsx` owns every other request; mounting this only inside
// `PhraseAnswer`'s `done` branch is what keeps RNL-05 whole without
// teaching that file a request it does not otherwise make.
export function PhraseNotes({
  source,
  translation,
}: {
  source: string;
  translation: string;
}) {
  const t = useTranslations("phrase");
  const tLive = useTranslations("live");
  const result = usePhraseNotes(source, translation);

  if (result === null) {
    return (
      <>
        <Live />
        <Text size="2" muted>
          {t("notesPending")}
        </Text>
      </>
    );
  }

  // Zero notes is a valid answer (RL-46): the translation already replied,
  // and that silence is the screen as it stands today.
  if (result.notes.length === 0)
    return (
      <>
        <Live />
      </>
    );

  return (
    <>
      <Live>{tLive("notes", { count: result.notes.length })}</Live>
      <Flex direction="column" gap="3">
        <Text size="2" muted>
          {t("notesTitle")}
        </Text>
        {result.notes.map((note, index) => (
          <Flex direction="column" gap="1" key={`${note.term}-${index}`}>
            <Text size="2" weight="bold">
              {note.term}
            </Text>
            <Text size="2">{note.note}</Text>
          </Flex>
        ))}
      </Flex>
    </>
  );
}
