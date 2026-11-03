"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Search, X } from "lucide-react";
import { SmartEventSearch } from "./smart-event-search";

// Áreas com layout próprio: sem a busca pública no topo.
const HIDDEN = ["/admin", "/organizador", "/checkout", "/check-in", "/pedido"];

export const headerSearchHidden = (pathname: string) => HIDDEN.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/** Campo da busca inteligente no header (desktop). */
export function HeaderSearch() {
  const pathname = usePathname();
  if (headerSearchHidden(pathname)) return null;
  return <SmartEventSearch variant="header" label="Buscar eventos" placeholder={PLACEHOLDER} className="ml-2 hidden max-w-xl flex-1 md:block lg:ml-6" />;
}

/** Celular: lupa ao lado da conta que abre a busca logo abaixo do header. */
export function HeaderSearchMobile() {
  const pathname = usePathname();
  const [openFor, setOpenFor] = useState<string | null>(null);
  if (headerSearchHidden(pathname)) return null;
  // Fecha sozinho ao mudar de página.
  const open = openFor === pathname;
  return (
    <>
      <button
        type="button"
        className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
        aria-label={open ? "Fechar busca" : "Abrir busca"}
        aria-expanded={open}
        aria-controls="busca-mobile"
        onClick={() => setOpenFor(open ? null : pathname)}
      >
        {open ? <X className="size-5" aria-hidden /> : <Search className="size-5" aria-hidden />}
      </button>
      {open && (
        <div id="busca-mobile" className="absolute inset-x-0 top-full border-b border-border bg-background px-4 py-3 shadow-lg md:hidden">
          <SmartEventSearch variant="header" label="Buscar eventos" placeholder={PLACEHOLDER} autoFocus onNavigate={() => setOpenFor(null)} />
        </div>
      )}
    </>
  );
}

const PLACEHOLDER = "Buscar eventos, artistas, cidades ou locais...";
