import { formatBRL } from "@/lib/money";

export function OrderSummary({
  items,
  subtotalCents,
  serviceFeeCents,
  totalCents,
}: {
  items: { id: string; ticketTypeName: string; quantity: number; unitPriceCents: number; serviceFeePerUnitCents: number }[];
  subtotalCents: number;
  serviceFeeCents: number;
  totalCents: number;
}) {
  return (
    <dl className="space-y-2 text-sm">
      {items.map((i) => (
        <div key={i.id} className="flex justify-between gap-3">
          <dt>
            {i.quantity}× {i.ticketTypeName}
          </dt>
          <dd className="tabular-nums">{formatBRL(i.unitPriceCents * i.quantity)}</dd>
        </div>
      ))}
      <div className="flex justify-between border-t border-border pt-2 text-muted-foreground">
        <dt>Subtotal</dt>
        <dd className="tabular-nums">{formatBRL(subtotalCents)}</dd>
      </div>
      <div className="flex justify-between text-muted-foreground">
        <dt>Taxa de serviço</dt>
        <dd className="tabular-nums">{serviceFeeCents ? formatBRL(serviceFeeCents) : "Isenta"}</dd>
      </div>
      <div className="flex justify-between border-t border-border pt-2 text-base font-bold">
        <dt>Total</dt>
        <dd className="tabular-nums">{formatBRL(totalCents)}</dd>
      </div>
    </dl>
  );
}
