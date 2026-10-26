"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { refreshPaymentStatusAction, requestRefundAction } from "./actions";

/** Reconsulta o provedor enquanto o pedido está pendente (nunca confia no redirect). */
export function PendingPoller({ orderId }: { orderId: string }) {
  const router = useRouter();
  useEffect(() => {
    let n = 0;
    const t = setInterval(async () => {
      n++;
      if (n % 4 === 0) await refreshPaymentStatusAction(orderId);
      else router.refresh();
      if (n > 120) clearInterval(t);
    }, 3000);
    return () => clearInterval(t);
  }, [orderId, router]);
  return null;
}

export function RefundButton({ orderId }: { orderId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  if (msg) return <Alert variant={msg.ok ? "success" : "danger"}>{msg.text}</Alert>;
  return confirming ? (
    <div className="space-y-2 rounded-xl bg-muted p-3 text-sm">
      <p>Confirmar o reembolso integral? Os ingressos deste pedido serão cancelados.</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await requestRefundAction(orderId);
              setMsg(r.ok ? { ok: true, text: r.data.status === "SUCCEEDED" ? "Reembolso concluído." : "Reembolso solicitado; você será avisado por e-mail." } : { ok: false, text: r.error });
            })
          }
        >
          {pending ? "Processando…" : "Sim, reembolsar"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Voltar
        </Button>
      </div>
    </div>
  ) : (
    <Button variant="outline" onClick={() => setConfirming(true)}>
      Solicitar reembolso
    </Button>
  );
}
