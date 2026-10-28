"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Label, Select, Textarea } from "@/components/ui/primitives";
import { formatDateTimeShort } from "@/lib/datetime";
import { requestCancellationAction, withdrawCancellationAction } from "./cancellation-actions";

const REASON_MAX = 2000;

/**
 * "Solicitar cancelamento" (L5b): abre um pedido com protocolo para a plataforma analisar.
 * Com `orderId` fixo (página do pedido) ou com escolha entre `orders` (/ajuda#cancelamento).
 */
export function CancellationRequestForm({ orderId, orders, responseDays }: { orderId?: string; orders?: { id: string; label: string }[]; responseDays: number }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(orderId ?? orders?.[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ protocol: string; respondBy: Date | null } | null>(null);
  const [pending, start] = useTransition();

  if (done)
    return (
      <Alert variant="success" data-testid="cancellation-protocol">
        Pedido de cancelamento registrado. Protocolo <strong className="font-mono">{done.protocol}</strong>
        {done.respondBy && <> · resposta até {formatDateTimeShort(new Date(done.respondBy))}</>}. Guarde o protocolo: ele também aparece na página do pedido.
      </Alert>
    );
  if (!orderId && !orders?.length) return <p className="text-sm text-muted-foreground">Você não tem pedidos para cancelar.</p>;
  if (!open)
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Solicitar cancelamento
      </Button>
    );

  return (
    <form
      className="space-y-3 rounded-2xl border border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await requestCancellationAction(selected, reason);
          if (r.ok) setDone(r.data);
          else setError(r.error);
        });
      }}
    >
      {error && <Alert variant="danger">{error}</Alert>}
      {!orderId && orders && (
        <div>
          <Label htmlFor="cancel-order">Pedido</Label>
          <Select id="cancel-order" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={pending}>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div>
        <Label htmlFor="cancel-reason">Motivo do cancelamento</Label>
        <Textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={REASON_MAX} rows={4} disabled={pending} />
      </div>
      {/* TODO(jurídico): prazo de resposta provisório (D3, PROVISIONAL_CANCELLATION_RESPONSE_DAYS). */}
      <p className="text-xs text-muted-foreground">
        Nossa equipe analisa e responde em até {responseDays} dias corridos (prazo provisório, pendente de revisão jurídica). Você recebe um número de protocolo para acompanhar. Se o pedido já
        puder ser reembolsado pela política do evento, use “Solicitar reembolso”, que é imediato.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || !selected}>
          {pending ? "Enviando…" : "Enviar pedido de cancelamento"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
          Fechar
        </Button>
      </div>
    </form>
  );
}

/** O comprador desiste de um pedido de cancelamento ainda em análise. */
export function WithdrawCancellationButton({ requestId }: { requestId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await withdrawCancellationAction(requestId);
            if (!r.ok) setError(r.error);
          })
        }
      >
        {pending ? "Desistindo…" : "Desistir do pedido"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
