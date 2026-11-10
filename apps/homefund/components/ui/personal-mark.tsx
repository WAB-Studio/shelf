import { User } from "lucide-react";

import { Flex, Text } from "@radix-ui/themes";

// The mark a person's own account or category wears where it stands beside the
// fund's: a glyph, never a suffix on the name. The caller passes the word it
// stands for so a reader announces it. `showLabel` writes the word beside the
// glyph, as another member's row does with its owner's name.
export function PersonalMark({
  label,
  showLabel = false,
}: {
  label: string;
  showLabel?: boolean;
}) {
  const glyph = (
    <User
      size={13}
      strokeWidth={2.2}
      role="img"
      aria-label={label}
      color="var(--gray-10)"
    />
  );

  if (!showLabel) return glyph;

  return (
    <Flex as="span" align="center" gap="1">
      {glyph}
      <Text size="1" color="gray" truncate>
        {label}
      </Text>
    </Flex>
  );
}
