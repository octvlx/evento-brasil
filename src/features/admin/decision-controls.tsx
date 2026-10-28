"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import type { ActionResult } from "@/server/errors";

const MIN_REASON = 3;

/**
 * Decisão do admin com motivo obrigatório e diálogo de confirmação. O botão
 * fica travado do primeiro clique até a resposta; o serviço de domínio continua
 * sendo a garantia contra a dupla decisão (transição condicional sob trava).
 */
export function ReasonedDecisionButton({
  label,
  confirmTitle,
  confirmText,
  reasonLabel = "Motivo (registrado na auditoria)",
  action,
  variant = "outline",
  doneText = "Decisão registrada.",
}: {
  label: string;
  confirmTitle: string;
  confirmText: string;
  reasonLabel?: string;
  action: (note: string) => Promise<ActionResult<unknown>>;
  variant?: "outline" | "secondary" | "destructive" | "default";
  doneText?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);

  const submit = () => {
    if (inFlight.current || reason.trim().length < MIN_REASON) return;
    inFlight.current = true;
    start(async () => {
      try {
        const r = await action(reason.trim());
        if (r.ok) {
          setDone(true);
          setError(null);
          dialog.current?.close();
        } else setError(r.error);
      } finally {
        inFlight.current = false;
      }
    });
  };

  if (done) return <p className="text-sm text-muted-foreground" role="status">{doneText}</p>;
  return (
    <>
      <Button size="sm" variant={variant} disabled={pending} onClick={() => dialog.current?.showModal()}>
        {label}
      </Button>
      <dialog ref={dialog} aria-label={confirmTitle} className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-border bg-card p-5 text-foreground backdrop:bg-black/50">
        <h2 className="text-base font-bold">{confirmTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{confirmText}</p>
        <label className="mt-3 block text-sm font-medium">
          {reasonLabel}
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3} className="mt-1.5" required />
        </label>
        {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" type="button" disabled={pending} onClick={() => dialog.current?.close()}>
            Voltar
          </Button>
          <Button size="sm" variant={variant} type="button" disabled={pending || reason.trim().length < MIN_REASON} onClick={submit}>
            {pending ? "Enviando…" : `Confirmar: ${label.toLowerCase()}`}
          </Button>
        </div>
      </dialog>
    </>
  );
}
