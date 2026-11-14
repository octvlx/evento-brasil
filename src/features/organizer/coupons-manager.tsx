"use client";

import { useState, useTransition } from "react";
import { Ban, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Input, Label, Select } from "@/components/ui/primitives";
import type { CouponInput } from "@/features/schemas";
import { centsToInput, formatBRL, parseBRLToCents } from "@/lib/money";
import { deleteCouponAction, saveCouponAction, setCouponDisabledAction } from "./actions";

export interface ManagedCoupon {
  id: string;
  code: string;
  description: string | null;
  discountType: "PERCENT" | "FIXED_PER_TICKET";
  percentBps: number | null;
  amountCents: number | null;
  validFromLocal: string;
  validUntilLocal: string;
  maxUses: number | null;
  maxUsesPerUser: number | null;
  timesReserved: number;
  timesRedeemed: number;
  disabled: boolean;
  organizationWide: boolean;
  ticketTypeIds: string[];
  used: boolean;
}

/** Tipos de ingresso a que um cupom pode se aplicar (pagos, sem meia-entrada). */
export interface CouponTicketOption {
  id: string;
  name: string;
}

const empty = { code: "", description: "", discountType: "PERCENT", percent: "10", amount: "", validFromLocal: "", validUntilLocal: "", maxUses: "", maxUsesPerUser: "1", ticketTypeIds: [] as string[] };

export function discountLabel(c: Pick<ManagedCoupon, "discountType" | "percentBps" | "amountCents">) {
  return c.discountType === "PERCENT" ? `${((c.percentBps ?? 0) / 100).toLocaleString("pt-BR")}% de desconto` : `${formatBRL(c.amountCents ?? 0)} por ingresso`;
}

