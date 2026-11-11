import { Flex, Text } from "@radix-ui/themes";

import { Disc } from "./disc";
import { Figure } from "./figure";

/**
 * A dated row's tile: the day over its abbreviated month, both already formatted by the caller
 * in the active locale.
 */
export function DateTile({ day, month }: { day: string; month: string }) {
  return (
    <Disc size={44} radius={14} surface="var(--accent-a3)">
      <Flex direction="column" align="center" justify="center">
        <Figure size="2" weight="bold" tight>
          {day}
        </Figure>
        <Text size="1" color="gray">
          {month}
        </Text>
      </Flex>
    </Disc>
  );
}
