-- Logo e capa do perfil público da organização (só aditivo, colunas opcionais).
ALTER TABLE "Organization" ADD COLUMN "logoUrl" TEXT,
ADD COLUMN "coverUrl" TEXT;
