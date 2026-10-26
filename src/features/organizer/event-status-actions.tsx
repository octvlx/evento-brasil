"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Textarea } from "@/components/ui/primitives";
import { cancelEventAction, submitEventAction } from "./actions";

export function EventStatusActions({ eventId, status, canPublish, canCancel, paidOrders }: { eventId: string; status: string; canPublish: boolean; canCancel: boolean; paidOrders: number }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {canPublish && status === "DRAFT" && (
          <Button
            variant="accent"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await submitEventAction(eventId);
                setMsg(r.ok ? { ok: true, text: r.data.status === "PUBLISHED" ? "Evento publicado!" : "Enviado para moderação da plataforma." } : { ok: false, text: r.error });
              })
            }
          >
            Publicar evento
          </Button>
        )}
        {canCancel && ["DRAFT", "PENDING_REVIEW", "PUBLISHED"].includes(status) && !cancelling && (
          <Button variant="outline" className="text-destructive" onClick={() => setCancelling(true)}>
            Cancelar evento
          </Button>
        )}
      </div>
      {cancelling && (
        <div className="space-y-2 rounded-2xl border border-destructive/40 bg-destructive-soft/40 p-4">
          <p className="text-sm font-semibold text-destructive">
            Cancelar é irreversível. {paidOrders > 0 ? `${paidOrders} pedido(s) pago(s) serão reembolsados integralmente e os ingressos revogados.` : "Não há pedidos pagos."}
          </p>
          <Textarea placeholder="Motivo (será informado aos compradores)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motivo do cancelamento" />
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={pending || reason.trim().length < 5}
              onClick={() =>
                start(async () => {
                  const r = await cancelEventAction(eventId, reason);
                  setMsg(r.ok ? { ok: true, text: `Evento cancelado. ${r.data.refunds} reembolso(s) iniciado(s).` } : { ok: false, text: r.error });
                  setCancelling(false);
                })
              }
            >
              Confirmar cancelamento
            </Button>
            <Button variant="ghost" onClick={() => setCancelling(false)}>
              Voltar
            </Button>
          </div>
        </div>
      )}
      {msg && <Alert variant={msg.ok ? "success" : "danger"}>{msg.text}</Alert>}
    </div>
  );
}
