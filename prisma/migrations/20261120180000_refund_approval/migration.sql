-- Aprovação antes do reembolso: reembolso manual do admin acima do limite fica em
-- AWAITING_APPROVAL (ingressos já bloqueados) até o organizador (OWNER/FINANCE) ou
-- outro admin financeiro aprovar ou recusar. Ver src/server/services/refund-approval.ts.
ALTER TYPE "RefundStatus" ADD VALUE IF NOT EXISTS 'AWAITING_APPROVAL';

ALTER TABLE "Refund" ADD COLUMN "approvalRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Refund" ADD COLUMN "approvalDecidedById" TEXT;
ALTER TABLE "Refund" ADD COLUMN "approvalDecidedAt" TIMESTAMPTZ(3);
ALTER TABLE "Refund" ADD COLUMN "approvalNote" TEXT;

-- Decisão registrada só em reembolso que passou pela aprovação, com quem e quando.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_approval_decision"
  CHECK (("approvalDecidedById" IS NULL AND "approvalDecidedAt" IS NULL) OR ("approvalRequired" AND "approvalDecidedAt" IS NOT NULL));
