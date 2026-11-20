import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { ReasonedDecisionButton } from "@/features/admin/decision-controls";
import { decideRefundApprovalAction } from "@/features/orders/actions";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { listOrgPendingApprovals, REFUND_APPROVAL_THRESHOLD_CENTS } from "@/server/services/refunds";
import { formatDateTimeShort } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { REFUND_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Reembolsos para aprovar", robots: { index: false } };

export default function OrganizerRefundApprovals() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const { user, org, can } = await requireOrganizer("/organizador/reembolsos");
  if (!can("refunds:approve")) redirect("/organizador");
  const [pending, decided] = await Promise.all([
    listOrgPendingApprovals(db, user, org.id),
    db.refund.findMany({
      where: { approvalRequired: true, approvalDecidedAt: { not: null }, order: { organizationId: org.id } },
      select: { id: true, status: true, amountCents: true, approvalDecidedAt: true, approvalNote: true, order: { select: { publicCode: true, event: { select: { title: true } } } } },
      orderBy: { approvalDecidedAt: "desc" },
      take: 20,
    }),
  ]);
  return (
    <>
      <PageTitle
        title="Reembolsos para aprovar"
        subtitle={`Reembolsos pedidos pela equipe da plataforma acima de ${formatBRL(REFUND_APPROVAL_THRESHOLD_CENTS)} esperam a aprovação do responsável ou do financeiro.`}
      />
      <section aria-labelledby="pendentes" className="mb-8">
        <h2 id="pendentes" className="mb-1 text-sm font-bold">
          Aguardando decisão ({pending.length})
        </h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Os ingressos destes reembolsos já estão bloqueados. Aprovar envia o estorno ao meio de pagamento; recusar devolve os ingressos ao comprador, sem estorno.
        </p>
        {pending.length === 0 ? (
          <p className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">Nenhum reembolso aguardando aprovação.</p>
        ) : (
          <ul className="space-y-3">
            {pending.map((r) => (
              <li key={r.refundId} className="rounded-2xl border border-border bg-card p-4 text-sm shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-bold">
                      {formatBRL(r.amountCents)} <span className="font-normal text-muted-foreground">· {r.partial ? `parcial, ${r.tickets} ingresso(s)` : "pedido inteiro"}</span>
                    </p>
                    <p>
                      {r.eventTitle} · pedido <span className="font-mono">{r.orderPublicCode}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Comprador: {r.buyerEmail} · pedido em {formatDateTimeShort(r.requestedAt)}
                    </p>
                    {r.note && <p className="mt-1 text-xs">Motivo da equipe: {r.note}</p>}
                  </div>
                  {r.requestedById === user.id ? (
                    <span className="text-xs text-muted-foreground">Você pediu este reembolso: outra pessoa decide.</span>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <ReasonedDecisionButton
                        label="Aprovar"
                        variant="default"
                        confirmTitle={`Aprovar o reembolso do pedido ${r.orderPublicCode}?`}
                        confirmText={`${formatBRL(r.amountCents)} vão ser devolvidos ao comprador pelo meio de pagamento.`}
                        reasonLabel="Observação (fica registrada)"
                        doneText="Aprovado. O estorno foi enviado."
                        action={decideRefundApprovalAction.bind(null, r.refundId, "APPROVE")}
                      />
                      <ReasonedDecisionButton
                        label="Recusar"
                        variant="destructive"
                        confirmTitle={`Recusar o reembolso do pedido ${r.orderPublicCode}?`}
                        confirmText="Nada é devolvido. Os ingressos voltam a valer e o comprador recebe um e-mail."
                        reasonLabel="Motivo da recusa (fica registrado; não vai para o comprador)"
                        doneText="Recusado. Os ingressos voltaram a valer."
                        action={decideRefundApprovalAction.bind(null, r.refundId, "REJECT")}
                      />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {decided.length > 0 && (
        <section aria-labelledby="decididos">
          <h2 id="decididos" className="mb-2 text-sm font-bold">
            Decididos recentemente
          </h2>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card text-sm">
            {decided.map((r) => (
              <li key={r.id} className="p-3">
                <span className="font-mono">{r.order.publicCode}</span> · {r.order.event.title} · {formatBRL(r.amountCents)} ·{" "}
                <strong>{r.status === "REJECTED" ? "Recusado" : `Aprovado (${REFUND_STATUS[r.status]?.toLowerCase()})`}</strong>
                <span className="block text-xs text-muted-foreground">
                  {r.approvalDecidedAt && formatDateTimeShort(r.approvalDecidedAt)}
                  {r.approvalNote && ` · ${r.approvalNote}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
