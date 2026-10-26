"use client";

import { useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { TICKET_KINDS, type TicketTypeInput } from "@/features/schemas";
import { TICKET_KIND } from "@/lib/labels";
import { centsToInput, formatBRL, parseBRLToCents } from "@/lib/money";
import { deleteTicketTypeAction, saveTicketTypeAction } from "./actions";

export interface ManagedTicketType {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  priceCents: number;
  quantityTotal: number;
  quantitySold: number;
  quantityReserved: number;
  quantityRefunded: number;
  minPerOrder: number;
  maxPerOrder: number;
  salesStartLocal: string;
  salesEndLocal: string;
  requiresAttendeeInfo: boolean;
  isHidden: boolean;
}

const empty = { name: "", description: "", kind: "GENERAL", price: "", quantityTotal: "100", minPerOrder: "1", maxPerOrder: "10", salesStartLocal: "", salesEndLocal: "", requiresAttendeeInfo: false, isHidden: false };

export function TicketTypesManager({ eventId, items, locked }: { eventId: string; items: ManagedTicketType[]; locked?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [f, setF] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const edit = (t: ManagedTicketType) => {
    setEditing(t.id);
    setF({
      name: t.name,
      description: t.description ?? "",
      kind: t.kind,
      price: centsToInput(t.priceCents),
      quantityTotal: String(t.quantityTotal),
      minPerOrder: String(t.minPerOrder),
      maxPerOrder: String(t.maxPerOrder),
      salesStartLocal: t.salesStartLocal,
      salesEndLocal: t.salesEndLocal,
      requiresAttendeeInfo: t.requiresAttendeeInfo,
      isHidden: t.isHidden,
    });
  };

  const save = () => {
    const priceCents = f.kind === "FREE" ? 0 : parseBRLToCents(f.price);
    if (priceCents === null) return setError("Preço inválido. Use o formato 49,90.");
    const input: TicketTypeInput = {
      id: editing && editing !== "new" ? editing : undefined,
      name: f.name,
      description: f.description || undefined,
      kind: f.kind as TicketTypeInput["kind"],
      priceCents,
      quantityTotal: Number(f.quantityTotal),
      minPerOrder: Number(f.minPerOrder),
      maxPerOrder: Number(f.maxPerOrder),
      salesStartLocal: f.salesStartLocal,
      salesEndLocal: f.salesEndLocal,
      requiresAttendeeInfo: f.requiresAttendeeInfo,
      isHidden: f.isHidden,
    };
    start(async () => {
      const res = await saveTicketTypeAction(eventId, input);
      if (!res.ok) return setError(res.error);
      setError(null);
      setEditing(null);
      setF(empty);
    });
  };

  const remove = (id: string) =>
    start(async () => {
      const res = await deleteTicketTypeAction(id);
      if (!res.ok) setError(res.error);
    });

  return (
    <div className="space-y-4">
      {items.length === 0 && <p className="text-sm text-muted-foreground">Nenhum ingresso cadastrado.</p>}
      <ul className="space-y-2">
        {items.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border p-4">
            <div>
              <p className="font-semibold">
                {t.name} {t.isHidden && <span className="text-xs text-muted-foreground">(oculto)</span>}
              </p>
              <p className="text-xs text-muted-foreground">
                {TICKET_KIND[t.kind]} · {t.priceCents ? formatBRL(t.priceCents) : "Gratuito"} · vendidos {t.quantitySold} · reservados {t.quantityReserved} · reembolsados {t.quantityRefunded} · total {t.quantityTotal}
              </p>
            </div>
            {!locked && (
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => edit(t)}>
                  <Pencil aria-hidden /> Editar
                </Button>
                {t.quantitySold + t.quantityReserved === 0 && (
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(t.id)} disabled={pending}>
                    <Trash2 aria-hidden /> Excluir
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {!locked &&
        (editing ? (
          <div className="grid gap-3 rounded-2xl border border-secondary/40 bg-secondary/5 p-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Label htmlFor="tt-name">Nome</Label>
              <Input id="tt-name" className="mt-1.5" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Pista, 1º lote" />
            </div>
            <div>
              <Label htmlFor="tt-kind">Tipo</Label>
              <Select id="tt-kind" className="mt-1.5" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                {TICKET_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {TICKET_KIND[k]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="tt-price">Preço (R$)</Label>
              <Input id="tt-price" className="mt-1.5" inputMode="decimal" value={f.kind === "FREE" ? "0,00" : f.price} disabled={f.kind === "FREE"} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder="49,90" />
            </div>
            <div>
              <Label htmlFor="tt-qty">Quantidade</Label>
              <Input id="tt-qty" type="number" min={1} className="mt-1.5" value={f.quantityTotal} onChange={(e) => setF({ ...f, quantityTotal: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="tt-min">Mín./pedido</Label>
                <Input id="tt-min" type="number" min={1} className="mt-1.5" value={f.minPerOrder} onChange={(e) => setF({ ...f, minPerOrder: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="tt-max">Máx./pedido</Label>
                <Input id="tt-max" type="number" min={1} className="mt-1.5" value={f.maxPerOrder} onChange={(e) => setF({ ...f, maxPerOrder: e.target.value })} />
              </div>
            </div>
            <div>
              <Label htmlFor="tt-s">Início das vendas (opcional)</Label>
              <Input id="tt-s" type="datetime-local" className="mt-1.5" value={f.salesStartLocal} onChange={(e) => setF({ ...f, salesStartLocal: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="tt-e">Fim das vendas (opcional)</Label>
              <Input id="tt-e" type="datetime-local" className="mt-1.5" value={f.salesEndLocal} onChange={(e) => setF({ ...f, salesEndLocal: e.target.value })} />
            </div>
            <div className="flex flex-col justify-end gap-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={f.requiresAttendeeInfo} onChange={(e) => setF({ ...f, requiresAttendeeInfo: e.target.checked })} /> Exigir nome por ingresso
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={f.isHidden} onChange={(e) => setF({ ...f, isHidden: e.target.checked })} /> Ocultar da venda
              </label>
            </div>
            <div className="sm:col-span-3">
              <Label htmlFor="tt-desc">Descrição (opcional)</Label>
              <Input id="tt-desc" className="mt-1.5" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            </div>
            <div className="flex gap-2 sm:col-span-3">
              <Button onClick={save} disabled={pending}>
                {pending ? "Salvando…" : "Salvar ingresso"}
              </Button>
              <Button variant="ghost" onClick={() => (setEditing(null), setF(empty), setError(null))}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" onClick={() => setEditing("new")}>
            Adicionar tipo de ingresso
          </Button>
        ))}
      {error && <Alert variant="danger">{error}</Alert>}
    </div>
  );
}
