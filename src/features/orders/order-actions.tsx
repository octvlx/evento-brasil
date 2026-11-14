"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { formatBRL } from "@/lib/money";
import { refreshPaymentStatusAction, requestRefundAction } from "./actions";
import { RefundTicketList, type RefundableTicket } from "./refund-ticket-list";

/**
 * Reconsulta o provedor enquanto o pedido está pendente (nunca confia no redirect):
 * logo ao abrir (com o id devolvido pelo Checkout Pro, se houver) e depois a cada 12 s
 * por até 6 min; nos intervalos, só relê o banco.
 */
export function PendingPoller({ orderId, returnedPaymentId }: { orderId: string; returnedPaymentId?: string | null }) {
  const router = useRouter();
  const [check, setCheck] = useState<Awaited<ReturnType<typeof refreshPaymentStatusAction>> | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    let n = 0;
    const tick = async () => {
      n++;
      if (n === 1) setCheck(await refreshPaymentStatusAction(orderId, returnedPaymentId ?? undefined));
      else if (n % 4 === 0) setCheck(await refreshPaymentStatusAction(orderId));
      else router.refresh();
    };
    void tick();
    const t = setInterval(() => {
      if (n > 120) return clearInterval(t);
      void tick();
    }, 3000);
    return () => clearInterval(t);
  }, [orderId, returnedPaymentId, router]);
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

/**
 * Pedido de reembolso do comprador. Com `tickets` (os ingressos ainda válidos), dá para
 * escolher quais devolver; `usedTickets` conta os já utilizados, que ficam de fora.
 */
export function RefundButton({ orderId, tickets, usedTickets = 0 }: { orderId: string; tickets?: RefundableTicket[]; usedTickets?: number }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState<string[]>(() => tickets?.map((t) => t.id) ?? []);
  if (msg) return <Alert variant={msg.ok ? "success" : "danger"}>{msg.text}</Alert>;
  const choosing = !!tickets && (tickets.length > 1 || usedTickets > 0);
  const whole = !choosing || (selected.length === tickets!.length && usedTickets === 0);
  const total = tickets?.filter((t) => selected.includes(t.id)).reduce((s, t) => s + t.amountCents, 0) ?? 0;
  return confirming ? (
    <div className="space-y-2 rounded-xl bg-muted p-3 text-sm">
      {choosing && <RefundTicketList tickets={tickets!} selected={selected} onChange={setSelected} disabled={pending} />}
      <p>
        {whole
          ? "Confirmar o reembolso integral? Os ingressos deste pedido serão cancelados."
          : `Confirmar o reembolso de ${selected.length} ${selected.length === 1 ? "ingresso" : "ingressos"} (${formatBRL(total)}, com a taxa de serviço)? Os ingressos escolhidos serão cancelados e os demais continuam válidos.`}
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={pending || (choosing && !selected.length)}
          onClick={() =>
            start(async () => {
              const r = await requestRefundAction(orderId, tickets ? selected : undefined);
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
