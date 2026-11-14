"use client";

import { formatBRL } from "@/lib/money";

/** Ingresso que pode entrar num reembolso, com o valor devolvido (preço pago + taxa de serviço). */
export interface RefundableTicket {
  id: string;
  label: string;
  holder?: string | null;
  amountCents: number;
}

/** Lista de ingressos com caixa de seleção e o total a devolver. */
export function RefundTicketList({
  tickets,
  selected,
  onChange,
  disabled,
}: {
  tickets: RefundableTicket[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const total = tickets.filter((t) => selected.includes(t.id)).reduce((s, t) => s + t.amountCents, 0);
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="mb-1 text-xs font-semibold">Ingressos a reembolsar</legend>
      {tickets.map((t) => (
        <label key={t.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={selected.includes(t.id)}
            onChange={(e) => onChange(e.target.checked ? [...selected, t.id] : selected.filter((id) => id !== t.id))}
          />
          <span className="min-w-0 flex-1 truncate">
            {t.label}
            {t.holder && <span className="text-muted-foreground"> · {t.holder}</span>}
          </span>
          <span className="tabular-nums">{formatBRL(t.amountCents)}</span>
        </label>
      ))}
      <p className="flex justify-between border-t border-border pt-1.5 text-sm font-semibold">
        <span>Total a devolver</span>
        <span className="tabular-nums" data-testid="refund-selected-total">
          {formatBRL(total)}
        </span>
      </p>
    </fieldset>
  );
}
