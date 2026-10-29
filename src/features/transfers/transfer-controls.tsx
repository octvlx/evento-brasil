"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { acceptTransferAction, cancelTransferAction, declineTransferAction, requestTransferAction } from "@/features/checkin/transfer-actions";
import { formatDateTimeShort, timezoneLabel } from "@/lib/datetime";
import { transferCutoff, TRANSFER_ACCEPT_WINDOW_HOURS, type TransferPolicy } from "@/lib/transfer-policy";

/** Regras do evento, mostradas antes de solicitar uma transferência. */
export function TransferRules({ policy, startsAt, timezone }: { policy: TransferPolicy; startsAt: string; timezone: string }) {
  const cutoff = transferCutoff(startsAt, policy);
  return (
    <div className="space-y-1 rounded-xl bg-muted p-3 text-xs text-muted-foreground" data-testid="transfer-rules">
      <ul className="list-disc space-y-1 pl-4">
        <li>A transferência é gratuita.</li>
        <li>
          A solicitação e o aceite devem ocorrer até {formatDateTimeShort(cutoff, timezone)} ({timezoneLabel(cutoff, timezone)}, horário do evento),
          {policy.transferDeadlineHours === 0 ? " antes do início do evento." : ` ${policy.transferDeadlineHours} ${policy.transferDeadlineHours === 1 ? "hora" : "horas"} antes do início do evento.`}
        </li>
        <li>Quem recebe precisa aceitar em até {TRANSFER_ACCEPT_WINDOW_HOURS} horas do convite, respeitando esse prazo, entrando com a conta do e-mail informado.</li>
        <li>Ao aceitar, o ingresso ganha um novo QR code no nome de quem recebeu. O QR, o PDF e os passes de carteira que você tem agora deixam de valer.</li>
        <li>A transferência não muda o comprador do pedido: um eventual reembolso volta para quem pagou, não para quem recebeu.</li>
        <li>Cada ingresso pode ter no máximo {policy.transferMaxTransfers} {policy.transferMaxTransfers === 1 ? "transferência aceita" : "transferências aceitas"}.</li>
        <li>Você pode cancelar o convite enquanto ele ainda não foi aceito.</li>
        <li>
          {policy.transferAllowReturn
            ? "Depois do aceite não há desfazer. Uma devolução a um titular anterior exige uma nova transferência, iniciada pelo titular atual e aceita pelo destinatário, e também conta para o limite."
            : "Depois do aceite não é possível desfazer nem devolver o ingresso a um titular anterior."}
        </li>
      </ul>
    </div>
  );
}

/** Botão "Transferir" + formulário com confirmação, por ingresso. */
export function TransferForm({
  ticketId,
  ticketLabel,
  policy,
  startsAt,
  timezone,
  defaultOpen = false,
}: {
  ticketId: string;
  ticketLabel: string;
  policy: TransferPolicy;
  startsAt: string;
  timezone: string;
  /** Já aberto e rolado até a vista (link `?transferir=` da página do ingresso). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (defaultOpen) formRef.current?.scrollIntoView({ block: "center" });
  }, [defaultOpen]);
  const [confirming, setConfirming] = useState(false);
  const [toName, setToName] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (done) return <Alert variant="success">{done}</Alert>;
  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`Transferir ${ticketLabel}`}>
        Transferir
      </Button>
    );

  const submit = () =>
    start(async () => {
      const r = await requestTransferAction(ticketId, { toName, toEmail });
      if (r.ok) setDone(`Convite enviado para ${toEmail.trim().toLowerCase()}. O ingresso continua seu até a pessoa aceitar.`);
      else {
        setError(r.error);
        setConfirming(false);
      }
    });

  return (
    <form
      ref={formRef}
      className="w-full space-y-3 rounded-2xl border border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setConfirming(true);
      }}
    >
      <p className="font-semibold">Transferir {ticketLabel}</p>
      {error && <Alert variant="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`to-name-${ticketId}`}>Nome de quem vai receber</Label>
          <Input id={`to-name-${ticketId}`} value={toName} onChange={(e) => setToName(e.target.value)} required minLength={2} maxLength={200} disabled={confirming || pending} autoComplete="off" />
        </div>
        <div>
          <Label htmlFor={`to-email-${ticketId}`}>E-mail de quem vai receber</Label>
          <Input id={`to-email-${ticketId}`} type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} required maxLength={254} disabled={confirming || pending} autoComplete="off" />
        </div>
      </div>
      <TransferRules policy={policy} startsAt={startsAt} timezone={timezone} />
      {confirming ? (
        <div className="space-y-2 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm">
          <p>
            Confirmar a transferência para <strong>{toName.trim()}</strong> ({toEmail.trim().toLowerCase()})? Depois do aceite, o seu QR code deixa de valer.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={submit}>
              {pending ? "Enviando…" : "Sim, transferir"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Voltar
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm">
            Continuar
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Fechar
          </Button>
        </div>
      )}
    </form>
  );
}

/** "Cancelar" numa transferência enviada que ainda não foi aceita. */
export function CancelTransferButton({ transferId }: { transferId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await cancelTransferAction(transferId);
            if (!r.ok) setError(r.error);
          })
        }
      >
        {pending ? "Cancelando…" : "Cancelar transferência"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}

/**
 * Aceitar / Recusar uma transferência recebida, direto em "Meus ingressos". Aceita: vai para
 * o ingresso (QR novo), como no link do e-mail — o cartão some da lista ao atualizar.
 */
export function IncomingTransferActions({ transferId }: { transferId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (msg?.ok) return <Alert variant="success">{msg.text}</Alert>;
  return (
    <div className="space-y-2">
      {msg && <Alert variant="danger">{msg.text}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await acceptTransferAction({ transferId });
              if (r.ok) router.push(`/ingressos/${r.data.ticketCode}`);
              else setMsg({ ok: false, text: r.error });
            })
          }
        >
          {pending ? "Processando…" : "Aceitar"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await declineTransferAction({ transferId });
              setMsg(r.ok ? { ok: true, text: "Transferência recusada. O ingresso continua com quem enviou." } : { ok: false, text: r.error });
            })
          }
        >
          Recusar
        </Button>
      </div>
    </div>
  );
}
