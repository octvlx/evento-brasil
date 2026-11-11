"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { clearOfflineCheckinData, pendingOfflineCheckins, sendPendingOfflineCheckins } from "@/features/checkin/offline-store";
import { logoutAction } from "./actions";

/**
 * Botão "Sair": antes do logout, apaga o que o check-in offline guardou neste aparelho
 * (lista com nomes dos titulares, fila, cópia do leitor e service worker). Sem isso, a
 * próxima pessoa no mesmo navegador poderia ver esses dados. Falha na limpeza não impede sair.
 *
 * Se houver leituras offline ainda não enviadas, pergunta antes: sair sem enviar apaga
 * entradas que o servidor não conhece (o ingresso continuaria válido para entrar de novo).
 */
export function LogoutButton({ className, children }: { className?: string; children: React.ReactNode }) {
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [unsent, setUnsent] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (!unsent) return;
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [unsent]);

  useEffect(() => {
    if (unsent && !dialog.current?.open) dialog.current?.showModal();
  }, [unsent]);

  const leave = async () => {
    setPending(true);
    try {
      await clearOfflineCheckinData();
    } finally {
      form.current?.requestSubmit();
    }
  };

  const close = () => {
    dialog.current?.close();
    setUnsent(0);
    setError(null);
    setPending(false);
  };

  const sendAndLeave = async () => {
    setSending(true);
    setError(null);
    try {
      const r = await sendPendingOfflineCheckins();
      if (r.remaining === 0) {
        dialog.current?.close();
        await leave();
        return;
      }
      setUnsent(r.remaining);
      setError(`${r.remaining === 1 ? "1 leitura não pôde ser enviada" : `${r.remaining} leituras não puderam ser enviadas`}${r.error ? `: ${r.error}` : "."}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <form ref={form} action={logoutAction}>
      <button
        type="button"
        className={className}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const queued = (await pendingOfflineCheckins()).reduce((n, q) => n + q.count, 0);
          if (queued > 0) {
            setUnsent(queued);
            return;
          }
          await leave();
        }}
      >
        {children}
      </button>
      {unsent > 0 &&
        createPortal(
          // No corpo da página: o botão pode estar dentro de um menu <details> que fecha.
          <dialog
            ref={dialog}
            aria-labelledby="sair-pendentes"
            onCancel={(e) => {
              e.preventDefault();
              if (!sending) close();
            }}
            className="m-auto w-[min(30rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] rounded-2xl border border-border bg-card p-0 text-foreground shadow-lift backdrop:bg-black/50"
          >
            <div className="space-y-3 p-5 text-sm">
              <h2 id="sair-pendentes" className="font-display text-lg font-bold">
                {unsent === 1 ? "1 leitura do check-in ainda não foi enviada" : `${unsent} leituras do check-in ainda não foram enviadas`}
              </h2>
              <p className="text-muted-foreground">
                São entradas feitas sem internet neste aparelho. Se você sair sem enviar, elas são apagadas e o sistema não fica sabendo dessas entradas: esses ingressos continuariam valendo para entrar de novo.
              </p>
              {!online && <p className="font-semibold">Sem internet: conecte o aparelho para enviar.</p>}
              {error && (
                <p role="alert" className="font-semibold text-destructive">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="ghost" disabled={sending} onClick={close}>
                  Cancelar
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={sending}
                  onClick={() => {
                    dialog.current?.close();
                    void leave();
                  }}
                >
                  Sair sem enviar
                </Button>
                <Button type="button" disabled={sending || !online} onClick={sendAndLeave}>
                  {sending ? "Enviando…" : "Enviar e sair"}
                </Button>
              </div>
            </div>
          </dialog>,
          document.body,
        )}
    </form>
  );
}
