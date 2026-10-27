"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Compass, Home, Ticket, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/", label: "Início", icon: Home, match: (p: string) => p === "/" },
  { href: "/eventos", label: "Explorar", icon: Compass, match: (p: string) => p.startsWith("/eventos") || p.startsWith("/cidades") },
  { href: "/meus-ingressos", label: "Ingressos", icon: Ticket, match: (p: string) => p.startsWith("/meus-ingressos") || p.startsWith("/ingressos") },
  { href: "/minha-conta", label: "Conta", icon: UserRound, match: (p: string) => p.startsWith("/minha-conta") || p.startsWith("/entrar") },
];

export function MobileNav() {
  const pathname = usePathname();
  if (pathname.startsWith("/check-in")) return null;
  return (
    <nav aria-label="Navegação principal" className="fixed inset-x-0 bottom-0 z-40 print:hidden border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <ul className="grid grid-cols-4">
        {ITEMS.map(({ href, label, icon: Icon, match }) => {
          const active = match(pathname);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn("flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold", active ? "text-secondary" : "text-muted-foreground")}
              >
                <Icon className="size-5" aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
