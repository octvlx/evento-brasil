-- Leituras de check-in feitas offline e sincronizadas depois (só aditivo).
ALTER TABLE "TicketCheckin" ADD COLUMN "offline" BOOLEAN NOT NULL DEFAULT false;
