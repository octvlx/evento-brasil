// Galeria de fotos do evento: envio validado, limite, ordem, descrição, remoção,
// permissões, evento encerrado, cópia ao duplicar e página pública.
import { beforeEach, describe, expect, it } from "vitest";
import { addEventImage, listEventImages, MAX_EVENT_IMAGES, moveEventImage, removeEventImage, updateEventImageAlt } from "@/server/services/event-images";
import { duplicateEvent } from "@/server/services/events";
import { getPublicEvent } from "@/server/services/catalog";
import { utcToZonedLocalInput } from "@/lib/datetime";
import { db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

/** PNG mínimo com o cabeçalho IHDR nas dimensões pedidas (só o cabeçalho é lido). */
function png(width = 1200, height = 800) {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return new File([b], "foto.png", { type: "image/png" });
}

async function setup() {
  const owner = await makeUser();
  const finance = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: finance.id, role: "FINANCE" }] });
  const event = await makeEvent(org, { startsInDays: 15 });
  return { owner, finance, org, event };
}

const order = async (eventId: string) => (await listEventImages(db, eventId)).map((i) => i.alt);

describe("galeria do evento", () => {
  it("adiciona com descrição (ou uma padrão), na ordem de envio, e audita", async () => {
    const { owner, event } = await setup();
    const a = await addEventImage(db, owner, event.id, png(), "  Palco   principal ");
    await addEventImage(db, owner, event.id, png(), "");
    expect(a.url).toMatch(/^\/uploads\/events\//);
    expect(await order(event.id)).toEqual(["Palco principal", `Foto de ${event.title}`]);
    expect(await db.auditLog.count({ where: { entityId: event.id, action: "event.image_added" } })).toBe(2);
  });

  it("recusa foto pequena, arquivo que não é imagem e acima do limite de fotos", async () => {
    const { owner, event } = await setup();
    await expect(addEventImage(db, owner, event.id, png(500, 900))).rejects.toThrow(/600 px/);
    await expect(addEventImage(db, owner, event.id, new File(["oi"], "x.txt"))).rejects.toMatchObject({ code: "VALIDATION" });
    for (let i = 0; i < MAX_EVENT_IMAGES; i++) await addEventImage(db, owner, event.id, png(), `f${i}`);
    await expect(addEventImage(db, owner, event.id, png())).rejects.toThrow(/até 10 fotos/);
  });

  it("envios simultâneos não passam do limite", async () => {
    const { owner, event } = await setup();
    for (let i = 0; i < MAX_EVENT_IMAGES - 1; i++) await addEventImage(db, owner, event.id, png(), `f${i}`);
    const results = await Promise.allSettled([addEventImage(db, owner, event.id, png(), "x"), addEventImage(db, owner, event.id, png(), "y")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.eventImage.count({ where: { eventId: event.id } })).toBe(MAX_EVENT_IMAGES);
  });

  it("move, edita a descrição e remove", async () => {
    const { owner, event } = await setup();
    const [a, b, c] = [await addEventImage(db, owner, event.id, png(), "A"), await addEventImage(db, owner, event.id, png(), "B"), await addEventImage(db, owner, event.id, png(), "C")];
    await moveEventImage(db, owner, c.id, "up");
    expect(await order(event.id)).toEqual(["A", "C", "B"]);
    await moveEventImage(db, owner, a.id, "up"); // na ponta: nada muda
    expect(await order(event.id)).toEqual(["A", "C", "B"]);
    await updateEventImageAlt(db, owner, b.id, "Plateia");
    await removeEventImage(db, owner, a.id);
    expect(await order(event.id)).toEqual(["C", "Plateia"]);
  });

  it("exige event:write e evento não encerrado", async () => {
    const { owner, finance, org, event } = await setup();
    await expect(addEventImage(db, finance, event.id, png())).rejects.toMatchObject({ code: "FORBIDDEN" });
    const img = await addEventImage(db, owner, event.id, png(), "A");
    await expect(removeEventImage(db, await makeUser(), img.id)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    const past = await makeEvent(org, { startsAt: new Date(Date.now() - 3 * 86_400_000), salesStartAt: new Date(Date.now() - 6 * 86_400_000) });
    await db.event.update({ where: { id: past.id }, data: { endsAt: new Date(Date.now() - 86_400_000), salesEndAt: new Date(Date.now() - 86_400_000 - 60_000) } });
    await expect(addEventImage(db, owner, past.id, png())).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("duplicar copia a galeria na mesma ordem; a página pública mostra as fotos", async () => {
    const { owner, event } = await setup();
    await addEventImage(db, owner, event.id, png(), "A");
    await addEventImage(db, owner, event.id, png(), "B");
    const copy = await duplicateEvent(db, owner, event.id, utcToZonedLocalInput(new Date(Date.now() + 60 * 86_400_000), event.timezone));
    expect(await order(copy.id)).toEqual(["A", "B"]);
    const pub = await getPublicEvent(db, event.slug);
    expect(pub?.event.images.map((i) => i.alt)).toEqual(["A", "B"]);
  });
});
