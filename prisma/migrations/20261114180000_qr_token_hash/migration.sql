-- Token do QR deixa de ficar em claro no banco (lacuna 2 do check-in).
-- Ingressos novos: token = HMAC(QR_TOKEN_SECRET, código, versão), não guardado; o banco
-- guarda só o SHA-256 (hex) em "validationTokenHash" para a busca da portaria.
-- Ingressos existentes viram versão 0: o QR já enviado continua valendo. O token antigo
-- fica em "legacyValidationToken" só enquanto pode ser exibido de novo (VALID ou
-- REVOKED, que a restauração de reembolso pode devolver a VALID); some no check-in e na
-- transferência. Nenhum dado é apagado sem antes virar hash.

ALTER TABLE "IssuedTicket" RENAME COLUMN "validationToken" TO "legacyValidationToken";
DROP INDEX "IssuedTicket_validationToken_key";

ALTER TABLE "IssuedTicket" ADD COLUMN "validationTokenHash" TEXT;
UPDATE "IssuedTicket" SET "validationTokenHash" = encode(sha256(convert_to("legacyValidationToken", 'UTF8')), 'hex');
ALTER TABLE "IssuedTicket" ALTER COLUMN "validationTokenHash" SET NOT NULL;
CREATE UNIQUE INDEX "IssuedTicket_validationTokenHash_key" ON "IssuedTicket"("validationTokenHash");

ALTER TABLE "IssuedTicket" ALTER COLUMN "legacyValidationToken" DROP NOT NULL;
-- Já utilizado: o QR nunca mais é exibido; a busca segue pelo hash.
UPDATE "IssuedTicket" SET "legacyValidationToken" = NULL WHERE status = 'CHECKED_IN';

-- Existentes ficam na versão 0; novos começam na 1.
ALTER TABLE "IssuedTicket" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "IssuedTicket" ALTER COLUMN "tokenVersion" SET DEFAULT 1;
