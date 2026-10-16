import { WordHistory } from "@/components/log/word-history";
import { Page } from "@/components/ui";

// A dynamic segment arrives percent-encoded, not decoded (measured against
// this Next version's own production build): a multi-word or accented
// `normalised` never matches its own IndexedDB row until this runs. A
// hand-typed URL can still carry a malformed escape (`100%`), which
// `decodeURIComponent` throws on — reading the raw segment as the word
// itself is the only sense to make of what the person typed.
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// Server-rendered shell alone: the segment only names which word this is,
// and everything the word needs — its own log, its own dictionary answer —
// is a client-side read `WordHistory` owns. `measure="full"`: this is a
// list and a back link, not prose.
export default async function PalabraHistorialPage(props: PageProps<"/registro/[palabra]">) {
  const { palabra } = await props.params;

  return (
    <Page measure="full">
      <WordHistory normalised={decodeSegment(palabra)} />
    </Page>
  );
}
