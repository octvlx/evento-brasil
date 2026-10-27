-- ADR 0002, passo 1: cupons de desconto e links de venda rastreados.
-- Escrita à mão: o SQL gerado pelo Prisma (ADD COLUMN ... NOT NULL sem default)
-- falharia em OrderItem com linhas, e os CHECKs não são modelados pelo Prisma.

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENT', 'FIXED_PER_TICKET');

-- Order: instantâneos da compra (todos opcionais ou com default; sem backfill).
ALTER TABLE "Order" ADD COLUMN "couponId" TEXT,
ADD COLUMN "couponCode" VARCHAR(32),
ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "trackingLinkId" TEXT,
ADD COLUMN "utmSource" VARCHAR(200),
ADD COLUMN "utmMedium" VARCHAR(200),
ADD COLUMN "utmCampaign" VARCHAR(200),
ADD COLUMN "utmContent" VARCHAR(200),
ADD COLUMN "utmTerm" VARCHAR(200);

-- OrderItem: preço de tabela e desconto. Backfill antes do NOT NULL e do CHECK.
ALTER TABLE "OrderItem" ADD COLUMN "discountPerUnitCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "listUnitPriceCents" INTEGER;
UPDATE "OrderItem" SET "listUnitPriceCents" = "unitPriceCents";
ALTER TABLE "OrderItem" ALTER COLUMN "listUnitPriceCents" SET NOT NULL;

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT,
    "code" VARCHAR(32) NOT NULL,
    "description" VARCHAR(200),
    "discountType" "DiscountType" NOT NULL,
    "percentBps" INTEGER,
    "amountCents" INTEGER,
    "validFrom" TIMESTAMPTZ(3),
    "validUntil" TIMESTAMPTZ(3),
    "maxUses" INTEGER,
    "maxUsesPerUser" INTEGER DEFAULT 1,
    "timesReserved" INTEGER NOT NULL DEFAULT 0,
    "timesRedeemed" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMPTZ(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponTicketType" (
    "couponId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,

    CONSTRAINT "CouponTicketType_pkey" PRIMARY KEY ("couponId","ticketTypeId")
);

-- CreateTable
CREATE TABLE "TrackingLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "utmSource" VARCHAR(200),
    "utmMedium" VARCHAR(200),
    "utmCampaign" VARCHAR(200),
    "utmContent" VARCHAR(200),
    "utmTerm" VARCHAR(200),
    "couponId" TEXT,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Event_id_organizationId_key" ON "Event"("id", "organizationId");

-- CreateIndex
CREATE INDEX "Order_couponId_userId_idx" ON "Order"("couponId", "userId");

-- CreateIndex
CREATE INDEX "Order_trackingLinkId_idx" ON "Order"("trackingLinkId");

-- CreateIndex
CREATE INDEX "Coupon_eventId_idx" ON "Coupon"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_organizationId_code_key" ON "Coupon"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_id_organizationId_key" ON "Coupon"("id", "organizationId");

-- CreateIndex
CREATE INDEX "CouponTicketType_ticketTypeId_idx" ON "CouponTicketType"("ticketTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingLink_code_key" ON "TrackingLink"("code");

-- CreateIndex
CREATE INDEX "TrackingLink_eventId_idx" ON "TrackingLink"("eventId");

-- CreateIndex
CREATE INDEX "TrackingLink_couponId_idx" ON "TrackingLink"("couponId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_couponId_organizationId_fkey" FOREIGN KEY ("couponId", "organizationId") REFERENCES "Coupon"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_trackingLinkId_fkey" FOREIGN KEY ("trackingLinkId") REFERENCES "TrackingLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_eventId_organizationId_fkey" FOREIGN KEY ("eventId", "organizationId") REFERENCES "Event"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponTicketType" ADD CONSTRAINT "CouponTicketType_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponTicketType" ADD CONSTRAINT "CouponTicketType_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingLink" ADD CONSTRAINT "TrackingLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingLink" ADD CONSTRAINT "TrackingLink_eventId_organizationId_fkey" FOREIGN KEY ("eventId", "organizationId") REFERENCES "Event"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingLink" ADD CONSTRAINT "TrackingLink_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Garantias que o Prisma não modela (ver docs/database.md).
-- O limite de usos (timesReserved + timesRedeemed <= maxUses) NÃO é CHECK: o
-- pagamento tardio precisa honrar o preço já pago e fica auditado.
ALTER TABLE "Coupon"
  ADD CONSTRAINT "Coupon_counters_nonnegative" CHECK ("timesReserved" >= 0 AND "timesRedeemed" >= 0),
  ADD CONSTRAINT "Coupon_max_uses" CHECK (("maxUses" IS NULL OR "maxUses" > 0) AND ("maxUsesPerUser" IS NULL OR "maxUsesPerUser" > 0)),
  ADD CONSTRAINT "Coupon_discount_value" CHECK (
    ("discountType" = 'PERCENT' AND "percentBps" BETWEEN 1 AND 10000 AND "amountCents" IS NULL) OR
    ("discountType" = 'FIXED_PER_TICKET' AND "amountCents" > 0 AND "percentBps" IS NULL)),
  ADD CONSTRAINT "Coupon_validity" CHECK ("validUntil" IS NULL OR "validFrom" IS NULL OR "validUntil" > "validFrom"),
  ADD CONSTRAINT "Coupon_code_format" CHECK ("code" ~ '^[A-Z0-9_-]{3,32}$');

ALTER TABLE "TrackingLink"
  ADD CONSTRAINT "TrackingLink_clicks_nonnegative" CHECK ("clicks" >= 0),
  ADD CONSTRAINT "TrackingLink_code_format" CHECK ("code" ~ '^[A-Za-z0-9]{6,16}$');

-- Preço cobrado = preço de tabela - desconto. Com OrderItem_amounts
-- (unitPriceCents >= 0), implica desconto <= preço de tabela.
ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_discount" CHECK (
    "discountPerUnitCents" >= 0 AND "unitPriceCents" = "listUnitPriceCents" - "discountPerUnitCents");

-- Desconto só com cupom; código copiado se e só se houver cupom.
-- discountCents = Σ itens envolve duas tabelas e fica na reconciliação.
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_discount" CHECK (
    "discountCents" >= 0
    AND ("couponCode" IS NOT NULL OR "discountCents" = 0)
    AND (("couponId" IS NULL) = ("couponCode" IS NULL)));
