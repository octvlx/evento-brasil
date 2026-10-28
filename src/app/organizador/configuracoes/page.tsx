import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import {
  ConnectPaymentButton,
  ProfileSettingsForm,
} from "@/features/organizer/settings-forms";
import { db } from "@/server/db";
import { getPaymentAdapter } from "@/server/payments";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { ORG_STATUS, PAYMENT_ACCOUNT_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Configurações", robots: { index: false } };

export default function SettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[700px]" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const { org: activeOrg, can } = await requireOrganizer("/organizador/configuracoes");
  if (!can("org:manage")) redirect("/organizador");
  const org = await db.organization.findUniqueOrThrow({
    where: { id: activeOrg.id },
    include: {
      verifications: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  const adapter = getPaymentAdapter();
  const v = org.verifications[0];

  return (
    <>
      <PageTitle title="Configurações" subtitle={`${org.name} · ${ORG_STATUS[org.status].label}`} />
      <div className="space-y-6">
        <Card className="space-y-3 p-6">
          <h2 className="font-display text-lg font-bold">Conta de recebimento</h2>
          <p className="text-sm">
            Status: <Badge variant={org.paymentAccountStatus === "CONNECTED" ? "success" : org.paymentAccountStatus === "SIMULATED" ? "warning" : "default"}>{PAYMENT_ACCOUNT_STATUS[org.paymentAccountStatus]}</Badge>
          </p>
          {adapter.isSimulated ? (
            <Alert variant="warning">
              Ambiente de desenvolvimento: pagamentos usam o provedor simulado. A conexão real (OAuth do Mercado Pago com split de marketplace) será habilitada após verificação dos contratos de API.
            </Alert>
          ) : (
            <Alert>A conexão com o provedor real ainda não está disponível nesta versão.</Alert>
          )}
          {org.status === "APPROVED" && org.paymentAccountStatus === "NOT_CONNECTED" && <ConnectPaymentButton simulated={adapter.isSimulated} />}
          {v && (
            <p className="text-xs text-muted-foreground">
              Documento cadastrado: {v.documentType} final {v.documentLast4} · {v.legalName}
            </p>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="mb-4 font-display text-lg font-bold">Perfil público</h2>
          <ProfileSettingsForm description={org.description ?? ""} websiteUrl={org.websiteUrl ?? ""} instagramHandle={org.instagramHandle ?? ""} />
        </Card>
      </div>
    </>
  );
}
