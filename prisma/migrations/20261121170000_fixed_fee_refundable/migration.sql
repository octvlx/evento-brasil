-- Valor fixo da comissão não reembolsável (opcional, por regra) e proteção das versões
-- de regra em uso. Colunas novas com padrão: pedidos e regras existentes seguem iguais
-- (fixo reembolsável; nada retido).
-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_commissionRuleId_fkey";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "fixedFeeRefundable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "fixedFeePerUnitCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "retainedFeeCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CommissionRule" ADD COLUMN     "fixedFeeRefundable" BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_commissionRuleId_fkey" FOREIGN KEY ("commissionRuleId") REFERENCES "CommissionRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Retido nunca negativo; parte fixa entre 0 e a comissão da unidade.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_retainedFee_nonnegative" CHECK ("retainedFeeCents" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_fixedFee_range"
  CHECK ("fixedFeePerUnitCents" >= 0 AND "fixedFeePerUnitCents" <= "commissionPerUnitCents");
