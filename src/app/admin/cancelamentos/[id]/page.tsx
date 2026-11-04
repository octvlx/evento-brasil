import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { ReasonedDecisionButton } from "@/features/admin/decision-controls";
import { ADMIN_REFUND_REASON, CANCELLATION_STATUS } from "@/features/admin/labels";
import { adminDecideCancellationAction } from "@/features/orders/cancellation-actions";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { AppError } from "@/server/errors";
import { getCancellationRequestDetail } from "@/server/services/admin-oversight";
import { formatDateTimeShort } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { EVENT_STATUS, ORDER_STATUS, PAYMENT_STATUS, REFUND_STATUS, TICKET_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Pedido de cancelamento — admin", robots: { index: false } };

export default function AdminCancellationDetail({ params }: PageProps<"/admin/cancelamentos/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content params={params} />
    </Suspense>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 border-t border-border py-2 first:border-t-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin("cancellations:decide");
  const { id } = await params;
  const { request: r, eligibilityNow, ticketCounts, overdue } = await getCancellationRequestDetail(db, admin, id).catch((err: unknown) => {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  });
  const o = r.order;
  const open = r.status === "OPEN";
  const approveEffect =
    o.status === "PAID"
      ? `Abre um reembolso integral de ${formatBRL(o.totalCents)} (motivo administrativo) e o envia ao provedor; os ingressos são cancelados.`
      : o.status === "PENDING_PAYMENT"
        ? "O pedido ainda não foi pago: a reserva é liberada e o pedido cancelado."
        : o.status === "REFUND_PENDING" || o.status === "REFUNDED"
          ? "Já existe reembolso para este pedido: nenhum novo será aberto."
          : `O pedido está "${ORDER_STATUS[o.status]?.label ?? o.status}" e não tem valor a reembolsar: a aprovação será recusada; recuse informando o motivo.`;
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/admin/cancelamentos" className="text-secondary underline-offset-4 hover:underline">
          ← Pedidos de cancelamento
        </Link>
      </p>
      <PageTitle title={`Protocolo ${r.protocol}`} subtitle={`${r.event.title} · ${r.organization.name}`} />
      {overdue && (
        <Alert variant="danger" className="mb-4">
          Prazo de resposta vencido em {formatDateTimeShort(r.respondBy!)}.
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-bold">Pedido de cancelamento</h2>
          <dl className="text-sm">
            <Row label="Status">
              <Badge variant={open ? "warning" : "default"}>{CANCELLATION_STATUS[r.status]}</Badge>
            </Row>
            <Row label="Solicitante">
              {r.requestedBy.name} · {r.requestedBy.email}
            </Row>
            <Row label="Aberto em">{formatDateTimeShort(r.createdAt)}</Row>
            <Row label="Responder até">{r.respondBy ? formatDateTimeShort(r.respondBy) : "—"}</Row>
            <Row label="Reembolsável pela política na abertura">{r.autoEligibleAtRequest == null ? "—" : r.autoEligibleAtRequest ? "Sim" : "Não"}</Row>
            <Row label="Reembolsável pela política hoje">
              {eligibilityNow.eligible ? (eligibilityNow.basis === "EVENT_CHANGED" ? "Sim (janela de alteração do evento)" : "Sim") : `Não — ${eligibilityNow.reason}`}
            </Row>
            {!open && (
              <>
                <Row label="Decidido por">{r.decidedBy?.email ?? "—"}</Row>
                <Row label="Decidido em">{r.decidedAt ? formatDateTimeShort(r.decidedAt) : "—"}</Row>
              </>
            )}
          </dl>
          <h3 className="mt-3 text-xs font-bold uppercase text-muted-foreground">Motivo do comprador</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm">{r.reason}</p>
          {r.decisionNote && (
            <>
              <h3 className="mt-3 text-xs font-bold uppercase text-muted-foreground">Justificativa da decisão</h3>
              <p className="mt-1 whitespace-pre-wrap text-sm">{r.decisionNote}</p>
            </>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="mb-2 text-sm font-bold">Pedido {o.publicCode}</h2>
          <dl className="text-sm">
            <Row label="Status">
              {ORDER_STATUS[o.status]?.label ?? o.status} {o.isSimulated && <Badge variant="warning">simulado</Badge>}
            </Row>
            <Row label="Comprador">
              {o.buyerName} · {o.buyerEmail}
            </Row>
            <Row label="Ingressos">{formatBRL(o.subtotalCents)}</Row>
            <Row label="Taxa de serviço">{formatBRL(o.serviceFeeCents)}</Row>
            {o.discountCents > 0 && <Row label="Desconto">−{formatBRL(o.discountCents)}</Row>}
            <Row label="Total">{formatBRL(o.totalCents)}</Row>
            <Row label="Pago em">{o.paidAt ? formatDateTimeShort(o.paidAt) : "—"}</Row>
            <Row label="Evento">
              {formatDateTimeShort(r.event.startsAt, r.event.timezone)} · {EVENT_STATUS[r.event.status]?.label ?? r.event.status}
            </Row>
            <Row label="Ingressos emitidos">
              {Object.entries(ticketCounts)
                .map(([s, n]) => `${n} ${TICKET_STATUS[s]?.label.toLowerCase() ?? s}`)
                .join(" · ") || "—"}
            </Row>
          </dl>
          <h3 className="mt-3 text-xs font-bold uppercase text-muted-foreground">Pagamentos</h3>
          <ul className="mt-1 text-sm">
            {o.payments.length === 0 && <li className="text-muted-foreground">Nenhum.</li>}
            {o.payments.map((p) => (
              <li key={p.id}>
                {p.method} · {PAYMENT_STATUS[p.status]} · {formatBRL(p.amountCents)} · {formatDateTimeShort(p.createdAt)}
                {p.failureReason && <span className="text-destructive"> · {p.failureReason}</span>}
              </li>
            ))}
          </ul>
          <h3 className="mt-3 text-xs font-bold uppercase text-muted-foreground">Reembolsos</h3>
          <ul className="mt-1 text-sm">
            {o.refunds.length === 0 && <li className="text-muted-foreground">Nenhum.</li>}
            {o.refunds.map((f) => (
              <li key={f.id}>
                {REFUND_STATUS[f.status]} · {ADMIN_REFUND_REASON[f.reason] ?? f.reason} · {formatBRL(f.amountCents)} · {formatDateTimeShort(f.createdAt)}
                {f.cancellationRequestId === r.id && <Badge className="ml-1">deste protocolo</Badge>}
                {f.status === "FAILED" && (
                  <Link href="/admin/pagamentos#reembolsos-falhos" className="ml-1 text-secondary underline-offset-4 hover:underline">
                    tratar falha
                  </Link>
                )}
                {f.note && <span className="block text-xs text-muted-foreground">{f.note}</span>}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {open && (
        <Card className="mt-4 p-4">
          <h2 className="text-sm font-bold">Decisão</h2>
          <p className="mt-1 text-sm text-muted-foreground">O motivo é obrigatório nas duas decisões; na recusa ele é enviado ao comprador.</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <ReasonedDecisionButton
              label="Aprovar"
              variant="default"
              confirmTitle={`Aprovar o cancelamento ${r.protocol}?`}
              confirmText={approveEffect}
              reasonLabel="Justificativa da aprovação"
              doneText="Aprovação registrada."
              action={adminDecideCancellationAction.bind(null, r.id, "APPROVE")}
            />
            <ReasonedDecisionButton
              label="Recusar"
              variant="destructive"
              confirmTitle={`Recusar o cancelamento ${r.protocol}?`}
              confirmText="O pedido continua como está. O motivo abaixo é enviado ao comprador."
              reasonLabel="Motivo da recusa (enviado ao comprador)"
              doneText="Recusa registrada."
              action={adminDecideCancellationAction.bind(null, r.id, "REJECT")}
            />
          </div>
        </Card>
      )}
    </>
  );
}
