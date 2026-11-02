"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { refreshPaymentStatusAction, requestRefundAction } from "./actions";

/**
 * Reconsulta o provedor enquanto o pedido está pendente (nunca confia no redirect):
 * logo ao abrir e depois a cada 12 s por até 6 min; nos intervalos, só relê o banco.
 */
export function PendingPoller({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [check, setCheck] = useState<Awaited<ReturnType<typeof refreshPaymentStatusAction>> | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    let n = 0;
    const tick = async () => {
      n++;
      if (n === 1 || n % 4 === 0) setCheck(await refreshPaymentStatusAction(orderId));
      else router.refresh();
    };
    void tick();
    const t = setInterval(() => {
      if (n > 120) return clearInterval(t);
      void tick();
    }, 3000);
    return () => clearInterval(t);
  }, [orderId, router]);
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 text-sm" aria-live="polite">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => setCheck(await refreshPaymentStatusAction(orderId)))}>
        {pending ? "Verificando…" : "Verificar pagamento agora"}
      </Button>
      {check === "unavailable" && (
        <span className="text-warning">Não foi possível consultar o Mercado Pago agora. Tentaremos de novo em instantes.</span>
      )}
      {check === "rate_limited" && <span className="text-muted-foreground">Aguarde um pouco antes de verificar de novo.</span>}
    </div>
  );
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
