import type { ReactNode } from "react";
import { Flex, type FlexProps } from "@radix-ui/themes";

// A link's content has no intrinsic control height, unlike a Radix control
// sized "2"; this pins the same 44px floor onto whatever sits inside a link.
export function TapTarget({
  align,
  justify,
  gap,
  px,
  width,
  children,
}: Pick<FlexProps, "align" | "justify" | "gap" | "px" | "width"> & {
  children?: ReactNode;
}) {
  return (
    <Flex
      as="span"
      align={align}
      justify={justify}
      gap={gap}
      px={px}
      width={width}
      minWidth="44px"
      minHeight="44px"
    >
      {children}
    </Flex>
  );
}
