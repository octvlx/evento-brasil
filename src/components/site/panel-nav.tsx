"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Menu dos painéis (organizador e admin) com o item da página atual marcado
 * (aria-current + destaque). A raiz do painel só fica ativa na própria página.
 */
export function PanelNavLinks({ items, root }: { items: [string, string][]; root: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Menu do painel" className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0">
      {items.map(([href, label]) => {
        const active = href === root ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-xl px-3 py-2 text-sm font-semibold transition-colors",
              active ? "bg-night text-white lg:shadow-card" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {active && <span className="mr-2 inline-block size-1.5 rounded-full bg-lime align-middle" aria-hidden />}
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
