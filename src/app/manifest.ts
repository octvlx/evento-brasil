import type { MetadataRoute } from "next";
import { BRAND, BRAND_COLORS } from "@/lib/brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.name,
    description: BRAND.description,
    lang: "pt-BR",
    start_url: "/",
    display: "standalone",
    background_color: BRAND_COLORS.paper,
    theme_color: BRAND_COLORS.night,
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
