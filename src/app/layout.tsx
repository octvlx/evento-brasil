import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Bricolage_Grotesque, Plus_Jakarta_Sans } from "next/font/google";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { MobileNav } from "@/components/site/mobile-nav";
import { ServiceWorkerRegister } from "@/components/site/sw-register";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"] });
const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"], weight: ["600", "700", "800"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
  title: { default: "Evento Brasil — ingressos para shows, festas, teatro e mais", template: "%s | Evento Brasil" },
  description: "Descubra eventos perto de você em todo o Brasil e compre ingressos com PIX ou cartão.",
  applicationName: "Evento Brasil",
  openGraph: { type: "website", locale: "pt_BR", siteName: "Evento Brasil" },
  appleWebApp: { capable: true, title: "Evento Brasil", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#312e81",
  colorScheme: "light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${jakarta.variable} ${bricolage.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-card focus:px-4 focus:py-2">
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
        </Suspense>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
