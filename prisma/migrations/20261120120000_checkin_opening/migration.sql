-- Check-in: a portaria abre N minutos antes do inicio (padrao 6 h). O organizador
-- escolhe de 0 a 7 dias (regra no servico); o banco aceita ate 1 ano (dados de teste
-- e demonstracao).
-- Eventos existentes recebem o padrao.
ALTER TABLE "Event" ADD COLUMN "checkinOpensMinutesBefore" INTEGER NOT NULL DEFAULT 360;
ALTER TABLE "Event" ADD CONSTRAINT "Event_checkinOpensMinutesBefore_range" CHECK ("checkinOpensMinutesBefore" BETWEEN 0 AND 525600);
