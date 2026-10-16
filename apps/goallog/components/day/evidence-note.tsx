import { Separator, Text } from "@/components/ui";

// RNP-04: the source that could not be read, said once in a status block
// between two rules — never a red, never an error page, never a blank day.
export function EvidenceNote({ title, body }: { title: string; body: string }) {
  return (
    <>
      <Separator />
      <Text as="div" role="status">
        <Text as="p" variant="name">
          {title}
        </Text>
        <Text as="p" variant="meta" tone="muted">
          {body}
        </Text>
      </Text>
      <Separator />
    </>
  );
}
