// IDs de medição de anúncios do organizador por evento (Meta Pixel, GA4, Google Ads).
import "server-only";
import type { Db } from "../db";
import { audit } from "../audit";
import { AppError } from "../errors";
import { assertEventPermission, type Actor } from "../auth/permissions";
import { adTrackingSchema, type AdTrackingInput } from "@/lib/ad-tracking-schema";

/** Grava os IDs (vazio = remove). Exige event:write; auditado com os valores antes e depois. */
export async function setEventAdTracking(db: Db, actor: Actor, eventId: string, input: AdTrackingInput) {
  const parsed = adTrackingSchema.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Confira os IDs.");
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  return db.$transaction(async (tx) => {
    const before = await tx.event.findUniqueOrThrow({ where: { id: eventId }, select: { metaPixelId: true, ga4MeasurementId: true, googleAdsTag: true } });
    const after = await tx.event.update({ where: { id: eventId }, data: parsed.data, select: { metaPixelId: true, ga4MeasurementId: true, googleAdsTag: true } });
    await audit(tx, { actorUserId: actor.id, organizationId, action: "event.ad_tracking_updated", entityType: "Event", entityId: eventId, metadata: { before, after } });
    return after;
  });
}