function parsePercentToBps(v: string): number | null {
  const n = Number(v.replace(",", ".").trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

const limitOrNull = (v: string) => (v.trim() ? Number(v) : null);

/** `eventId` nulo = cupons da organização inteira (página /organizador/cupons). */
export function CouponsManager({ eventId, items, ticketTypes, locked }: { eventId: string | null; items: ManagedCoupon[]; ticketTypes: CouponTicketOption[]; locked?: boolean }) {
  const orgMode = eventId === null;
  const [editing, setEditing] = useState<string | null>(null);
  const [f, setF] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const editingUsed = items.find((c) => c.id === editing)?.used ?? false;

  const edit = (c: ManagedCoupon) => {
    setEditing(c.id);
    setWarnings([]);
    setF({
      code: c.code,
      description: c.description ?? "",
      discountType: c.discountType,
      percent: c.percentBps ? String(c.percentBps / 100).replace(".", ",") : "",
      amount: c.amountCents ? centsToInput(c.amountCents) : "",
      validFromLocal: c.validFromLocal,
      validUntilLocal: c.validUntilLocal,
      maxUses: c.maxUses ? String(c.maxUses) : "",
      maxUsesPerUser: c.maxUsesPerUser ? String(c.maxUsesPerUser) : "",
      ticketTypeIds: c.ticketTypeIds,
    });
  };

  const close = () => (setEditing(null), setF(empty), setError(null));

  const save = () => {
    const percentBps = f.discountType === "PERCENT" ? parsePercentToBps(f.percent) : null;
    const amountCents = f.discountType === "FIXED_PER_TICKET" ? parseBRLToCents(f.amount) : null;
    if (f.discountType === "PERCENT" && percentBps === null) return setError("Percentual inválido. Use, por exemplo, 10 ou 12,5.");
    if (f.discountType === "FIXED_PER_TICKET" && !amountCents) return setError("Valor inválido. Use o formato 10,00.");
    const input: CouponInput = {
      code: f.code,
      description: f.description || undefined,
      discountType: f.discountType as CouponInput["discountType"],
      percentBps,
      amountCents,
      validFromLocal: f.validFromLocal,
      validUntilLocal: f.validUntilLocal,
      maxUses: limitOrNull(f.maxUses),
      maxUsesPerUser: limitOrNull(f.maxUsesPerUser),
      ticketTypeIds: f.ticketTypeIds,
    };
    start(async () => {
      const res = await saveCouponAction(eventId, editing && editing !== "new" ? editing : null, input);
      if (!res.ok) return setError(res.error);
      setWarnings(res.data.warnings);
      close();
    });
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? null);
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {orgMode
          ? "Cupons daqui valem em todos os eventos da organização, nos ingressos pagos (exceto meia-entrada). Validade no horário de Brasília. "
          : "O comprador digita o código no checkout. "}
        O desconto sai do seu repasse e não vale para meia-entrada. Cupom já usado não pode ser apagado, só desativado.
        {!orgMode && items.some((c) => c.organizationWide) && " Cupons da organização inteira são editados em Cupons, no menu do painel."}
      </p>
      {items.length === 0 && <p className="text-sm text-muted-foreground">Nenhum cupom cadastrado.</p>}
      <ul className="space-y-2">
        {items.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border p-4" data-testid="coupon">
            <div>
              <p className="font-mono font-semibold">
                {c.code} {c.disabled && <Badge variant="warning">Desativado</Badge>} {c.organizationWide && <Badge>Toda a organização</Badge>}
              </p>
              <p className="text-xs text-muted-foreground">
                {discountLabel(c)} · usados {c.timesRedeemed}
                {c.maxUses ? ` de ${c.maxUses}` : ""} · em pagamento {c.timesReserved} · {c.maxUsesPerUser ? `${c.maxUsesPerUser} por comprador` : "sem limite por comprador"}
                {c.ticketTypeIds.length ? ` · ${c.ticketTypeIds.length} tipo(s) de ingresso` : ""}
                {c.description ? ` · ${c.description}` : ""}
              </p>
            </div>
            {!locked && c.organizationWide === orgMode && (
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => edit(c)}>
                  <Pencil aria-hidden /> Editar
                </Button>
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setCouponDisabledAction(c.id, !c.disabled))}>
                  {c.disabled ? (
                    <>
                      <RotateCcw aria-hidden /> Reativar
                    </>
                  ) : (
                    <>
                      <Ban aria-hidden /> Desativar
                    </>
                  )}
                </Button>
                {!c.used && (
                  <Button variant="ghost" size="sm" className="text-destructive" disabled={pending} onClick={() => run(() => deleteCouponAction(c.id))}>
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
            <div>
              <Label htmlFor="cp-code">Código</Label>
              <Input
                id="cp-code"
                className="mt-1.5 font-mono uppercase"
                value={f.code}
                disabled={editingUsed}
                onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })}
                placeholder="EX.: AMIGOS10"
              />
            </div>
            <div>
              <Label htmlFor="cp-type">Desconto</Label>
              <Select id="cp-type" className="mt-1.5" value={f.discountType} disabled={editingUsed} onChange={(e) => setF({ ...f, discountType: e.target.value })}>
                <option value="PERCENT">Percentual</option>
                <option value="FIXED_PER_TICKET">Valor fixo por ingresso</option>
              </Select>
            </div>
            <div>
              {f.discountType === "PERCENT" ? (
                <>
                  <Label htmlFor="cp-percent">Percentual (%)</Label>
                  <Input id="cp-percent" className="mt-1.5" inputMode="decimal" value={f.percent} disabled={editingUsed} onChange={(e) => setF({ ...f, percent: e.target.value })} placeholder="10" />
                </>
              ) : (
                <>
                  <Label htmlFor="cp-amount">Valor por ingresso (R$)</Label>
                  <Input id="cp-amount" className="mt-1.5" inputMode="decimal" value={f.amount} disabled={editingUsed} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="10,00" />
                </>
              )}
            </div>
            <div>
              <Label htmlFor="cp-from">Válido a partir de (opcional)</Label>
              <Input id="cp-from" type="datetime-local" className="mt-1.5" value={f.validFromLocal} onChange={(e) => setF({ ...f, validFromLocal: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="cp-until">Válido até (opcional)</Label>
              <Input id="cp-until" type="datetime-local" className="mt-1.5" value={f.validUntilLocal} onChange={(e) => setF({ ...f, validUntilLocal: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="cp-max">Usos no total</Label>
                <Input id="cp-max" type="number" min={1} className="mt-1.5" value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} placeholder="Sem limite" />
              </div>
              <div>
                <Label htmlFor="cp-per-user">Por comprador</Label>
                <Input id="cp-per-user" type="number" min={1} className="mt-1.5" value={f.maxUsesPerUser} onChange={(e) => setF({ ...f, maxUsesPerUser: e.target.value })} placeholder="Sem limite" />
              </div>
            </div>
            {ticketTypes.length > 0 && (
              <fieldset className="sm:col-span-3">
                <legend className="text-sm font-medium">Vale para (nenhum marcado = todos os ingressos pagos, exceto meia-entrada)</legend>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {ticketTypes.map((t) => (
                    <label key={t.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={f.ticketTypeIds.includes(t.id)}
                        onChange={(e) => setF({ ...f, ticketTypeIds: e.target.checked ? [...f.ticketTypeIds, t.id] : f.ticketTypeIds.filter((id) => id !== t.id) })}
                      />
                      {t.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="sm:col-span-3">
              <Label htmlFor="cp-desc">Descrição interna (opcional)</Label>
              <Input id="cp-desc" className="mt-1.5" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Ex.: parceria com a rádio" />
            </div>
            {editingUsed && <p className="text-xs text-muted-foreground sm:col-span-3">Este cupom já foi usado: código e desconto não podem mais mudar.</p>}
            <div className="flex gap-2 sm:col-span-3">
              <Button onClick={save} disabled={pending}>
                {pending ? "Salvando…" : "Salvar cupom"}
              </Button>
              <Button variant="ghost" onClick={close}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" onClick={() => (setEditing("new"), setWarnings([]))}>
            Criar cupom
          </Button>
        ))}
      {warnings.length > 0 && (
        <Alert variant="warning">
          Cupom salvo, com avisos:
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      {error && <Alert variant="danger">{error}</Alert>}
    </div>
  );
}
