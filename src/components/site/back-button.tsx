"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

const KEY = "eb_landing";
const INTERNAL = "(interna)";

const here = () => `${window.location.pathname}${window.location.search}`;

/**
 * Guarda, uma vez por aba, a página por onde a pessoa entrou no site. Recarregar
 * não muda a entrada. Chegou por link do próprio site: há histórico nosso antes.
 */
export function NavigationTracker() {
  useEffect(() => {
    try {
      if (sessionStorage.getItem(KEY) !== null) return;
      const internal = !!document.referrer && new URL(document.referrer).origin === window.location.origin;
      sessionStorage.setItem(KEY, internal ? INTERNAL : here());
    } catch {
      // Armazenamento bloqueado: o Voltar cai na home, que é o seguro.
    }
  }, []);
  return null;
}

/** Há página anterior do próprio site no histórico desta aba? */
function canGoBack() {
  try {
    const landing = sessionStorage.getItem(KEY);
    return window.history.length > 1 && (landing === INTERNAL || (landing !== null && landing !== here()));
  } catch {
    return false;
  }
}

/**
 * Volta para a página anterior do site. Na página de entrada da aba (acesso
 * direto ou vindo de outro site), vai para a home em vez de sair do Evento Brasil.
 */
export function BackButton({ className }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => (canGoBack() ? router.back() : router.push("/"))}
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      <ArrowLeft className="size-4" aria-hidden /> Voltar
    </button>
  );
}
