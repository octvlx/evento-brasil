import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "argued-wrapped-honors-qty.trycloudflare.com",
    "radar-county-immunology-dimensions.trycloudflare.com",
    "polar-difficulties-venue-exploring.trycloudflare.com",
  ],
  // Authorization codes/state must not appear in Next's default dev request logs.
  logging: { incomingRequests: { ignore: [/\/api\/mercadopago\/callback(?:[?]|$)/] } },
  // A suíte isolada não compartilha cache nem lock com o dev do usuário.
  distDir: process.env.E2E_ISOLATED === "1" ? ".next/e2e" : ".next",
  typescript: process.env.E2E_ISOLATED === "1" ? { tsconfigPath: ".next/tsconfig.e2e.json" } : undefined,
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
