// Lista de eventos do painel: busca no título, filtro de situação (pelo relógio) e páginas.
import { beforeEach, describe, expect, it } from "vitest";
import { listOrganizationEventsPage, type OrganizerEventFilter } from "@/server/services/events";
import { db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const DAY = 86_400_000;

async function setup() {
  const owner = await makeUser();
  const staff = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: staff.id, role: "FINANCE" }] });
  const samba = await makeEvent(org, { startsInDays: 10 });
  await db.event.update({ where: { id: samba.id }, data: { title: "Noite de Samba" } });
  const rock = await makeEvent(org, { startsInDays: 20 });
  await db.event.update({ where: { id: rock.id }, data: { title: "Rock na Praça" } });
  const draft = await makeEvent(org, { startsInDays: 30, status: "DRAFT" });
  // Publicado com término já passado: aparece como encerrado mesmo antes do job.
  const ended = await makeEvent(org, { startsAt: new Date(Date.now() - 3 * DAY), salesStartAt: new Date(Date.now() - 6 * DAY) });
  await db.event.update({ where: { id: ended.id }, data: { endsAt: new Date(Date.now() - 2 * DAY), salesEndAt: new Date(Date.now() - 2 * DAY - 60_000) } });
  return { owner, staff, org, samba, rock, draft, ended };
}

describe("listOrganizationEventsPage", () => {
  it("busca no título sem diferenciar maiúsculas", async () => {
    const { owner, org, samba } = await setup();
    const r = await listOrganizationEventsPage(db, owner, org.id, { q: "  sAMBA " });
    expect(r.rows.map((e) => e.id)).toEqual([samba.id]);
    expect(r).toMatchObject({ total: 1, all: 4, q: "sAMBA" });
  });

  it("filtra por situação, com publicado e encerrado pelo relógio", async () => {
    const { owner, org, samba, rock, draft, ended } = await setup();
    const ids = async (status: OrganizerEventFilter) =>
      (await listOrganizationEventsPage(db, owner, org.id, { status })).rows.map((e) => e.id).sort();
    expect(await ids("PUBLISHED")).toEqual([samba.id, rock.id].sort());
    expect(await ids("COMPLETED")).toEqual([ended.id]);
    expect(await ids("DRAFT")).toEqual([draft.id]);
    expect(await ids("CANCELLED")).toEqual([]);
  });

  it("pagina mantendo a ordem (início mais recente primeiro) e corrige página fora do intervalo", async () => {
    const { owner, org } = await setup();
    const p1 = await listOrganizationEventsPage(db, owner, org.id, { pageSize: 3 });
    const p2 = await listOrganizationEventsPage(db, owner, org.id, { pageSize: 3, page: 2 });
    expect([p1.pageCount, p1.rows.length, p2.rows.length]).toEqual([2, 3, 1]);
    const all = [...p1.rows, ...p2.rows].map((e) => e.startsAt.getTime());
    expect(all).toEqual([...all].sort((a, b) => b - a));
    expect((await listOrganizationEventsPage(db, owner, org.id, { pageSize: 3, page: 99 })).page).toBe(2);
    expect((await listOrganizationEventsPage(db, owner, org.id, { pageSize: 3, page: -1 })).page).toBe(1);
  });

  it("só membros da organização (FINANCE vê a lista)", async () => {
    const { staff, org } = await setup();
    await expect(listOrganizationEventsPage(db, staff, org.id)).resolves.toBeTruthy();
    await expect(listOrganizationEventsPage(db, await makeUser(), org.id)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
  });
});
