-- Lembrete por e-mail antes do evento. Só acrescenta uma coluna anulável em "Event"
-- (marcador do cron); nenhuma linha existente muda.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "reminderQueuedFor" TIMESTAMPTZ(3);
