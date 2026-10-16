import { Heading, Text, type HeadingProps, type TextProps } from "@radix-ui/themes";

type FigureProps = (
  | ({ as?: "span" | "div" | "p" | "label" } & Omit<TextProps, "as">)
  | ({ as: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" } & Omit<HeadingProps, "as">)
) & {
  // Holds the figure to one line.
  nowrap?: boolean;
  // Sets the line height to one, for a figure stacked over a caption in a tile.
  tight?: boolean;
};

// A number that sits in a column: tabular numerals so digits line up row over row.
export function Figure({ nowrap, tight, ...props }: FigureProps) {
  const style = {
    fontVariantNumeric: "tabular-nums",
    ...(nowrap ? { whiteSpace: "nowrap" as const } : null),
    ...(tight ? { lineHeight: 1 } : null),
  };

  if (props.as !== undefined && props.as.startsWith("h")) {
    return <Heading {...(props as HeadingProps)} style={style} />;
  }
  return <Text {...(props as TextProps)} style={style} />;
}
