import { Page, Panel, ScreenHeaderSkeleton, Skeleton, Split } from "@/components/ui";

// `ArmazonCargando.dc.html` and its 1440 face: the header already stands where
// the real one lands, then plain blocks — one shape for every route, no
// shimmer. A log that is still arriving says so by standing still.
export default function Loading() {
  return (
    <Page width="full">
      <ScreenHeaderSkeleton />
      <Split
        main={
          <Panel>
            <Skeleton shape="label" width="short" />
            <Skeleton shape="name" />
            <Skeleton shape="name" />
            <Skeleton shape="name" />
          </Panel>
        }
        after={
          <Panel>
            <Skeleton shape="label" width="short" />
            <Skeleton shape="name" />
            <Skeleton shape="name" />
          </Panel>
        }
      />
    </Page>
  );
}
