import { Page } from "@/components/ui";
import { SearchScreen } from "@/components/search/search-screen";

// Server-rendered shell alone: the box, the worker and every promise it
// answers with belong to the client component this mounts.
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  // A lookup has a URL (`/?q=book`): the query name this route answers to,
  // read once so a cold open needs no typing to reach the same answer.
  const { q } = await searchParams;
  const initialQuery = Array.isArray(q) ? q[0] : q;

  return (
    <Page>
      <SearchScreen initialQuery={initialQuery} />
    </Page>
  );
}
