import { ImageResponse } from "next/og";

import { BrandCard } from "@/lib/brand-image";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "TimeLog";

export default function OpenGraphImage() {
  return new ImageResponse(<BrandCard />, size);
}
