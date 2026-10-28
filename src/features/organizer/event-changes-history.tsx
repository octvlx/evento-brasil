"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge, FieldError, Input, Label, Textarea } from "@/components/ui/primitives";
import { formatDateTimeShort } from "@/lib/datetime";
import { extendEventChangeAction } from "./actions";
import { CHANGE_REASON_MIN, describeChangeValue, refundRequestsText, isRelevantField, RELEVANT_FIELD_LABELS, type ChangeSnapshotJson } from "./event-change-rules";

export interface EventChangeItem {
  id: string;
  createdAt: string;
  actorName: string;
  changedFields: string[];
  before: ChangeSnapshotJson;
  after: ChangeSnapshotJson;
  reason: string;
  refundUntil: string | null;
  extendsChangeId: string | null;
  effectiveRefundUntil: string | null;
  windowOpen: boolean;
  /** Compradores que pediram reembolso por esta alteração (nulo numa prorrogação). */
  refundRequests: { buyers: number; refunded: number } | null;
  /** Prazo vigente no formato do campo datetime-local (horário do evento). */
  effectiveRefundUntilLocal: string | null;
}

/** Histórico de alterações relevantes (somente leitura) com prorrogação da janela de reembolso. */
export function EventChangesHistory({ items, timezone, maxLocal, canExtend }: { items: EventChangeItem[]; timezone: string; maxLocal: string; canExtend: boolean }) {
  if (!items.length)
    return <p className="text-sm text-muted-foreground">Nenhuma alteração relevante registrada. Mudanças de data, horário, local, cidade ou formato com ingressos vendidos aparecem aqui.</p>;
  return (
    <ol className="space-y-4">
      {items.map((c) => (
        <li key={c.id} className="rounded-2xl border border-border p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{c.extendsChangeId ? "Prorrogação do prazo de reembolso" : "Alteração relevante"}</span>
            <span className="text-muted-foreground">
              {formatDateTimeShort(new Date(c.createdAt), timezone)} · {c.actorName}
            </span>
            {!c.extendsChangeId && (c.windowOpen ? <Badge variant="warning">Janela de reembolso aberta</Badge> : <Badge>Janela encerrada</Badge>)}
          </div>
          {c.changedFields.length > 0 && (
            <ul className="mt-2 space-y-1">
              {c.changedFields.filter(isRelevantField).map((f) => (
                <li key={f}>
                  <span className="text-muted-foreground">{RELEVANT_FIELD_LABELS[f]}:</span> {describeChangeValue(f, c.before, timezone)} → <strong>{describeChangeValue(f, c.after, timezone)}</strong>
                </li>
              ))}
            </ul>
          )}
          {c.extendsChangeId && c.before.refundUntil && c.after.refundUntil && (
            <p className="mt-2">
              Prazo: {formatDateTimeShort(new Date(c.before.refundUntil), timezone)} → <strong>{formatDateTimeShort(new Date(c.after.refundUntil), timezone)}</strong>
            </p>
          )}
          <p className="mt-2">
            <span className="text-muted-foreground">Motivo:</span> {c.reason}
          </p>
          {!c.extendsChangeId && c.effectiveRefundUntil && (
            <p className="mt-1">
              <span className="text-muted-foreground">Reembolso integral até:</span> {formatDateTimeShort(new Date(c.effectiveRefundUntil), timezone)} (pedidos pagos antes da alteração)
            </p>
          )}
          {c.refundRequests && <p className="mt-1">{refundRequestsText(c.refundRequests)}</p>}
          {canExtend && c.windowOpen && <ExtendForm change={c} maxLocal={maxLocal} />}
        </li>
      ))}
    </ol>
  );
}

function ExtendForm({ change, maxLocal }: { change: EventChangeItem; maxLocal: string }) {
  const [open, setOpen] = useState(false);
  const [until, setUntil] = useState(change.effectiveRefundUntilLocal ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open)
    return (
      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setOpen(true)}>
        Prorrogar prazo de reembolso
      </Button>
    );
  const submit = () =>
    start(async () => {
      setError(null);
      if (reason.trim().length < CHANGE_REASON_MIN) return setError(`Descreva o motivo com pelo menos ${CHANGE_REASON_MIN} caracteres.`);
      const res = await extendEventChangeAction(change.id, until, reason);
      if (!res.ok) return setError(res.error);
      setOpen(false);
      setReason("");
    });
  return (
    <div className="mt-3 grid gap-3 rounded-xl bg-muted/50 p-3 sm:grid-cols-2">
      <div>
        <Label htmlFor={`until-${change.id}`}>Novo prazo (horário do evento)</Label>
        <Input id={`until-${change.id}`} type="datetime-local" className="mt-1.5" min={change.effectiveRefundUntilLocal ?? undefined} max={maxLocal} value={until} onChange={(e) => setUntil(e.target.value)} />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={`reason-${change.id}`}>Motivo da prorrogação (enviado aos compradores)</Label>
        <Textarea id={`reason-${change.id}`} className="mt-1.5" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
        <FieldError message={error ?? undefined} />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="button" size="sm" disabled={pending} onClick={submit}>
          {pending ? "Salvando…" : "Prorrogar e avisar compradores"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
