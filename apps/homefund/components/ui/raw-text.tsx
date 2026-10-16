import { Text, type TextProps } from "@radix-ui/themes";

// Text a person did not write for this screen (an SMS, a pasted sample): its
// line breaks stay and a token with no space still wraps inside the card.
export function RawText(props: Omit<TextProps, "style" | "className">) {
  return <Text {...(props as TextProps)} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} />;
}
