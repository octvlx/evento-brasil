import { beforeEach, expect, it } from "vitest";
import { db, resetDb, makeUser, makeOrg, makeEvent } from "../support/fixtures";
import { setEventAdTracking } from "@/server/services/ad-tracking";

beforeEach(resetDb);

it("organizador grava e remove os IDs; fica na auditoria; outra organização não pode", async () => {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  const ids = await setEventAdTracking(db, owner, event.id, { metaPixelId: "123456789012345", ga4MeasurementId: "G-ABC123XYZ", googleAdsTag: "AW-123456789/Rotulo1" });
  expect(ids).toEqual({ metaPixelId: "123456789012345", ga4MeasurementId: "G-ABC123XYZ", googleAdsTag: "AW-123456789/Rotulo1" });
  expect(await db.auditLog.findFirst({ where: { action: "event.ad_tracking_updated", entityId: event.id } })).toMatchObject({ actorUserId: owner.id, organizationId: org.id });

  await setEventAdTracking(db, owner, event.id, { metaPixelId: "", ga4MeasurementId: "", googleAdsTag: "" });
  expect(await db.event.findUniqueOrThrow({ where: { id: event.id }, select: { metaPixelId: true, ga4MeasurementId: true, googleAdsTag: true } })).toEqual({
    metaPixelId: null,
    ga4MeasurementId: null,
    googleAdsTag: null,
  });

  const stranger = await makeUser();
  await makeOrg(stranger);
  await expect(setEventAdTracking(db, stranger, event.id, { metaPixelId: "123456789012345", ga4MeasurementId: "", googleAdsTag: "" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(setEventAdTracking(db, owner, event.id, { metaPixelId: "abc", ga4MeasurementId: "", googleAdsTag: "" })).rejects.toMatchObject({ code: "VALIDATION" });
});

it("o banco recusa ID fora do formato", async () => {
  const org = await makeOrg(await makeUser());
  const event = await makeEvent(org);
  await expect(db.event.update({ where: { id: event.id }, data: { metaPixelId: "<script>" } })).rejects.toThrow(/Event_meta_pixel_format/);
  await expect(db.event.update({ where: { id: event.id }, data: { ga4MeasurementId: "UA-1-1" } })).rejects.toThrow(/Event_ga4_format/);
  await expect(db.event.update({ where: { id: event.id }, data: { googleAdsTag: "AW-1" } })).rejects.toThrow(/Event_google_ads_format/);
});
