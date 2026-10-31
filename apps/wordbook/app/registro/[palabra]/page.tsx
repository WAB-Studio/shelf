import { WordHistory } from "@/components/log/word-history";
import { Page } from "@/components/ui";

// Server-rendered shell alone: the word comes off the address in
// `WordHistory`, and everything it needs — its own log, its own dictionary
// answer — is a client-side read. `measure="panels"`: this is a list and a back
// link, not prose.
export default function PalabraHistorialPage() {
  return (
    <Page measure="panels">
      <WordHistory />
    </Page>
  );
}
