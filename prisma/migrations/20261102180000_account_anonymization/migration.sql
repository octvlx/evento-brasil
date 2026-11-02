-- L9b (Decreto 13.108/2026, R9; LGPD art. 16 e 18): exclusão da conta pelo titular e
-- expurgo por prazo. Só colunas novas e anuláveis: nenhum dado existente muda.

-- Conta anonimizada (a linha fica: pedidos, ingressos e auditoria apontam para ela).
ALTER TABLE "User" ADD COLUMN "anonymizedAt" TIMESTAMPTZ(3);

-- Comprador/participantes e titular já anonimizados: o expurgo não os revisita.
ALTER TABLE "Order" ADD COLUMN "piiRedactedAt" TIMESTAMPTZ(3);
ALTER TABLE "IssuedTicket" ADD COLUMN "piiRedactedAt" TIMESTAMPTZ(3);
