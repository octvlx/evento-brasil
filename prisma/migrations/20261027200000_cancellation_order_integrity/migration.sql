-- Não modifica nem corrige silenciosamente registros históricos.
-- A validação da FK aborta a migração se já houver pedidos inconsistentes.
BEGIN;

CREATE UNIQUE INDEX "Order_id_eventId_organizationId_key"
  ON "Order" ("id", "eventId", "organizationId");

ALTER TABLE "CancellationRequest"
  ADD CONSTRAINT "CancellationRequest_orderId_eventId_organizationId_fkey"
  FOREIGN KEY ("orderId", "eventId", "organizationId")
  REFERENCES "Order" ("id", "eventId", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CancellationRequest"
  DROP CONSTRAINT "CancellationRequest_orderId_fkey";

COMMIT;
