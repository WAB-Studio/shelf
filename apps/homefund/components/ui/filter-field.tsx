"use client";

import { useId, type ReactNode } from "react";
import { Flex, Text } from "@radix-ui/themes";

/**
 * One labelled control inside a filter panel. The id travels to the caller
 * rather than onto a cloned child: a Select carries it on its trigger, which is
 * not the element this receives.
 */
export function FilterField({
  label,
  children,
}: {
  label: string;
  children: (controlId: string) => ReactNode;
}) {
  const controlId = useId();

  return (
    <Flex direction="column" gap="1" flexGrow="1" minWidth="0">
      <Text
        as="label"
        htmlFor={controlId}
        size="2"
        weight="medium"
        color="gray"
      >
        {label}
      </Text>
      {children(controlId)}
    </Flex>
  );
}
