import type { ReactNode } from "react";
import { Flex, type FlexProps } from "@radix-ui/themes";

// A link's content has no intrinsic control height, unlike a Radix control
// sized "2"; this pins the 44px floor onto whatever sits inside a link.
export function TapTarget({
  align,
  justify,
  direction,
  gap,
  px,
  width,
  children,
}: Pick<FlexProps, "align" | "justify" | "direction" | "gap" | "px" | "width"> & {
  children?: ReactNode;
}) {
  const floor = "44px";
  return (
    <Flex
      as="span"
      align={align}
      justify={justify}
      direction={direction}
      gap={gap}
      px={px}
      width={width}
      minWidth={floor}
      minHeight={floor}
    >
      {children}
    </Flex>
  );
}
