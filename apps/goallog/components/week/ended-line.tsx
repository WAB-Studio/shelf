import { Flex, Text, TextLink } from "@/components/ui";

// «terminó el miércoles 23 · ver», under a goal's name (`SemanaMetaTerminada.dc.html`).
export function EndedLine({
  text,
  href,
  see,
  seeLabel,
}: {
  text: string;
  href: string;
  see: string;
  seeLabel: string;
}) {
  return (
    <Flex align="center" gap="2" wrap="wrap">
      <Text as="p" variant="sentence">
        {text}
      </Text>
      <TextLink href={href} aria-label={seeLabel}>
        {see}
      </TextLink>
    </Flex>
  );
}
