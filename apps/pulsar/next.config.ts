import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { clockOverride } from "./lib/zone";

// The test-only fault seam (`lib/evidence/fault-seam.ts`) never reaches a
// Vercel build: the code already ignores it there, and this refuses the build.
if (process.env.VERCEL && process.env.PULSAR_FAULT_SEAM) {
  throw new Error("PULSAR_FAULT_SEAM is set on Vercel: the fault seam is test-only; unset it");
}

// A pinned clock off the local stack refuses the build and the server's boot.
clockOverride(process.env);

const nextConfig: NextConfig = {
  // The dev badge defaults to bottom-left, over the desktop rail's face toggle.
  devIndicators: { position: "bottom-right" },
  // Every response, so no page of the app is framed by another site (the
  // consent screen's «Permitir» above all). Only `frame-ancestors`: this is
  // not a full CSP.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

export default withNextIntl(nextConfig);
