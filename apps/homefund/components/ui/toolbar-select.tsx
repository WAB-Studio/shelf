"use client";

import type { ReactNode } from "react";
import { Box, Flex, Select, Text } from "@radix-ui/themes";
import type { Responsive } from "@radix-ui/themes/props";

// Stated once, here: the trigger holds this width whatever the value, icon or pending state.
const TRIGGER_WIDTH = { initial: "40px", sm: "9.5rem" };

export function ToolbarSelect({
  value,
  onValueChange,
  disabled,
  label,
  icon,
  text,
  children,
  width = TRIGGER_WIDTH,
}: {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  icon: ReactNode;
  text: string;
  children?: ReactNode;
  width?: Responsive<string>;
}) {
  return (
    <Select.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <Box width={width} asChild>
        <Select.Trigger aria-label={label}>
          {/* Fixed content, not the selected item's text: the trigger's width holds. */}
          <Flex as="span" align="center" gap="2">
            {icon}
            <Box asChild display={{ initial: "none", sm: "inline" }}>
              <Text truncate>{text}</Text>
            </Box>
          </Flex>
        </Select.Trigger>
      </Box>
      {children && (
        <Select.Content position="popper">{children}</Select.Content>
      )}
    </Select.Root>
  );
}
