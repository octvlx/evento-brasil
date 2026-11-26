// Medição de anúncios do organizador (Meta Pixel, Google Analytics 4, Google Ads) por
// evento. Sem "server-only": o formulário do organizador e o carregador no navegador
// usam os mesmos formatos e o mesmo cookie de consentimento.
import { z } from "zod";

/** Mesmos formatos dos CHECKs da migração 20261126120000_event_ad_tracking. */
export const AD_ID_FORMATS = {
  metaPixelId: /^[0-9]{10,20}$/,
  ga4MeasurementId: /^G-[A-Z0-9]{6,12}$/,
  googleAdsTag: /^AW-[0-9]{6,12}(\/[A-Za-z0-9_-]{4,40})?$/,
} as const;

const field = (re: RegExp, msg: string) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, ""))
    .refine((v) => v === "" || re.test(v), msg)
    .transform((v) => (v === "" ? null : v));

export const adTrackingSchema = z.object({
  metaPixelId: field(AD_ID_FORMATS.metaPixelId, "ID do Meta Pixel: só números (ex.: 123456789012345)."),
  ga4MeasurementId: field(AD_ID_FORMATS.ga4MeasurementId, "ID do Google Analytics 4: começa com G- (ex.: G-ABC123XYZ)."),
  googleAdsTag: field(AD_ID_FORMATS.googleAdsTag, "Google Ads: AW-123456789 ou AW-123456789/rótulo-da-conversão."),
});
export type AdTrackingInput = z.input<typeof adTrackingSchema>;

export type AdTrackingIds = { metaPixelId: string | null; ga4MeasurementId: string | null; googleAdsTag: string | null };

export const hasAdTracking = (ids: AdTrackingIds) => !!(ids.metaPixelId || ids.ga4MeasurementId || ids.googleAdsTag);

/** Cookie da escolha do comprador sobre os cookies de medição dos organizadores. */
export const CONSENT_COOKIE = "eb_consent";
export type ConsentChoice = "aceito" | "recusado";
/** A escolha vale por 6 meses; depois o aviso aparece de novo. */
export const CONSENT_MAX_AGE = 60 * 60 * 24 * 182;
