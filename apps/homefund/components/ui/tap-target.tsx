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
  flow = false,
  children,
}: Pick<FlexProps, "align" | "justify" | "gap" | "px" | "width"> & {
  // Reads the content as one sentence that wraps as text, not as a row of columns.
  flow?: boolean;
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
      {flow ? <span>{children}</span> : children}
    </Flex>
  );
}
