"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import type { ActionResult } from "@/server/errors";
import { saveCommissionRuleAction } from "./actions";

/**
 * Redefinir o 2FA de outra pessoa (suporte): pede o motivo e o código do
 * aplicativo do próprio admin. O servidor revalida tudo.
 */
export function ResetTwoFactorButton({ action }: { action: (adminCode: string, reason: string) => Promise<ActionResult> }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Redefinir 2FA
      </Button>
    );
  return (
    <form
      className="flex max-w-xs flex-col gap-1.5 rounded-xl border border-border p-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await action(code, reason);
          if (!r.ok) setError(r.error);
          else {
            setOpen(false);
            setError(null);
          }
        });
      }}
    >
      <p className="text-xs">A pessoa perde o 2FA e as sessões abertas, recebe um e-mail e ativa de novo no próximo acesso.</p>
      <Input placeholder="Motivo (ex.: perdeu o celular; identidade confirmada)" value={reason} onChange={(e) => setReason(e.target.value)} className="h-9 text-xs" aria-label="Motivo da redefinição" />
      <Input
        placeholder="Seu código de 6 dígitos"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, "").slice(0, 7))}
        inputMode="numeric"
        autoComplete="one-time-code"
        className="h-9 font-mono text-xs"
        aria-label="Seu código do aplicativo autenticador"
      />
      <div className="flex gap-1">
        <Button size="sm" variant="destructive" disabled={pending || reason.trim().length < 5 || code.replace(/\s/g, "").length !== 6}>
          {pending ? "…" : "Redefinir"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Voltar
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

/** Botão de ação administrativa com motivo opcional/obrigatório e confirmação. */
export function AdminActionButton({
  label,
  action,
  variant = "outline",
  askReason,
  reasonRequired,
  confirm,
}: {
  label: string;
  action: (reason?: string) => Promise<ActionResult>;
  variant?: "outline" | "secondary" | "destructive" | "ghost" | "default";
  askReason?: string;
  reasonRequired?: boolean;
  confirm?: string;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const exec = () =>
    start(async () => {
      const r = await action(reason || undefined);
      if (!r.ok) setError(r.error);
      else {
        setOpen(false);
        setError(null);
      }
    });
  if (open && (askReason || confirm)) {
    return (
      <div className="flex flex-col gap-1.5 rounded-xl border border-border p-2">
        {confirm && <p className="text-xs">{confirm}</p>}
        {askReason && <Input placeholder={askReason} value={reason} onChange={(e) => setReason(e.target.value)} className="h-9 text-xs" aria-label={askReason} />}
        <div className="flex gap-1">
          <Button size="sm" variant={variant} disabled={pending || (reasonRequired && reason.trim().length < 3)} onClick={exec}>
            {pending ? "…" : "Confirmar"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Voltar
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }
  return (
    <span className="inline-flex flex-col">
      <Button size="sm" variant={variant} disabled={pending} onClick={() => (askReason || confirm ? setOpen(true) : exec())}>
        {pending ? "…" : label}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}

export function CommissionRuleForm({ orgs, events }: { orgs: { id: string; name: string }[]; events: { id: string; title: string }[] }) {
  const [state, action, pending] = useActionState(saveCommissionRuleAction, undefined);
  const [scope, setScope] = useState("PLATFORM");
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-3">
      <div>
        <Label htmlFor="scope">Escopo</Label>
        <Select id="scope" name="scope" value={scope} onChange={(e) => setScope(e.target.value)} className="mt-1.5">
          <option value="PLATFORM">Plataforma (padrão)</option>
          <option value="ORGANIZATION">Organização</option>
          <option value="EVENT">Evento</option>
        </Select>
      </div>
      {scope === "ORGANIZATION" && (
        <div className="sm:col-span-2">
          <Label htmlFor="organizationId">Organização</Label>
          <Select id="organizationId" name="organizationId" className="mt-1.5">
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {scope === "EVENT" && (
        <div className="sm:col-span-2">
          <Label htmlFor="eventId">Evento</Label>
          <Select id="eventId" name="eventId" className="mt-1.5">
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div>
        <Label htmlFor="percent">Comissão (%)</Label>
        <Input id="percent" name="percent" type="number" step="0.01" min={0} max={100} defaultValue="7" className="mt-1.5" />
      </div>
      <div>
        <Label htmlFor="fixedCentsPerTicket">Valor fixo por ingresso (centavos)</Label>
        <Input id="fixedCentsPerTicket" name="fixedCentsPerTicket" type="number" min={0} defaultValue="0" className="mt-1.5" />
      </div>
      <div>
        <Label htmlFor="bearer">Quem paga a comissão</Label>
        <Select id="bearer" name="bearer" className="mt-1.5">
          <option value="ORGANIZER">Organizador (descontada do repasse)</option>
          <option value="BUYER">Comprador (taxa de serviço destacada)</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="processingFeeBearer">Custo de processamento</Label>
        <Select id="processingFeeBearer" name="processingFeeBearer" className="mt-1.5">
          <option value="ORGANIZER">Organizador</option>
          <option value="PLATFORM">Plataforma</option>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="refundCommissionOnRefund" defaultChecked /> Devolver a comissão em reembolsos
      </label>
      {state && !state.ok && <Alert variant="danger" className="sm:col-span-3">{state.error}</Alert>}
      {state?.ok && <Alert variant="success" className="sm:col-span-3">Nova versão da regra criada. Pedidos anteriores mantêm a versão original.</Alert>}
      <div className="sm:col-span-3">
        <Button disabled={pending}>{pending ? "Salvando…" : "Criar nova versão da regra"}</Button>
      </div>
    </form>
  );
}
