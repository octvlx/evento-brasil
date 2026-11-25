"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setReviewHiddenAction } from "@/features/admin/actions";

/** Ocultar (com motivo) ou voltar a mostrar uma avaliação. A ação é auditada no servidor. */
export function AdminReviewHide({ id, hidden }: { id: string; hidden: boolean }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = () =>
    start(async () => {
      const res = await setReviewHiddenAction(id, !hidden, hidden ? undefined : reason);
      setError(res.ok ? null : res.error);
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!hidden && (
        <>
          <label htmlFor={`hide-reason-${id}`} className="sr-only">
            Motivo da ocultação
          </label>
          <input
            id={`hide-reason-${id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Motivo"
            className="h-8 w-40 rounded-lg border border-input bg-background px-2 text-xs"
          />
        </>
      )}
      <Button type="button" size="sm" variant={hidden ? "outline" : "destructive"} disabled={pending || (!hidden && !reason.trim())} onClick={act}>
        {hidden ? "Mostrar de novo" : "Ocultar"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
