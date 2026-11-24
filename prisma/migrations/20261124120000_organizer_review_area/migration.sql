-- Área do cadastro de organizador que a recusa pede para corrigir. Só acrescenta:
-- coluna anulável, sem valor para as recusas antigas (o reenvio delas continua
-- usando o texto do motivo).
CREATE TYPE "OrganizerReviewArea" AS ENUM ('PROFILE', 'BRAND', 'LEGAL', 'CONTACT', 'OTHER');

ALTER TABLE "Organization" ADD COLUMN "statusReasonArea" "OrganizerReviewArea";
