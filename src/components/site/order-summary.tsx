import { formatBRL } from "@/lib/money";

/**
 * Resumo do pedido com os valores gravados pelo servidor. Cada linha mostra o
 * preço de tabela; o desconto do cupom aparece numa linha própria e o subtotal
 * (`subtotalCents`) já vem líquido de desconto.
 */
export function OrderSummary({
  items,
  subtotalCents,
  serviceFeeCents,
  totalCents,
  discountCents = 0,
  couponCode,
}: {
  items: { id: string; ticketTypeName: string; quantity: number; listUnitPriceCents: number; serviceFeePerUnitCents: number }[];
  subtotalCents: number;
  serviceFeeCents: number;
  totalCents: number;
  discountCents?: number;
  couponCode?: string | null;
}) {
  return (
    <dl className="space-y-2 text-sm">
      {items.map((i) => (
        <div key={i.id} className="flex justify-between gap-3">
          <dt>
            {i.quantity}× {i.ticketTypeName}
          </dt>
          <dd className="tabular-nums">{formatBRL(i.listUnitPriceCents * i.quantity)}</dd>
        </div>
      ))}
      {discountCents > 0 && (
        <div className="flex justify-between gap-3 text-success">
          <dt>
            Desconto{couponCode && <> · cupom <span className="font-mono font-semibold">{couponCode}</span></>}
          </dt>
          <dd className="tabular-nums">−{formatBRL(discountCents)}</dd>
        </div>
      )}
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
