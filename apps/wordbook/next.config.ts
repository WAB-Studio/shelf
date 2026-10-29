import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Inlined by DefinePlugin into every bundle, server included, so
  // `app/layout.tsx`'s own check on it folds to a literal `false` and the
  // branch it guards drops out of a build where the variable is unset.
  env: {
    VOYAGER_E2E_HOOKS: process.env.VOYAGER_E2E_HOOKS ?? "",
  },
  async headers() {
    return [
      {
        // No `script-src`: a script policy needs a nonce per request, which
        // forces dynamic rendering and breaks the static offline shell.
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // `public/` is served with `max-age=0` by default, so every open would
        // re-validate 8.2 MB — the opposite of an app that answers offline. The
        // asset's filename carries its edition, so a changed dictionary is a
        // changed URL and this copy is never stale.
        source: "/dictionary/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        // The worker is how a new shell reaches a device that already has one;
        // cached, it would keep serving the old shell forever.
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
        ],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

export default withNextIntl(nextConfig);
