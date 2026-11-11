import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { SplashImage } from "@/components/ui/splash-image";
import { SPLASHES } from "@/lib/splash";
import { PAGE_BACKGROUND } from "@/lib/theme";

// Drawn once at build time: the app's mark, a third of the screen's width, on the page's background.
export const dynamic = "force-static";
export const dynamicParams = false;

// One read for every image the build draws.
const markSrc = readFile(join(process.cwd(), "public/icons/icon.svg")).then(
  (svg) => `data:image/svg+xml;base64,${svg.toString("base64")}`,
);

export function generateStaticParams() {
  return SPLASHES.map(({ name }) => ({ image: name }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ image: string }> },
): Promise<Response> {
  const { image } = await params;
  const splash = SPLASHES.find(({ name }) => name === image);
  if (!splash) return new Response(null, { status: 404 });

  const width = splash.width * splash.ratio;
  const height = splash.height * splash.ratio;

  return new ImageResponse(
    <SplashImage
      background={PAGE_BACKGROUND[splash.theme]}
      markSrc={await markSrc}
      markSize={Math.round(width / 3)}
    />,
    { width, height },
  );
}
