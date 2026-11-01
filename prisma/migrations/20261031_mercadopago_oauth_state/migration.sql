-- CreateTable
CREATE TABLE "MercadoPagoOAuthState" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MercadoPagoOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MercadoPagoOAuthState_stateHash_key"
ON "MercadoPagoOAuthState"("stateHash");

-- CreateIndex
CREATE INDEX "MercadoPagoOAuthState_organizationId_idx"
ON "MercadoPagoOAuthState"("organizationId");

-- CreateIndex
CREATE INDEX "MercadoPagoOAuthState_expiresAt_idx"
ON "MercadoPagoOAuthState"("expiresAt");
