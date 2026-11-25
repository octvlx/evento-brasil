-- Favoritos e seguir organizadores. Só acrescenta: duas tabelas novas e uma coluna
-- anulável em "Event" (marcador do aviso aos seguidores); nenhuma linha existente muda.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "followersNotifiedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "EventFavorite" (
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventFavorite_pkey" PRIMARY KEY ("userId","eventId")
);

-- CreateTable
CREATE TABLE "OrganizerFollow" (
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizerFollow_pkey" PRIMARY KEY ("userId","organizationId")
);

-- CreateIndex
CREATE INDEX "EventFavorite_userId_createdAt_idx" ON "EventFavorite"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EventFavorite_eventId_idx" ON "EventFavorite"("eventId");

-- CreateIndex
CREATE INDEX "OrganizerFollow_userId_createdAt_idx" ON "OrganizerFollow"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizerFollow_organizationId_idx" ON "OrganizerFollow"("organizationId");

-- AddForeignKey
ALTER TABLE "EventFavorite" ADD CONSTRAINT "EventFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventFavorite" ADD CONSTRAINT "EventFavorite_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerFollow" ADD CONSTRAINT "OrganizerFollow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerFollow" ADD CONSTRAINT "OrganizerFollow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

