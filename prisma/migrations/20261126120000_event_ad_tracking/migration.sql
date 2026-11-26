-- Pixels de anúncio do organizador por evento. Só acrescenta três colunas anuláveis em
-- "Event" (com CHECK de formato); nenhuma linha existente muda.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "ga4MeasurementId" TEXT,
ADD COLUMN     "googleAdsTag" TEXT,
ADD COLUMN     "metaPixelId" TEXT;


-- Formatos aceitos (o mesmo que src/lib/ad-tracking.ts valida).
ALTER TABLE "Event" ADD CONSTRAINT "Event_meta_pixel_format" CHECK ("metaPixelId" IS NULL OR "metaPixelId" ~ '^[0-9]{10,20}$');
ALTER TABLE "Event" ADD CONSTRAINT "Event_ga4_format" CHECK ("ga4MeasurementId" IS NULL OR "ga4MeasurementId" ~ '^G-[A-Z0-9]{6,12}$');
ALTER TABLE "Event" ADD CONSTRAINT "Event_google_ads_format" CHECK ("googleAdsTag" IS NULL OR "googleAdsTag" ~ '^AW-[0-9]{6,12}(/[A-Za-z0-9_-]{4,40})?$');
