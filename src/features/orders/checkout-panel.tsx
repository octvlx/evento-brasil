"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Copy, CreditCard, FlaskConical, QrCode, TimerReset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { simulatePaymentAction, startPaymentAction } from "./actions";

interface Props {
  orderId: string;
  expiresAt: string;
  isSimulated: boolean;
  pendingPix: { copyPaste: string | null; qrDataUrl: string | null } | null;
}

function useCountdown(target: string) {
  const [left, setLeft] = useState(() => new Date(target).getTime() - Date.now());
  useEffect(() => {
    const t = setInterval(() => setLeft(new Date(target).getTime() - Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  return Math.max(0, left);
}

export function CheckoutPanel({ orderId, expiresAt, isSimulated, pendingPix }: Props) {
  const router = useRouter();
  const [method, setMethod] = useState<"PIX" | "CREDIT_CARD">("PIX");
  const [cardOutcome, setCardOutcome] = useState<"approve" | "decline">("approve");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const left = useCountdown(expiresAt);
  const mm = String(Math.floor(left / 60000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  const expired = left === 0;

  const pay = () =>
    start(async () => {
      setError(null);
      const res = await startPaymentAction(orderId, method, method === "CREDIT_CARD" && isSimulated ? cardOutcome : undefined);
      if (!res.ok) return setError(res.error);
      if (method === "CREDIT_CARD") {
        if (res.data.status === "FAILED") setError("Pagamento recusado. Tente outro cartão ou pague com PIX.");
        else router.push(`/pedido/${orderId}`);
      }
    });

  const simulate = (action: "approve" | "reject" | "expire") =>
    start(async () => {
      setError(null);
      const res = await simulatePaymentAction(orderId, action);
      if (!res.ok) return setError(res.error);
      setInfo(`Webhook simulado processado: ${res.data.result}`);
      router.push(`/pedido/${orderId}`);
    });

  return (
    <div className="space-y-5">
      <div className={cn("flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold", expired ? "bg-destructive-soft text-destructive" : "bg-warning-soft text-warning")}>
        <TimerReset className="size-4" aria-hidden />
        {expired ? "Reserva expirada. Volte ao evento para tentar novamente." : <span>Ingressos reservados por <span className="tabular-nums">{mm}:{ss}</span></span>}
      </div>

      {pendingPix ? (
        <div className="space-y-4 rounded-2xl border border-border p-5">
          <h2 className="flex items-center gap-2 font-display text-lg font-bold">
            <QrCode className="size-5 text-secondary" aria-hidden /> Pague com PIX
          </h2>
          {pendingPix.qrDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={pendingPix.qrDataUrl} alt="QR code PIX" className="mx-auto size-56 rounded-xl bg-white p-2" />
          )}
          {pendingPix.copyPaste && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">PIX copia e cola</p>
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 truncate rounded-xl bg-muted px-3 py-2.5 text-xs">{pendingPix.copyPaste}</code>
                <Button type="button" variant="outline" size="icon" aria-label="Copiar código PIX" onClick={() => navigator.clipboard.writeText(pendingPix.copyPaste!)}>
                  <Copy />
                </Button>
              </div>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Assim que o banco confirmar, seus ingressos aparecem automaticamente. A confirmação vem do provedor de pagamento — não é preciso enviar comprovante.
          </p>
          <Button variant="outline" className="w-full" onClick={() => router.push(`/pedido/${orderId}`)}>
            Já paguei, acompanhar pedido
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">Forma de pagamento</legend>
            {(
              [
                ["PIX", "PIX", "Aprovação em segundos", QrCode],
                ["CREDIT_CARD", isSimulated ? "Cartão de crédito (simulado)" : "Cartão de crédito", isSimulated ? "Ambiente de teste" : "Em breve", CreditCard],
              ] as const
            ).map(([value, label, hint, Icon]) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-2xl border p-4 transition",
                  method === value ? "border-secondary bg-secondary/5 ring-2 ring-secondary/30" : "border-border",
                  value === "CREDIT_CARD" && !isSimulated && "pointer-events-none opacity-50",
                )}
              >
                <input type="radio" name="method" value={value} checked={method === value} onChange={() => setMethod(value)} className="sr-only" disabled={value === "CREDIT_CARD" && !isSimulated} />
                <Icon className="size-5 text-secondary" aria-hidden />
                <span>
                  <span className="block font-semibold">{label}</span>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {method === "CREDIT_CARD" && isSimulated && (
            <div className="rounded-xl bg-muted p-3 text-sm">
              <p className="mb-2 font-semibold">Resultado simulado do cartão</p>
              <div className="flex gap-4">
                {(["approve", "decline"] as const).map((o) => (
                  <label key={o} className="flex items-center gap-1.5">
                    <input type="radio" checked={cardOutcome === o} onChange={() => setCardOutcome(o)} /> {o === "approve" ? "Aprovar" : "Recusar"}
                  </label>
                ))}
              </div>
            </div>
          )}
          <Button size="lg" variant="accent" className="w-full" onClick={pay} disabled={pending || expired}>
            {pending ? "Processando…" : method === "PIX" ? "Gerar PIX" : "Pagar com cartão"}
          </Button>
        </div>
      )}

      {isSimulated && pendingPix && (
        <div className="rounded-2xl border-2 border-dashed border-warning/60 bg-warning-soft/40 p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-warning">
            <FlaskConical className="size-4" aria-hidden /> Simulador de pagamentos — somente desenvolvimento
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Altera o estado no provedor fictício e envia um webhook assinado, que passa pela mesma verificação e confirmação do provedor real. Nenhum dinheiro é movimentado.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => simulate("approve")} disabled={pending}>
              Aprovar PIX
            </Button>
            <Button size="sm" variant="outline" onClick={() => simulate("reject")} disabled={pending}>
              Recusar
            </Button>
            <Button size="sm" variant="outline" onClick={() => simulate("expire")} disabled={pending}>
              Expirar
            </Button>
          </div>
        </div>
      )}

      {info && <Alert variant="success">{info}</Alert>}
      {error && <Alert variant="danger">{error}</Alert>}
    </div>
  );
}
