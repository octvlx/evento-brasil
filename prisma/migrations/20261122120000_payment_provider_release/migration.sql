-- Repasse do provedor ao vendedor (split do Mercado Pago), só leitura: liberação e líquido.
-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "providerNetCents" INTEGER,
ADD COLUMN     "providerReleaseAt" TIMESTAMPTZ(3),
ADD COLUMN     "providerReleaseStatus" VARCHAR(32);

