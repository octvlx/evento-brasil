-- Conta de recebimento das organizações já autorizadas no Mercado Pago. O retorno do OAuth
-- não atualizava Organization.paymentAccountStatus, então a tela mostrava "Não conectada"
-- mesmo com a autorização válida. Só toca organizações sem status de recebimento (as do
-- provedor simulado ficam como estão).
UPDATE "Organization" o
SET "paymentProvider" = 'mercadopago',
    "paymentAccountStatus" = 'CONNECTED',
    "paymentAccountExternalId" = m."mercadoPagoUserId"
FROM "MercadoPagoAccount" m
WHERE m."organizationId" = o.id
  AND m."revokedAt" IS NULL
  AND o."paymentAccountStatus" = 'NOT_CONNECTED';
