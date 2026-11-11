import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftRight, CircleCheck, Clock, Ticket, UserX } from "lucide-react";
import { Alert, Card, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { DECLINED_BY_RECIPIENT, findTransferByToken, transferBlockedReason, transferRecipientBlockedReason } from "@/server/services/transfers";
import { transferCutoff } from "@/lib/transfer-policy";
import { formatDateTimeShort, formatEventDateTime } from "@/lib/datetime";
import { LogoutButton } from "@/features/auth/logout-button";
import { TransferResponse } from "@/features/checkin/transfer-response";

// Aceite de transferência (T-TRANSF, R6). Contrato em docs/areas/check-in.md.
export const metadata: Metadata = { title: "Transferência de ingresso", robots: { index: false }, referrer: "no-referrer" };

export default function TransferPage({ params }: PageProps<"/transferencia/[token]">) {
  return (
    <div className="mx-auto max-w-md px-4 py-8">
      <h1 className="font-display text-2xl font-extrabold tracking-tight">Transferência de ingresso</h1>
      <Suspense fallback={<Skeleton className="mt-6 h-64 rounded-3xl" />}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

/** "jo***@gmail.com": orienta qual conta usar sem expor o e-mail inteiro a quem não é o destinatário. */
function maskEmail(email: string) {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}${"*".repeat(Math.max(1, Math.min(user.length - 2, 6)))}@${domain}`;
}

function State({ icon: Icon, tone, title, children }: { icon: typeof Clock; tone: "info" | "success" | "warning" | "danger"; title: string; children?: React.ReactNode }) {
  return (
    <Alert variant={tone} className="mt-6 space-y-2" data-state={title}>
      <p className="flex items-center gap-2 font-semibold">
        <Icon className="size-4 shrink-0" aria-hidden /> {title}
      </p>
      {children}
    </Alert>
  );
}

async function Content({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await requireUser(`/transferencia/${token}`);
  const now = new Date();
  const t = await findTransferByToken(db, token);
  if (!t) {
    return (
      <State icon={UserX} tone="danger" title="Link de transferência inválido">
        <p>Confira se o endereço foi copiado inteiro do e-mail. Se o problema continuar, peça a quem enviou para transferir de novo.</p>
      </State>
    );
  }
  const tz = t.event.timezone;
  const effectiveExpiresAt = t.expiresAt ? new Date(Math.min(t.expiresAt.getTime(), transferCutoff(t.event.startsAt, t.event).getTime())) : null;
  const isRecipient = user.email.toLowerCase() === t.toEmail;

  // Já aceita: o destinatário segue para o ingresso; os demais só sabem que o link foi usado.
  if (t.status === "ACCEPTED") {
    if (t.toUserId === user.id) {
      return (
        <State icon={CircleCheck} tone="success" title="Você já aceitou esta transferência">
          <p>O ingresso de {t.event.title} está no seu nome.</p>
          <Link href={`/ingressos/${t.ticket.code}`} className={buttonVariants({ size: "sm", className: "mt-1" })}>
            <Ticket aria-hidden /> Ver meu ingresso
          </Link>
        </State>
      );
    }
    return (
      <State icon={CircleCheck} tone="info" title="Este link já foi utilizado">
        <p>A transferência já foi aceita e o link não vale mais.</p>
      </State>
    );
  }
  if (t.status === "EXPIRED" || (t.status === "PENDING" && (!effectiveExpiresAt || effectiveExpiresAt <= now))) {
    return (
      <State icon={Clock} tone="warning" title="Convite expirado">
        <p>
          Este convite {effectiveExpiresAt ? <>venceu em {formatDateTimeShort(effectiveExpiresAt, tz)}</> : "venceu"}. O ingresso continua com quem enviou; peça a{" "}
          {isRecipient ? <strong>{t.fromHolderName}</strong> : "essa pessoa"} para transferir de novo.
        </p>
      </State>
    );
  }
  if (t.status === "CANCELLED") {
    const declinedByMe = isRecipient && t.decisionReason === DECLINED_BY_RECIPIENT;
    return (
      <State icon={UserX} tone="info" title={declinedByMe ? "Você recusou esta transferência" : "Transferência cancelada"}>
        <p>{declinedByMe ? "O ingresso continua com quem enviou." : "Quem enviou cancelou a transferência. O link não vale mais."}</p>
      </State>
    );
  }

  // PENDING e dentro do prazo.
  if (t.fromUserId === user.id) {
    return (
      <State icon={ArrowLeftRight} tone="info" title="Esta transferência foi enviada por você">
        <p>Só o destinatário pode aceitar. Para desistir, cancele em Meus ingressos.</p>
        <Link href="/meus-ingressos" className={buttonVariants({ size: "sm", variant: "outline", className: "mt-1" })}>
          Meus ingressos
        </Link>
      </State>
    );
  }

  // Não mostra o ingresso a quem não é o destinatário indicado.
  if (!isRecipient) {
    return (
      <State icon={UserX} tone="warning" title="Você está na conta errada">
        <p>
          Esta transferência foi enviada para <strong>{maskEmail(t.toEmail)}</strong>, e você entrou como <strong>{user.email}</strong>. Saia e entre com a
          conta desse e-mail (ou crie uma com ele); depois abra o link do e-mail de novo.
        </p>
        <LogoutButton className={buttonVariants({ size: "sm", variant: "outline", className: "mt-1" })}>Sair desta conta</LogoutButton>
      </State>
    );
  }
  // O serviço reconfere tudo sob as travas; aqui só evita oferecer um aceite que vai falhar.
  const blocked = transferBlockedReason({ status: t.ticket.status, order: t.ticket.order, event: t.event }, now)
    ?? (t.ticket._count.transfers >= t.event.transferMaxTransfers ? `Este ingresso já atingiu o limite de ${t.event.transferMaxTransfers} transferência(s).` : null)
    ?? await transferRecipientBlockedReason(db, t.ticket.id, t.ticket.userId, user, t.event.transferAllowReturn);
  return (
    <Card className="mt-6 space-y-4 p-5">
      <p>
        <strong>{t.fromHolderName}</strong> quer transferir para você um ingresso <strong>{t.ticket.ticketType.name}</strong> de:
      </p>
      <div>
        <p className="font-display text-lg font-bold">{t.event.title}</p>
        <p className="text-sm text-muted-foreground first-letter:uppercase">{formatEventDateTime(t.event.startsAt, tz)}</p>
      </div>
      {blocked ? (
        <>
          <Alert variant="warning">
            Não é mais possível aceitar: {blocked.charAt(0).toLowerCase() + blocked.slice(1)}
          </Alert>
          <TransferResponse token={token} allowAccept={false} />
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            A transferência é gratuita. Ao aceitar, o ingresso fica no seu nome ({t.toHolderName ?? user.name}) e ganha um novo QR code; o anterior deixa de valer.
            Válida até {formatDateTimeShort(effectiveExpiresAt!, tz)}. O evento permite até {t.event.transferMaxTransfers} transferência(s) por ingresso, até {t.event.transferDeadlineHours} hora(s) antes do início. {t.event.transferAllowReturn ? "Uma devolução depende de nova transferência aceita pelo titular anterior e conta nesse limite." : "Não é permitido devolver a titulares anteriores."}
          </p>
          <TransferResponse token={token} />
        </>
      )}
    </Card>
  );
}
