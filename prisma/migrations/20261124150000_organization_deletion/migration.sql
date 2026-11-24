-- Exclusão de conta de organizador. Só acrescenta: coluna anulável em "Organization"
-- (exclusão lógica; nenhuma linha existente muda) e a tabela de pedidos de exclusão.
-- Nada é apagado: pedidos, razão, reembolsos e auditoria continuam apontando para a
-- organização excluída.

-- CreateEnum
CREATE TYPE "OrganizationDeletionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "deletedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "OrganizationDeletionRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "reason" TEXT,
    "status" "OrganizationDeletionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OrganizationDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationDeletionRequest_organizationId_createdAt_idx" ON "OrganizationDeletionRequest"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizationDeletionRequest_status_createdAt_idx" ON "OrganizationDeletionRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "OrganizationDeletionRequest" ADD CONSTRAINT "OrganizationDeletionRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationDeletionRequest" ADD CONSTRAINT "OrganizationDeletionRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationDeletionRequest" ADD CONSTRAINT "OrganizationDeletionRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Um pedido pendente por organização (pedidos simultâneos: o segundo falha aqui).
CREATE UNIQUE INDEX "OrganizationDeletionRequest_one_pending_per_org"
  ON "OrganizationDeletionRequest" ("organizationId") WHERE "status" = 'PENDING';
