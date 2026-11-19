import { ReviewSession } from "@/components/review/review-session";
import { Page } from "@/components/ui";

// RL-68: the review reads the record and its cards off the device alone, so the server draws the shell.
// The title is the session's own: it shares its line with the progress.
export default function ReviewPage() {
  return (
    <Page measure="session">
      <ReviewSession />
    </Page>
  );
}
