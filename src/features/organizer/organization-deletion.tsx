"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Textarea } from "@/components/ui/primitives";
import { formatDateTimeShort } from "@/lib/datetime";
import { DELETION_REQUEST_STATUS } from "@/lib/organization-deletion";
import type { OrganizationDeletionRequestStatus } from "@/generated/prisma/client";
import { cancelOrganizationDeletionAction, requestOrganizationDeletionAction } from "./actions";

type LatestRequest = { status: OrganizationDeletionRequestStatus; createdAt: Date; decidedAt: Date | null; reason: string | null; decisionNote: string | null } | null;

/**
 * Configurações (só para o responsável): pede a exclusão da organização. Nada muda até a
 * plataforma aprovar; enquanto o pedido estiver pendente, dá para cancelar.
 */
export function OrganizationDeletionPanel({
  organizationName,
  latest,
  blockers,
  needsPassword,
}: {
  organizationName: string;
  latest: LatestRequest;
  blockers: string[];
  needsPassword: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const pending = latest?.status === "PENDING";

  return (
    <div className="space-y-3" data-testid="org-deletion">
      <h2 className="font-display text-lg font-bold">Excluir organização</h2>
      <p className="text-sm text-muted-foreground">
        A exclusão é analisada pela plataforma. Quando aprovada, {organizationName} sai da vitrine, a equipe perde o acesso, o perfil público é apagado e o Mercado Pago é
        desconectado. Vendas, pagamentos, reembolsos e dados fiscais ficam guardados pelo prazo legal.
      </p>

      {latest && (
        <div className={pending ? "rounded-2xl border border-warning/40 bg-warning-soft p-3 text-sm" : "rounded-2xl border border-border p-3 text-sm"} role="status" data-testid="org-deletion-status">
          <p>
            Último pedido, em {formatDateTimeShort(latest.createdAt)}: <strong>{DELETION_REQUEST_STATUS[latest.status].label}</strong>
            {latest.decidedAt && !pending ? ` (${formatDateTimeShort(latest.decidedAt)})` : ""}
          </p>
          {latest.reason && <p className="text-xs text-muted-foreground">Seu motivo: {latest.reason}</p>}
          {latest.status === "REJECTED" && latest.decisionNote && <p className="text-xs text-destructive">Motivo da recusa: {latest.decisionNote}</p>}
          {pending && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  const r = await cancelOrganizationDeletionAction();
                  setMsg(r.ok ? { ok: true, text: "Pedido de exclusão cancelado. Nada mudou na organização." } : { ok: false, text: r.error });
                })
              }
            >
              Cancelar pedido de exclusão
            </Button>
          )}
        </div>
      )}

      {!pending && blockers.length > 0 && (
        <Alert variant="warning" data-testid="org-deletion-blockers">
          <p className="font-semibold">Ainda não dá para pedir a exclusão:</p>
          <ul className="list-disc pl-4">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Alert>
      )}

      {!pending && blockers.length === 0 && !open && (
        <Button type="button" variant="destructive" size="sm" onClick={() => setOpen(true)}>
          Pedir exclusão da organização
        </Button>
      )}

      {!pending && blockers.length === 0 && open && (
        <form
          className="space-y-3 rounded-2xl border border-destructive/50 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setMsg(null);
            start(async () => {
              const r = await requestOrganizationDeletionAction(password, reason);
              setPassword("");
              if (r.ok) {
                setOpen(false);
                setReason("");
                setMsg({ ok: true, text: "Pedido enviado. A plataforma vai analisar; você pode cancelar enquanto estiver pendente." });
              } else setMsg({ ok: false, text: r.error });
            });
          }}
        >
          <p className="text-sm font-semibold">Pedir a exclusão de {organizationName}?</p>
          <div className="space-y-1">
            <Label htmlFor="org-deletion-reason">Motivo (opcional)</Label>
            <Textarea id="org-deletion-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} disabled={busy} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="org-deletion-password">{needsPassword ? "Sua senha, para confirmar" : "Sua senha (opcional: conta Google)"}</Label>
            <Input id="org-deletion-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required={needsPassword} disabled={busy} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" size="sm" disabled={busy}>
              {busy ? "Enviando…" : "Enviar pedido de exclusão"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Voltar
            </Button>
          </div>
        </form>
      )}

      {msg && (
        <p role="status" className={msg.ok ? "whitespace-pre-line text-sm text-success" : "whitespace-pre-line text-sm text-destructive"}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
