// Galeria de fotos do evento (EventImage): até MAX_EVENT_IMAGES por evento, além da
// capa. Upload com a validação do armazenamento (tipo pelo conteúdo, até 5 MB) e
// tamanho mínimo; o banco só recebe URLs do próprio armazenamento. Ordem por
// `sortOrder` (mover troca com a vizinha). Texto alternativo sempre preenchido.
import "server-only";
import type { EventStatus } from "@/generated/prisma/client";
import type { Db } from "../db";
import { audit } from "../audit";
import { assertEventPermission, type Actor } from "../auth/permissions";
import { AppError, invalidState, notFound } from "../errors";
import { imageDimensions, MAX_IMAGE_BYTES, storeEventImage } from "../storage";

export const MAX_EVENT_IMAGES = 10;
export const EVENT_IMAGE_MIN_SIDE = 600;
const ALT_MAX = 200;
const EDITABLE: readonly EventStatus[] = ["DRAFT", "PENDING_REVIEW", "PUBLISHED"];

function cleanAlt(alt: string | null | undefined, fallback: string) {
  const text = (alt ?? "").trim().replace(/\s+/g, " ").slice(0, ALT_MAX);
  return text || fallback;
}

async function editableEvent(db: Db, actor: Actor, eventId: string) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { id: true, title: true, status: true, endsAt: true } });
  if (!EDITABLE.includes(event.status) || event.endsAt <= new Date()) throw invalidState("A galeria só pode ser alterada enquanto o evento não terminou.");
  return { organizationId, event };
}

export async function listEventImages(db: Db, eventId: string) {
  return db.eventImage.findMany({ where: { eventId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, url: true, alt: true, sortOrder: true } });
}

export async function addEventImage(db: Db, actor: Actor, eventId: string, file: File, alt?: string | null) {
  const { organizationId, event } = await editableEvent(db, actor, eventId);
  if ((await db.eventImage.count({ where: { eventId } })) >= MAX_EVENT_IMAGES) throw new AppError("VALIDATION", `A galeria aceita até ${MAX_EVENT_IMAGES} fotos.`);
  if (file.size > MAX_IMAGE_BYTES) throw new AppError("VALIDATION", "Imagem muito grande (máximo 5 MB).");
  const dims = imageDimensions(new Uint8Array(await file.arrayBuffer()));
  if (!dims) throw new AppError("VALIDATION", "Envie uma imagem JPG, PNG ou WebP válida.");
  if (Math.min(dims.width, dims.height) < EVENT_IMAGE_MIN_SIDE)
    throw new AppError("VALIDATION", `A foto precisa ter pelo menos ${EVENT_IMAGE_MIN_SIDE} px no lado menor (a enviada tem ${dims.width} × ${dims.height}).`);
  const stored = await storeEventImage(organizationId, file);
  return db.$transaction(async (tx) => {
    // Trava o evento: dois envios ao mesmo tempo não passam do limite nem repetem a ordem.
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
    const [count, last] = await Promise.all([
      tx.eventImage.count({ where: { eventId } }),
      tx.eventImage.findFirst({ where: { eventId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } }),
    ]);
    if (count >= MAX_EVENT_IMAGES) throw new AppError("VALIDATION", `A galeria aceita até ${MAX_EVENT_IMAGES} fotos.`);
    const image = await tx.eventImage.create({
      data: { eventId, url: stored.url, storageKey: stored.key, alt: cleanAlt(alt, `Foto de ${event.title}`), sortOrder: (last?.sortOrder ?? -1) + 1 },
    });
    await audit(tx, { actorUserId: actor.id, organizationId, action: "event.image_added", entityType: "Event", entityId: eventId, metadata: { imageId: image.id, url: image.url } });
    return image;
  });
}

async function imageWithEvent(db: Db, actor: Actor, imageId: string) {
  const image = await db.eventImage.findUnique({ where: { id: imageId }, select: { id: true, eventId: true, sortOrder: true } });
  if (!image) throw notFound("Foto não encontrada.");
  const ctx = await editableEvent(db, actor, image.eventId);
  return { image, ...ctx };
}

export async function updateEventImageAlt(db: Db, actor: Actor, imageId: string, alt: string) {
  const { image, event } = await imageWithEvent(db, actor, imageId);
  return db.eventImage.update({ where: { id: image.id }, data: { alt: cleanAlt(alt, `Foto de ${event.title}`) } });
}

/** Remove da galeria. O arquivo continua no armazenamento (pode estar em cópias do evento). */
export async function removeEventImage(db: Db, actor: Actor, imageId: string) {
  const { image, organizationId } = await imageWithEvent(db, actor, imageId);
  await db.$transaction(async (tx) => {
    await tx.eventImage.delete({ where: { id: image.id } });
    await audit(tx, { actorUserId: actor.id, organizationId, action: "event.image_removed", entityType: "Event", entityId: image.eventId, metadata: { imageId: image.id } });
  });
}

/** Troca a posição com a foto vizinha. Na ponta, não faz nada. */
export async function moveEventImage(db: Db, actor: Actor, imageId: string, direction: "up" | "down") {
  const { image } = await imageWithEvent(db, actor, imageId);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${image.eventId} FOR UPDATE`;
    const list = await tx.eventImage.findMany({ where: { eventId: image.eventId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } });
    const i = list.findIndex((x) => x.id === image.id);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    // Renumera 0..n-1: corrige também ordens repetidas de dados antigos.
    for (const [k, x] of list.entries()) await tx.eventImage.update({ where: { id: x.id }, data: { sortOrder: k } });
  });
}
