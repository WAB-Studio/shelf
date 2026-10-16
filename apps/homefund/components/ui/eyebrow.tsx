import { Text, type TextProps } from "@radix-ui/themes";

// A small caps label above what it names.
export function Eyebrow(props: Omit<TextProps, "style" | "className">) {
  return <Text {...(props as TextProps)} style={{ textTransform: "uppercase", letterSpacing: "0.06em" }} />;
}
