import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Túneis rápidos da Cloudflare mudam de nome a cada execução: o coringa cobre todos.
  // Só o hostname é comparado (sem esquema nem porta); localhost já é permitido por padrão.
  allowedDevOrigins: ["*.trycloudflare.com"],
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
