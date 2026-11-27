// Validação dos IDs de medição salvos pelo organizador (servidor). Separada de
// ad-tracking.ts para o zod não entrar no carregador que vai a todas as páginas.
import { z } from "zod";
import { AD_ID_FORMATS } from "./ad-tracking";

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
