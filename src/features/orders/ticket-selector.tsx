"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Minus, Plus, ShieldCheck, TicketPercent, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { formatBRL } from "@/lib/money";
import { feeBreakdownText } from "@/lib/price-display";
import { TICKET_KIND } from "@/lib/labels";
import { createOrderAction } from "./actions";
import { isCouponError } from "./status-view";

export interface SelectorTicket {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  priceCents: number;
  /** Taxa de serviço por unidade calculada no servidor (a mesma do pedido). */
  serviceFeeCents: number;
  minPerOrder: number;
  maxPerOrder: number;
  available: number;
  onSale: boolean;
  requiresAttendeeInfo: boolean;
}

interface Props {
  eventId: string;
  eventSlug: string;
  tickets: SelectorTicket[];
  /** A regra do evento cobra taxa de serviço do comprador. */
  buyerPaysFee: boolean;
  user: { name: string; email: string } | null;
  halfPriceLeft: number | null;
  paymentsAvailable: boolean;
  /** Cupom pré-aplicado por um link rastreado (o comprador pode remover). */
  initialCouponCode?: string | null;
}

export function TicketSelector({ eventId, eventSlug, tickets, buyerPaysFee, user, halfPriceLeft, paymentsAvailable, initialCouponCode }: Props) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [attendees, setAttendees] = useState<Record<string, string[]>>({});
  const [buyerName, setBuyerName] = useState(user?.name ?? "");
  const [buyerEmail, setBuyerEmail] = useState(user?.email ?? "");
  const [halfDecl, setHalfDecl] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coupon, setCoupon] = useState(initialCouponCode ?? "");
  const [couponOpen, setCouponOpen] = useState(Boolean(initialCouponCode));
  const [couponError, setCouponError] = useState<string | null>(null);
  const couponCode = coupon.trim();
  const [pending, start] = useTransition();
  // Chave de idempotência por tentativa: evita pedidos duplicados em duplo clique.
  const [idempotencyKey, setKey] = useState(() => crypto.randomUUID());

  const lines = tickets.filter((t) => (qty[t.id] ?? 0) > 0);
  const totals = useMemo(() => {
    const subtotal = lines.reduce((s, t) => s + t.priceCents * qty[t.id], 0);
    const fee = lines.reduce((s, t) => s + t.serviceFeeCents * qty[t.id], 0);
    return { subtotal, fee, total: subtotal + fee, count: lines.reduce((s, t) => s + qty[t.id], 0) };
  }, [lines, qty]);
  const hasHalf = lines.some((t) => t.kind === "HALF_PRICE");

  const change = (t: SelectorTicket, delta: number) => {
    setQty((q) => {
      const current = q[t.id] ?? 0;
      let next = current + delta;
      if (delta > 0 && current === 0) next = Math.max(next, t.minPerOrder);
      if (next < t.minPerOrder) next = 0;
      next = Math.min(next, t.maxPerOrder, t.available);
      return { ...q, [t.id]: next };
    });
    setError(null);
  };

  const submit = () => {
    if (!user) {
      router.push(`/entrar?next=${encodeURIComponent(`/eventos/${eventSlug}`)}`);
      return;
    }
    setError(null);
    setCouponError(null);
    start(async () => {
      const res = await createOrderAction({
        eventId,
        items: lines.map((t) => ({
          ticketTypeId: t.id,
          quantity: qty[t.id],
          attendees: t.requiresAttendeeInfo ? Array.from({ length: qty[t.id] }, (_, i) => ({ name: attendees[t.id]?.[i] ?? "" })) : undefined,
        })),
        buyerName,
        buyerEmail,
        halfPriceDeclaration: halfDecl,
        idempotencyKey,
        couponCode: couponCode || undefined,
      });
      if (res.ok) router.push(`/checkout/${res.data.orderId}`);
      else {
        if (isCouponError(res, Boolean(couponCode))) setCouponError(res.error);
        else setError(res.error);
        setKey(crypto.randomUUID());
      }
    });
  };

  return (
    <div className="space-y-4">
      {!paymentsAvailable && <Alert variant="warning">A compra de ingressos pagos está temporariamente indisponível. Ingressos gratuitos continuam disponíveis.</Alert>}
      <ul className="space-y-3">
        {tickets.map((t) => {
          const n = qty[t.id] ?? 0;
          const soldOut = t.available <= 0;
          const breakdown = feeBreakdownText({ priceCents: t.priceCents, serviceFeeCents: t.serviceFeeCents, totalCents: t.priceCents + t.serviceFeeCents });
          return (
            <li key={t.id} className="rounded-2xl border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{t.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[TICKET_KIND[t.kind] !== t.name ? TICKET_KIND[t.kind] : null, t.description].filter(Boolean).join(" · ")}
                  </p>
                  <p className="mt-1 font-display text-lg font-bold" data-testid="ticket-total">
                    {t.priceCents === 0 ? "Gratuito" : formatBRL(t.priceCents + t.serviceFeeCents)}
                  </p>
                  {breakdown && <p className="text-xs text-muted-foreground">{breakdown} de serviço</p>}
                </div>
                {!t.onSale || soldOut || (!paymentsAvailable && t.priceCents > 0) ? (
                  <span className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">{soldOut ? "Esgotado" : !t.onSale ? "Fora do período" : "Indisponível"}</span>
                ) : (
                  <div className="flex shrink-0 items-center gap-2" role="group" aria-label={`Quantidade de ${t.name}`}>
                    <Button type="button" variant="outline" size="icon" onClick={() => change(t, -1)} disabled={n === 0} aria-label="Diminuir">
                      <Minus />
                    </Button>
                    <span className="w-6 text-center font-bold tabular-nums" aria-live="polite">
                      {n}
                    </span>
                    <Button type="button" variant="outline" size="icon" onClick={() => change(t, 1)} disabled={n >= Math.min(t.maxPerOrder, t.available)} aria-label="Aumentar">
                      <Plus />
                    </Button>
                  </div>
                )}
              </div>
              {t.onSale && !soldOut && t.available <= 10 && <p className="mt-2 text-xs font-semibold text-warning">Restam poucas unidades</p>}
              {t.requiresAttendeeInfo && n > 0 && (
                <div className="mt-3 space-y-2">
                  {Array.from({ length: n }, (_, i) => (
                    <Input
                      key={i}
                      placeholder={`Nome do participante ${i + 1}`}
                      aria-label={`Nome do participante ${i + 1} (${t.name})`}
                      value={attendees[t.id]?.[i] ?? ""}
                      onChange={(e) =>
                        setAttendees((a) => {
                          const list = [...(a[t.id] ?? [])];
                          list[i] = e.target.value;
                          return { ...a, [t.id]: list };
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {hasHalf && (
        <label className="flex items-start gap-2 rounded-xl bg-muted p-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--secondary)]" checked={halfDecl} onChange={(e) => setHalfDecl(e.target.checked)} />
          <span>
            Declaro ter direito à <strong>meia-entrada</strong> e apresentarei documento comprobatório na entrada. A falta de comprovação pode impedir o acesso.
            {halfPriceLeft !== null && <span className="block text-xs text-muted-foreground">Cota de meia-entrada restante: {halfPriceLeft}</span>}
          </span>
        </label>
      )}

      {totals.count > 0 && user && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="buyerName">Nome do comprador</Label>
            <Input id="buyerName" className="mt-1.5" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} autoComplete="name" />
          </div>
          <div>
            <Label htmlFor="buyerEmail">E-mail para receber os ingressos</Label>
            <Input id="buyerEmail" type="email" className="mt-1.5" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} autoComplete="email" />
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-border p-4">
        {couponOpen ? (
          <div>
            <Label htmlFor="couponCode" className="flex items-center gap-1.5">
              <TicketPercent className="size-4 text-secondary" aria-hidden /> Cupom de desconto
            </Label>
            <div className="mt-1.5 flex gap-2">
              <Input
                id="couponCode"
                value={coupon}
                onChange={(e) => {
                  setCoupon(e.target.value.toUpperCase());
                  setCouponError(null);
                }}
                maxLength={32}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="EX.: PROMO10"
                className="font-mono uppercase"
                aria-invalid={!!couponError}
                aria-describedby={couponError ? "couponError" : "couponHint"}
              />
              {coupon && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remover cupom"
                  onClick={() => {
                    setCoupon("");
                    setCouponError(null);
                  }}
                >
                  <X />
                </Button>
              )}
            </div>
            {couponError ? (
              <p id="couponError" role="alert" className="mt-1.5 text-sm font-medium text-destructive">
                {couponError}
              </p>
            ) : (
              <p id="couponHint" className="mt-1.5 text-xs text-muted-foreground">
                O desconto é calculado e conferido na próxima etapa. Não vale para meia-entrada.
              </p>
            )}
          </div>
        ) : (
          <button type="button" className="flex items-center gap-1.5 text-sm font-semibold text-secondary hover:underline" onClick={() => setCouponOpen(true)}>
            <TicketPercent className="size-4" aria-hidden /> Tenho um cupom de desconto
          </button>
        )}
      </div>

      <dl className="space-y-1.5 rounded-2xl bg-muted p-4 text-sm">
        <div className="flex justify-between">
          <dt>Ingressos ({totals.count})</dt>
          <dd className="tabular-nums">{formatBRL(totals.subtotal)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Taxa de serviço</dt>
          <dd className="tabular-nums">{buyerPaysFee ? formatBRL(totals.fee) : "Sem taxa para o comprador"}</dd>
        </div>
        {couponCode && (
          <div className="flex justify-between gap-3 text-secondary">
            <dt>
              Cupom <span className="font-mono font-semibold">{couponCode}</span>
            </dt>
            <dd>desconto na próxima etapa</dd>
          </div>
        )}
        <div className="flex justify-between border-t border-border pt-2 text-base font-bold">
          <dt>{couponCode ? "Total sem desconto" : "Total"}</dt>
          <dd className="tabular-nums">{formatBRL(totals.total)}</dd>
        </div>
      </dl>

      {error && <Alert variant="danger">{error}</Alert>}

      <Button size="lg" className="w-full" variant="accent" onClick={submit} disabled={pending || totals.count === 0 || (hasHalf && !halfDecl)}>
        {pending ? "Reservando…" : !user ? "Entrar para comprar" : totals.count === 0 ? "Selecione os ingressos" : "Continuar para o pagamento"}
      </Button>
      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5" aria-hidden /> Os ingressos ficam reservados por alguns minutos enquanto você paga.
      </p>
    </div>
  );
}
