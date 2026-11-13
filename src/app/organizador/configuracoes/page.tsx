import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import {
  ConnectPaymentButton,
  OrgImageField,
  ProfileSettingsForm,
} from "@/features/organizer/settings-forms";
import { db } from "@/server/db";
import { getPaymentAdapter } from "@/server/payments";
import { sellerCheckoutReadiness } from "@/server/payments/mercadopago";
import { sandboxTokens } from "@/server/payments/mercadopago-oauth";
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

/** O checkout aceita PIX e cartão de crédito: mostra o que a conta conectada consegue receber. */
async function PixAvailability({ organizationId }: { organizationId: string }) {
  const readiness = await sellerCheckoutReadiness(db, organizationId);
  if (!readiness) return <p className="text-sm text-muted-foreground">Não foi possível verificar as formas de pagamento da conta Mercado Pago agora.</p>;
  if (!readiness.pix && !readiness.card)
    return (
      <Alert variant="danger" data-testid="mp-no-methods">
        A conta Mercado Pago conectada não oferece PIX nem cartão de crédito: os compradores não conseguirão pagar. Confira a conta no Mercado Pago (ou conecte outra) e recarregue esta página.
      </Alert>
    );
  return (
    <div className="space-y-1 text-sm" data-testid="mp-methods">
      <p className={readiness.pix ? "text-success" : "text-warning"}>
        PIX: {readiness.pix ? "disponível" : "indisponível — cadastre uma chave PIX na conta Mercado Pago para recebê-lo"}
      </p>
      <p className={readiness.card ? "text-success" : "text-warning"}>Cartão (crédito ou débito): {readiness.card ? "disponível" : "indisponível nesta conta"}</p>
    </div>
  );
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
              Checkout Pro está configurado para PIX, cartão (crédito à vista ou débito) e saldo Mercado Pago. Valide o fluxo completo no sandbox antes de habilitar cobranças reais em produção.
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
          {org.status === "APPROVED" && sandboxTokens() && (
            <p className="text-xs text-warning" data-testid="mp-oauth-sandbox">
              Modo sandbox: a autorização pede ao Mercado Pago credenciais de teste do vendedor. Depois de mudar essa configuração, autorize novamente.
            </p>
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
          <div className="mt-6 grid gap-6 border-t border-border pt-6 sm:grid-cols-[auto_1fr]">
            <OrgImageField kind="logo" url={org.logoUrl} />
            <OrgImageField kind="cover" url={org.coverUrl} />
          </div>
        </Card>
      </div>
    </>
  );
}
