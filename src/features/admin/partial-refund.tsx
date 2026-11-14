"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { RefundTicketList, type RefundableTicket } from "@/features/orders/refund-ticket-list";
import { adminPartialRefundAction } from "./actions";

/** Reembolso de parte dos ingressos de um pedido pago, com motivo obrigatório. */
export function AdminPartialRefund({ orderId, tickets }: { orderId: string; tickets: RefundableTicket[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Reembolsar parte
      </Button>
    );
  return (
    <div className="flex min-w-64 flex-col gap-2 rounded-xl border border-border p-2">
      <RefundTicketList tickets={tickets} selected={selected} onChange={setSelected} disabled={pending} />
      <Input placeholder="Motivo do reembolso" aria-label="Motivo do reembolso" value={reason} onChange={(e) => setReason(e.target.value)} className="h-9 text-xs" />
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !selected.length || reason.trim().length < 3}
          onClick={() =>
            start(async () => {
              const r = await adminPartialRefundAction(orderId, selected, reason);
              if (!r.ok) setError(r.error);
              else {
                setOpen(false);
                setSelected([]);
                setReason("");
                setError(null);
              }
            })
          }
        >
          {pending ? "…" : "Confirmar"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Voltar
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
