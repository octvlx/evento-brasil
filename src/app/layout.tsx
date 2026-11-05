import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Plus_Jakarta_Sans, Unbounded } from "next/font/google";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { NavigationTracker } from "@/components/site/back-button";
import { MobileNav } from "@/components/site/mobile-nav";
import { ServiceWorkerRegister } from "@/components/site/sw-register";
import { BRAND, BRAND_COLORS } from "@/lib/brand";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"] });
// Fonte da marca: larga, com cara de cartaz. Só em logotipo e títulos grandes.
const unbounded = Unbounded({ variable: "--font-unbounded", subsets: ["latin"], weight: ["600", "700", "800"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
  title: { default: `${BRAND.name} — ${BRAND.tagline.toLowerCase()}`, template: `%s | ${BRAND.name}` },
  description: BRAND.description,
  applicationName: BRAND.name,
  openGraph: { type: "website", locale: "pt_BR", siteName: BRAND.name },
  twitter: { card: "summary_large_image" },
  appleWebApp: { capable: true, title: BRAND.name, statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: BRAND_COLORS.night,
  colorScheme: "light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${jakarta.variable} ${unbounded.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-accent-foreground">
          Pular para o conteúdo
        </a>
        <SiteHeader />
        <main id="conteudo" className="flex-1">
          {children}
        </main>
        <SiteFooter />
        {/* usePathname é dado de runtime: precisa de Suspense com Cache Components. */}
        <Suspense fallback={null}>
          <MobileNav />
          <NavigationTracker />
        </Suspense>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
