-- Mapa de assentos (lugar marcado por tipo de ingresso). Só acrescenta: a tabela "Seat",
-- "TicketType"."seated" (falso) e "OrderItem"."seatIds" (vazio); nada existente muda.

-- AlterTable
ALTER TABLE "TicketType" ADD COLUMN     "seated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "seatIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "row" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "orderItemId" TEXT,
    "sequence" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Seat_eventId_idx" ON "Seat"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_ticketTypeId_row_number_key" ON "Seat"("ticketTypeId", "row", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_ticketTypeId_label_key" ON "Seat"("ticketTypeId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_orderItemId_sequence_key" ON "Seat"("orderItemId", "sequence");

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Ocupação completa (item e sequência juntos), sequência positiva, número positivo e
-- assento bloqueado nunca ocupado.
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_occupancy_complete" CHECK (("orderItemId" IS NULL) = ("sequence" IS NULL));
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_sequence_positive" CHECK ("sequence" IS NULL OR "sequence" >= 1);
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_number_positive" CHECK ("number" >= 1);
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_blocked_free" CHECK (NOT ("blocked" AND "orderItemId" IS NOT NULL));
