import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { CommissionRuleForm } from "@/features/admin/controls";
import { db } from "@/server/db";
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
  await requireAdmin();
  const [rules, orgs, events] = await Promise.all([
    db.commissionRule.findMany({ include: { organization: { select: { name: true } }, event: { select: { title: true } } }, orderBy: { createdAt: "desc" } }),
    db.organization.findMany({ where: { status: "APPROVED" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.event.findMany({ where: { status: { in: ["DRAFT", "PENDING_REVIEW", "PUBLISHED"] } }, select: { id: true, title: true }, orderBy: { startsAt: "asc" } }),
  ]);
  return (
    <>
      <PageTitle title="Comissões" subtitle="Regras versionadas: alterar cria uma nova versão; pedidos já feitos mantêm a política original." />
      <Card className="mb-6 p-6">
        <h2 className="mb-4 font-display text-lg font-bold">Nova versão de regra</h2>
        <CommissionRuleForm orgs={orgs} events={events} />
      </Card>
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-3">Versão</th>
              <th className="p-3">Alvo</th>
              <th className="p-3 text-right">%</th>
              <th className="p-3 text-right">Fixo</th>
              <th className="p-3">Paga</th>
              <th className="p-3">Processamento</th>
              <th className="p-3">Vigência</th>
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
                <td className="p-3 text-xs">
                  {formatDateTimeShort(r.activeFrom)} → {r.activeTo ? formatDateTimeShort(r.activeTo) : "vigente"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
