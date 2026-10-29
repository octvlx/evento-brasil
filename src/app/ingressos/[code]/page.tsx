import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import QRCode from "qrcode";
import Link from "next/link";
import { ArrowLeft, ArrowLeftRight, Building2, Download, MapPin, Receipt, Wallet } from "lucide-react";
import { Alert, Badge, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { qrPayload } from "@/server/services/tickets";
import { transferBlockedReason } from "@/server/services/transfers";
import { organizerIdentity, organizerIdentityLine } from "@/server/tickets/organizer-identity";
import { formatDateLong, formatDateTimeShort, formatTime, timezoneLabel } from "@/lib/datetime";
import { transferCutoff } from "@/lib/transfer-policy";
import { TICKET_STATUS } from "@/lib/labels";
import { revocationText } from "@/features/orders/status-view";
import { PrintButton } from "@/features/orders/print-button";
import { walletAvailability } from "@/server/tickets/wallet";

export const metadata: Metadata = { title: "Ingresso", robots: { index: false } };

export default function TicketPage({ params }: PageProps<"/ingressos/[code]">) {
  return (
    <div className="mx-auto max-w-md px-4 py-6 print:max-w-none print:p-0">
      <Suspense fallback={<Skeleton className="h-[560px] rounded-3xl" />}>
        <TicketContent params={params} />
      </Suspense>
    </div>
  );
}

async function TicketContent({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const user = await requireUser(`/ingressos/${code}`);
  const t = await db.issuedTicket.findUnique({
    where: { code },
    include: { ticketType: true, order: { select: { id: true, publicCode: true, isSimulated: true, status: true } }, event: { include: { venue: { include: { city: true } }, city: true } } },
  });
  if (!t) notFound();
  // Histórico de transferências do ingresso (poucas linhas: limite de aceites definido no evento).
  const transfers = await db.ticketTransfer.findMany({
    where: { ticketId: t.id },
    orderBy: { createdAt: "desc" },
    select: { status: true, fromUserId: true, fromHolderName: true, toUserId: true, toEmail: true, toHolderName: true, expiresAt: true, decidedAt: true },
  });
  const now = new Date();
  const tz = t.event.timezone;
  // Só o titular atual vê o ingresso (R6). Quem o transferiu vê um aviso, sem QR nem dados
  // do novo titular além do nome que ele mesmo indicou; os demais, 404 (não revela existência).
  if (t.holderUserId !== user.id) {
    const gaveAway = transfers.find((tr) => tr.status === "ACCEPTED" && tr.fromUserId === user.id);
    if (!gaveAway) notFound();
    return <TransferredAway eventTitle={t.event.title} ticketTypeName={t.ticketType.name} code={t.code} toName={gaveAway.toHolderName} when={gaveAway.decidedAt ? formatDateTimeShort(gaveAway.decidedAt, tz) : null} />;
  }
  const st = TICKET_STATUS[t.status];
  const organizer = await organizerIdentity(db, t.event.organizationId);
  const cutoff = transferCutoff(t.event.startsAt, t.event);
  const pendingOut = transfers.find((tr) => tr.status === "PENDING" && tr.fromUserId === user.id && tr.expiresAt && Math.min(tr.expiresAt.getTime(), cutoff.getTime()) > now.getTime());
  const pendingExpiresAt = pendingOut?.expiresAt ? new Date(Math.min(pendingOut.expiresAt.getTime(), cutoff.getTime())) : null;
  const received = transfers.find((tr) => tr.status === "ACCEPTED" && tr.toUserId === user.id);
  const acceptedCount = transfers.filter((tr) => tr.status === "ACCEPTED").length;
  // Contrato com paginas-publicas (Fase 4): o formulário de transferência fica em
  // /meus-ingressos e abre para o ingresso indicado em ?transferir=<código>.
  // Pendente vencida não bloqueia: requestTransfer a expira antes de criar a nova.
  const canTransfer = !pendingOut && transferBlockedReason(t, now) === null && acceptedCount < t.event.transferMaxTransfers;
  const city = t.event.venue?.city ?? t.event.city;
  // Botões de carteira só quando a conta da Apple/Google estiver configurada (docs/wallet.md).
  const wallet = t.status === "VALID" ? walletAvailability() : { apple: false, google: false };
  const svg = t.status === "VALID" ? await QRCode.toString(qrPayload(t), { type: "svg", margin: 1, errorCorrectionLevel: "M" }) : null;

  return (
    <>
      <nav aria-label="Navegação do ingresso" className="mb-4 flex items-center justify-between gap-3 text-sm print:hidden">
        <Link href="/meus-ingressos" className="inline-flex items-center gap-1.5 rounded-lg font-semibold text-secondary hover:underline">
          <ArrowLeft className="size-4" aria-hidden /> Meus ingressos
        </Link>
        <Link href={`/pedido/${t.order.id}`} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline">
          <Receipt className="size-4" aria-hidden /> Ver pedido
        </Link>
      </nav>
      <article className="overflow-hidden rounded-3xl border border-border bg-card shadow-xl [print-color-adjust:exact] print:mx-auto print:max-w-md print:shadow-none">
        <div className="bg-hero p-6 text-white">
          <p className="text-xs font-semibold uppercase tracking-widest text-white/70">{t.ticketType.name}</p>
          <h1 className="mt-1 font-display text-2xl font-extrabold leading-tight">{t.event.title}</h1>
          <p className="mt-2 text-sm text-white/85 first-letter:uppercase">
            {formatDateLong(t.event.startsAt, tz)} · {formatTime(t.event.startsAt, tz)} ({timezoneLabel(t.event.startsAt, tz)})
          </p>
          <p className="mt-1 flex items-center gap-1 text-sm text-white/85">
            <MapPin className="size-3.5" aria-hidden /> {t.event.locationType === "ONLINE" ? "Online" : [t.event.venue?.name, city && `${city.name} – ${city.state}`].filter(Boolean).join(", ")}
          </p>
        </div>
        <div className="relative border-t-2 border-dashed border-border p-6 text-center">
          {t.order.isSimulated && <Alert variant="warning" className="mb-4 text-left">Ingresso de teste (pagamento simulado). Sem validade real.</Alert>}
          {svg ? (
            <div className="mx-auto w-64 rounded-2xl bg-white p-3 [&_svg]:h-auto [&_svg]:w-full" role="img" aria-label="QR code do ingresso" dangerouslySetInnerHTML={{ __html: svg }} />
          ) : (
            <div className="mx-auto grid size-64 place-items-center rounded-2xl bg-muted text-sm text-muted-foreground">
              {t.status === "CHECKED_IN" ? "Ingresso já utilizado" : revocationText(t.revocationReason)}
            </div>
          )}
          <p className="mt-4 font-mono text-lg font-bold tracking-[0.2em]">{t.code}</p>
          <div className="mt-2 flex items-center justify-center gap-2">
            <Badge variant={st.tone === "success" ? "success" : st.tone === "danger" ? "danger" : "default"}>{st.label}</Badge>
            <span className="text-xs text-muted-foreground">Pedido {t.order.publicCode}</span>
          </div>
          <p className="mt-3 text-sm">
            Titular: <strong>{t.holderName}</strong>
          </p>
          {t.ticketType.kind === "HALF_PRICE" && <p className="mt-1 text-xs text-warning">Meia-entrada: apresente o documento comprobatório na entrada.</p>}
          {received && (
            <Alert variant="info" className="mt-4 text-left print:hidden">
              Recebido por transferência de <strong>{received.fromHolderName}</strong>
              {received.decidedAt && <> em {formatDateTimeShort(received.decidedAt, tz)}</>}. Este ingresso ganhou um novo QR code: QR, PDF e passes de carteira
              anteriores não valem mais na entrada.
            </Alert>
          )}
          {pendingOut && (
            <Alert variant="warning" className="mt-4 text-left print:hidden">
              Transferência pendente para <strong>{pendingOut.toHolderName ?? pendingOut.toEmail}</strong> ({pendingOut.toEmail})
              {pendingExpiresAt && <>, válida até {formatDateTimeShort(pendingExpiresAt, tz)}</>}. O ingresso continua com você até o aceite.{" "}
              <Link href="/meus-ingressos" className="font-semibold underline">
                Gerenciar ou cancelar
              </Link>
            </Alert>
          )}
          {t.status !== "REVOKED" && (
            <div className="mt-5 flex flex-wrap justify-center gap-2 print:hidden">
              <a href={`/api/tickets/${t.code}/pdf`} target="_blank" rel="noopener" className={buttonVariants({ variant: "outline" })}>
                <Download aria-hidden /> Salvar PDF
              </a>
              <PrintButton />
              {canTransfer && (
                <Link href={`/meus-ingressos?transferir=${encodeURIComponent(t.code)}`} className={buttonVariants({ variant: "outline" })}>
                  <ArrowLeftRight aria-hidden /> Transferir ingresso
                </Link>
              )}
              {wallet.apple && (
                <a href={`/api/tickets/${t.code}/wallet/apple`} className={buttonVariants({ variant: "outline" })}>
                  <Wallet aria-hidden /> Adicionar à Apple Wallet
                </a>
              )}
              {wallet.google && (
                <a href={`/api/tickets/${t.code}/wallet/google`} className={buttonVariants({ variant: "outline" })}>
                  <Wallet aria-hidden /> Salvar no Google Wallet
                </a>
              )}
            </div>
          )}
          <p className="mt-4 text-xs text-muted-foreground">Não compartilhe este QR code: ele é validado uma única vez na entrada.</p>
          {organizer && (
            <p className="mt-3 flex items-start justify-center gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
              <Building2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                Organizador responsável: <span className="font-medium text-foreground">{organizerIdentityLine(organizer)}</span>
              </span>
            </p>
          )}
        </div>
      </article>
    </>
  );
}

/** Para quem transferiu o ingresso: o QR que tinha deixou de valer. */
function TransferredAway({ eventTitle, ticketTypeName, code, toName, when }: { eventTitle: string; ticketTypeName: string; code: string; toName: string | null; when: string | null }) {
  return (
    <>
      <nav aria-label="Navegação do ingresso" className="mb-4 text-sm">
        <Link href="/meus-ingressos" className="inline-flex items-center gap-1.5 rounded-lg font-semibold text-secondary hover:underline">
          <ArrowLeft className="size-4" aria-hidden /> Meus ingressos
        </Link>
      </nav>
      <article className="rounded-3xl border border-border bg-card p-6 shadow-xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{ticketTypeName}</p>
        <h1 className="mt-1 font-display text-2xl font-extrabold leading-tight">{eventTitle}</h1>
        <p className="mt-1 font-mono text-sm tracking-[0.2em] text-muted-foreground">{code}</p>
        <Alert variant="warning" className="mt-5">
          <p className="flex items-center gap-2 font-semibold">
            <ArrowLeftRight className="size-4" aria-hidden /> Você transferiu este ingresso
          </p>
          <p className="mt-1">
            {toName ? <>Agora ele está no nome de <strong>{toName}</strong></> : "Ele está com outra pessoa"}
            {when && <> desde {when}</>}. O QR code que você tinha, o PDF e os passes de carteira salvos antes da transferência não valem mais na entrada.
          </p>
        </Alert>
      </article>
    </>
  );
}
