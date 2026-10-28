import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
