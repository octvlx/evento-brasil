"use client";

import { useRef, useState } from "react";
import { clearOfflineCheckinData } from "@/features/checkin/offline-store";
import { logoutAction } from "./actions";

/**
 * Botão "Sair": antes do logout, apaga o que o check-in offline guardou neste aparelho
 * (lista com nomes dos titulares, fila, cópia do leitor e service worker). Sem isso, a
 * próxima pessoa no mesmo navegador poderia ver esses dados. Falha na limpeza não impede sair.
 */
export function LogoutButton({ className, children }: { className?: string; children: React.ReactNode }) {
  const form = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  return (
    <form ref={form} action={logoutAction}>
      <button
        type="button"
        className={className}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          try {
            await clearOfflineCheckinData();
          } finally {
            form.current?.requestSubmit();
          }
        }}
      >
        {children}
      </button>
    </form>
  );
}
