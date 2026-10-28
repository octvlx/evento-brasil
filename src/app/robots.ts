import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/checkout",
        "/pedido",
        "/ingressos",
        "/meus-ingressos",
        "/meus-pedidos",
        "/minha-conta",
        "/entrar",
        "/registrar",
        // "/organizador/" e "$" para não bloquear os perfis públicos em /organizadores/
        "/organizador/",
        "/organizador$",
        "/admin",
        "/check-in",
        "/convite",
        "/api",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
