import { Page, Skeleton } from "@/components/ui";

// `ArmazonCargando.dc.html`: plain blocks in the line colour, no shimmer.
export default function Loading() {
  return (
    <Page>
      <Skeleton shape="title" width="half" />
      <Skeleton shape="label" width="short" />
      <Skeleton shape="name" />
      <Skeleton shape="name" />
    </Page>
  );
}
