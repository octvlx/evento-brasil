// Medição de anúncios do organizador (Meta Pixel, Google Analytics 4, Google Ads) por
// evento. Sem "server-only": o formulário do organizador e o carregador no navegador
// usam os mesmos formatos e o mesmo cookie de consentimento.
// Sem zod aqui: o carregador (features/tracking) entra em todas as páginas, e o zod
// pesava ~34 KB comprimidos no navegador. A validação fica em ad-tracking-schema.ts.

/** Mesmos formatos dos CHECKs da migração 20261126120000_event_ad_tracking. */
export const AD_ID_FORMATS = {
  metaPixelId: /^[0-9]{10,20}$/,
  ga4MeasurementId: /^G-[A-Z0-9]{6,12}$/,
  googleAdsTag: /^AW-[0-9]{6,12}(\/[A-Za-z0-9_-]{4,40})?$/,
} as const;

export type AdTrackingIds = { metaPixelId: string | null; ga4MeasurementId: string | null; googleAdsTag: string | null };

export const hasAdTracking = (ids: AdTrackingIds) => !!(ids.metaPixelId || ids.ga4MeasurementId || ids.googleAdsTag);

/** Cookie da escolha do comprador sobre os cookies de medição dos organizadores. */
export const CONSENT_COOKIE = "eb_consent";
export type ConsentChoice = "aceito" | "recusado";
/** A escolha vale por 6 meses; depois o aviso aparece de novo. */
export const CONSENT_MAX_AGE = 60 * 60 * 24 * 182;
