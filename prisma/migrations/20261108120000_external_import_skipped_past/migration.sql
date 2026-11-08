-- Contagem de eventos ignorados por já terem acontecido (só aditivo).
ALTER TABLE "ExternalImportRun" ADD COLUMN "skippedPast" INTEGER NOT NULL DEFAULT 0;
