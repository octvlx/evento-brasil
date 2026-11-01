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
import { sellerPixAvailable } from "@/server/payments/mercadopago";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { ORG_STATUS, PAYMENT_ACCOUNT_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Configurações", robots: { index: false } };

export default function SettingsPage({ searchParams }: { searchParams: Promise<{ mp?: string }> }) {
  return (
    <Suspense fallback={<Skeleton className="h-[700px]" />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

/** O checkout só aceita PIX: avisa quando a conta conectada não pode recebê-lo. */
async function PixAvailability({ organizationId }: { organizationId: string }) {
  const pix = await sellerPixAvailable(db, organizationId);
  if (pix === true) return <p className="text-sm text-success">PIX disponível na conta Mercado Pago conectada.</p>;
  if (pix === false)
    return (
      <Alert variant="danger" data-testid="mp-pix-unavailable">
        A conta Mercado Pago conectada não oferece PIX, e o checkout só aceita PIX: os compradores não conseguirão pagar. Cadastre uma chave PIX nessa conta no Mercado Pago (ou conecte outra conta) e
        recarregue esta página.
      </Alert>
    );
  return <p className="text-sm text-muted-foreground">Não foi possível verificar o PIX na conta Mercado Pago agora.</p>;
}

async function Content({ searchParams }: { searchParams: Promise<{ mp?: string }> }) {
  const { mp } = await searchParams;
  const { org: activeOrg, can } = await requireOrganizer("/organizador/configuracoes");
  if (!can("org:manage")) redirect("/organizador");
  const org = await db.organization.findUniqueOrThrow({
    where: { id: activeOrg.id },
    include: {
      mercadoPagoAccount: { select: { mercadoPagoUserId: true, revokedAt: true, tokenExpiresAt: true } },
      verifications: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  const adapter = getPaymentAdapter();
  const v = org.verifications[0];

  return (
    <>
      <PageTitle title="Configurações" subtitle={`${org.name} · ${ORG_STATUS[org.status].label}`} />
      <div className="space-y-6">
        {mp === "connected" && <Alert variant="success">Conta Mercado Pago autorizada. Pagamentos continuam no provedor configurado.</Alert>}
        {mp === "denied" && <Alert variant="warning">Autorização cancelada. Você pode tentar novamente.</Alert>}
        {mp === "error" && <Alert variant="danger">Não foi possível concluir a conexão. Confira a configuração ou inicie uma nova autorização.</Alert>}
        <Card className="space-y-3 p-6">
          <h2 className="font-display text-lg font-bold">Conta de recebimento</h2>
          <p className="text-sm">
            Status: <Badge variant={org.paymentAccountStatus === "CONNECTED" ? "success" : org.paymentAccountStatus === "SIMULATED" ? "warning" : "default"}>{PAYMENT_ACCOUNT_STATUS[org.paymentAccountStatus]}</Badge>
          </p>
          {adapter.isSimulated ? (
            <Alert variant="warning">
              Ambiente de desenvolvimento: pagamentos usam o provedor simulado. A conexão OAuth abaixo autoriza a conta do organizador; cobranças e repasses reais continuam desabilitados.
            </Alert>
          ) : adapter.id === "mercadopago" && adapter.supportedMethods.length > 0 ? (
            <Alert variant="warning">
              Checkout Pro está configurado para PIX. Valide o fluxo completo no sandbox antes de habilitar cobranças reais em produção.
            </Alert>
          ) : adapter.id === "mercadopago" ? (
            <Alert variant="warning">
              Checkout Pro indisponível: confira credenciais OAuth, chave de criptografia e segredo de assinatura dos webhooks.
            </Alert>
          ) : (
            <Alert>O provedor de pagamentos está indisponível nesta configuração.</Alert>
          )}
          {adapter.id !== "mercadopago" && org.status === "APPROVED" && org.paymentAccountStatus === "NOT_CONNECTED" && <ConnectPaymentButton simulated={adapter.isSimulated} />}
          <p className="text-sm">Mercado Pago OAuth: {org.mercadoPagoAccount && !org.mercadoPagoAccount.revokedAt ? "Autorizado" : "Não conectado ou requer nova autorização"}. Esta autorização não habilita cobranças reais.</p>
          {org.status === "APPROVED" && org.mercadoPagoAccount && !org.mercadoPagoAccount.revokedAt && (
            <Suspense fallback={<p className="text-sm text-muted-foreground">Verificando PIX na conta Mercado Pago…</p>}>
              <PixAvailability organizationId={org.id} />
            </Suspense>
          )}
          {org.status === "APPROVED" && (
            <form action="/api/mercadopago/connect" method="post">
              <button className="underline" type="submit">{org.mercadoPagoAccount ? "Autorizar novamente Mercado Pago" : "Conectar Mercado Pago"}</button>
            </form>
          )}
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
