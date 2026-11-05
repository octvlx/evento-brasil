import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Cabeçalhos de segurança (docs/production-readiness.md). A CSP é sem nonce: nonce
// exigiria renderização dinâmica em todas as páginas e é incompatível com o
// pré-render parcial (cacheComponents/partialPrefetching) — ver o guia de CSP do
// Next 16. O site não carrega script de terceiros; 'unsafe-inline' cobre os scripts
// inline do próprio Next. 'unsafe-eval' só no dev (React Refresh).
export const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Imagens de evento podem vir do armazenamento de objetos (https); QR do PIX é data:.
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  // "Conectar Mercado Pago" é um formulário que redireciona para a autorização OAuth.
  "form-action 'self' https://auth.mercadopago.com.br https://auth.mercadopago.com",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

export const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Câmera só para o leitor de QR do check-in (mesma origem); o resto desligado.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // HSTS só fora do dev: em produção o site é servido apenas por HTTPS.
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  // Túneis de desenvolvimento: os rápidos da Cloudflare mudam de nome a cada execução e o
  // domínio fixo gratuito do ngrok fica em *.ngrok-free.dev; o coringa cobre todos.
  // Só o hostname é comparado (sem esquema nem porta); localhost já é permitido por padrão.
  allowedDevOrigins: ["*.trycloudflare.com", "*.ngrok-free.dev"],
  // Authorization codes/state must not appear in Next's default dev request logs.
  logging: { incomingRequests: { ignore: [/\/api\/mercadopago\/callback(?:[?]|$)/] } },
  // A suíte isolada não compartilha cache nem lock com o dev do usuário.
  distDir: process.env.E2E_ISOLATED === "1" ? ".next/e2e" : ".next",
  typescript: process.env.E2E_ISOLATED === "1" ? { tsconfigPath: ".next/tsconfig.e2e.json" } : undefined,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
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
