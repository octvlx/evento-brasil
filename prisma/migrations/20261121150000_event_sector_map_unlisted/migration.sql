-- Setor do tipo de ingresso, mapa do evento e evento privado (fora das listagens).
-- Colunas novas e opcionais (ou com padrão): nenhum dado existente muda.
ALTER TABLE "TicketType" ADD COLUMN "sector" TEXT;
ALTER TABLE "Event" ADD COLUMN "mapImageUrl" TEXT;
ALTER TABLE "Event" ADD COLUMN "isUnlisted" BOOLEAN NOT NULL DEFAULT false;

-- Setor: texto curto e não vazio quando informado (o formulário limita a 60).
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_sector_length"
  CHECK ("sector" IS NULL OR (length(btrim("sector")) BETWEEN 1 AND 60));
