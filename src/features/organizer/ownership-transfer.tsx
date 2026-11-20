"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { formatDateTimeShort } from "@/lib/datetime";
import { acceptOwnershipTransferAction, cancelOwnershipTransferAction, declineOwnershipTransferAction, requestOwnershipTransferAction } from "./actions";

/**
 * Tela da equipe (só para o responsável): escolhe o novo dono, confirma com a senha e
 * acompanha o pedido pendente. Nada muda até o membro aceitar pelo link do e-mail.
 */
export function OwnershipTransferPanel({
  members,
  pending,
  needsPassword,
}: {
  members: { userId: string; name: string; email: string }[];
  pending: { toName: string | null; toEmail: string | null; expiresAt: Date } | null;
  needsPassword: boolean;
}) {
  const [toUserId, setTo] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();

  return (
    <div className="space-y-3" data-testid="ownership-transfer">
      <h3 className="text-sm font-bold">Transferir a organização</h3>
      <p className="text-xs text-muted-foreground">
        O membro escolhido recebe um e-mail e precisa aceitar com a própria conta. No aceite, ele passa a responsável e você continua na equipe como administrador.
      </p>
      {pending ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-warning/40 bg-warning-soft p-3 text-sm">
          <span>
            Aguardando <strong>{pending.toName ?? pending.toEmail}</strong> aceitar · válido até {formatDateTimeShort(pending.expiresAt)}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              start(async () => {
                const r = await cancelOwnershipTransferAction();
                setMsg(r.ok ? { ok: true, text: "Transferência cancelada." } : { ok: false, text: r.error });
              })
            }
          >
            Cancelar pedido
          </Button>
        </div>
      ) : members.length === 0 ? (
        <p className="text-xs text-muted-foreground">Convide alguém para a equipe antes de transferir a organização.</p>
      ) : (
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            setMsg(null);
            start(async () => {
              const r = await requestOwnershipTransferAction(toUserId, password);
              setPassword("");
              setMsg(r.ok ? { ok: true, text: "Pedido enviado. O novo responsável recebeu o link por e-mail." } : { ok: false, text: r.error });
            });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="ownership-to">Novo responsável</Label>
            <Select id="ownership-to" value={toUserId} onChange={(e) => setTo(e.target.value)} required disabled={busy}>
              <option value="">Escolha um membro</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} ({m.email})
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ownership-password">{needsPassword ? "Sua senha" : "Sua senha (opcional: conta Google)"}</Label>
            <Input id="ownership-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required={needsPassword} disabled={busy} />
          </div>
          <div className="flex items-end">
            <Button type="submit" variant="outline" disabled={busy || !toUserId}>
              Pedir transferência
            </Button>
          </div>
        </form>
      )}
      {msg && (
        <p role="status" className={msg.ok ? "text-xs text-success" : "text-xs text-destructive"}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** Página do link: o novo responsável aceita ou recusa. */
export function OwnershipTransferResponse({ token }: { token: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  if (declined) return <Alert variant="success">Transferência recusada. Nada mudou na organização.</Alert>;
  return (
    <>
      <Button
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await acceptOwnershipTransferAction(token);
            if (r.ok) router.push("/organizador/equipe");
            else setError(r.error);
          })
        }
      >
        {busy ? "Aguarde…" : "Aceitar e virar responsável"}
      </Button>
      <Button
        variant="ghost"
        className="w-full"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await declineOwnershipTransferAction(token);
            if (r.ok) setDeclined(true);
            else setError(r.error);
          })
        }
      >
        Recusar
      </Button>
      {error && <Alert variant="danger">{error}</Alert>}
    </>
  );
}
