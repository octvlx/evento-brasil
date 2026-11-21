import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { CommissionRuleForm, CommissionRuleRowActions } from "@/features/admin/controls";
import { db } from "@/server/db";
import { getPaymentAdapter } from "@/server/payments";
import { requireAdmin } from "@/server/auth/current";
import { formatDateTimeShort } from "@/lib/datetime";

export const metadata: Metadata = { title: "Comissões — admin", robots: { index: false } };

export default function AdminSettings() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  await requireAdmin("finance:commissions");
  const [rules, orgs, events] = await Promise.all([
    db.commissionRule.findMany({
      include: { organization: { select: { name: true } }, event: { select: { title: true } }, _count: { select: { orders: true } } },
      orderBy: { createdAt: "desc" },
    }),
    db.organization.findMany({ where: { status: "APPROVED" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.event.findMany({ where: { status: { in: ["DRAFT", "PENDING_REVIEW", "PUBLISHED"] } }, select: { id: true, title: true }, orderBy: { startsAt: "asc" } }),
  ]);
  const retentionAvailable = getPaymentAdapter().isSimulated;
  return (
    <>
      <PageTitle
        title="Comissões"
        subtitle="Regras versionadas: alterar cria uma nova versão; pedidos já feitos mantêm a política original. Editar ou excluir só vale para versões que nenhum pedido usou."
      />
      <Card className="mb-6 p-6">
        <h2 className="mb-4 font-display text-lg font-bold">Nova versão de regra</h2>
        <CommissionRuleForm orgs={orgs} events={events} commissionRetentionAvailable={retentionAvailable} />
      </Card>
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-3">Versão</th>
              <th className="p-3">Alvo</th>
              <th className="p-3 text-right">%</th>
              <th className="p-3 text-right">Fixo</th>
              <th className="p-3">Paga</th>
              <th className="p-3">Processamento</th>
              <th className="p-3">Fixo no reembolso</th>
              <th className="p-3">Vigência</th>
              <th className="p-3 text-right">Pedidos</th>
              <th className="p-3">Ações</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className={`border-t border-border ${r.activeTo ? "opacity-60" : ""}`}>
                <td className="p-3 font-mono text-xs">{r.policyVersion}</td>
                <td className="p-3">{r.scope === "PLATFORM" ? "Plataforma" : r.scope === "ORGANIZATION" ? r.organization?.name : r.event?.title}</td>
                <td className="p-3 text-right tabular-nums">{(r.percentBps / 100).toFixed(2)}</td>
                <td className="p-3 text-right tabular-nums">{r.fixedCentsPerTicket}</td>
                <td className="p-3">{r.bearer === "ORGANIZER" ? "Organizador" : "Comprador"}</td>
                <td className="p-3">{r.processingFeeBearer === "ORGANIZER" ? "Organizador" : "Plataforma"}</td>
                <td className="p-3">{r.fixedCentsPerTicket ? (r.fixedFeeRefundable ? "Devolvido" : "Retido") : "—"}</td>
                <td className="p-3 text-xs">
                  {formatDateTimeShort(r.activeFrom)} → {r.activeTo ? formatDateTimeShort(r.activeTo) : "vigente"}
                </td>
                <td className="p-3 text-right tabular-nums">{r._count.orders}</td>
                <td className="p-3">
                  {r._count.orders === 0 ? (
                    <CommissionRuleRowActions rule={r} commissionRetentionAvailable={retentionAvailable} />
                  ) : (
                    <span className="text-xs text-muted-foreground" title="Versão usada em pedidos: crie uma nova versão para mudar os valores.">
                      Em uso
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
