// "Meus ingressos": próximos completos, anteriores paginados por evento (mais recente primeiro).
import { beforeEach, describe, expect, it } from "vitest";
import { loadMyTickets, PAST_PAGE_SIZE } from "@/server/services/my-tickets";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

describe("loadMyTickets", () => {
  it("pagina os eventos encerrados, do mais recente ao mais antigo, e só mostra o titular", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const buyer = await makeUser();
    const other = await makeUser();
    const events = [];
    for (let d = 1; d <= PAST_PAGE_SIZE + 2; d++) {
      const event = await makeEvent(org, { startsInDays: d, tickets: [{ priceCents: 1000, quantityTotal: 10 }] });
      const tt = await db.ticketType.findFirstOrThrow({ where: { eventId: event.id } });
      await buyAndPay(buyer, event.id, [{ ticketTypeId: tt.id, quantity: d === 1 ? 2 : 1 }]);
      events.push(event);
    }
    // Outro comprador no evento mais recente: os ingressos dele nunca aparecem.
    const lastTt = await db.ticketType.findFirstOrThrow({ where: { eventId: events.at(-1)!.id } });
    await buyAndPay(other, events.at(-1)!.id, [{ ticketTypeId: lastTt.id, quantity: 1 }]);

    // Hoje: tudo em "próximos", do mais próximo ao mais distante.
    const today = await loadMyTickets(db, buyer.id, undefined);
    expect(today.pastTotal).toBe(0);
    expect([...new Set(today.upcoming.map((t) => t.eventId))]).toEqual(events.map((e) => e.id));
    expect(today.upcoming).toHaveLength(events.length + 1);

    // Daqui a 30 dias todos terminaram: anteriores em páginas, mais recente primeiro.
    const later = new Date(Date.now() + 30 * 86_400_000);
    const p1 = await loadMyTickets(db, buyer.id, "1", later);
    expect(p1.upcoming).toHaveLength(0);
    expect(p1.pastTotal).toBe(events.length);
    expect(p1.pastPage).toMatchObject({ page: 1, pageCount: 2 });
    const newestFirst = [...events].reverse().map((e) => e.id);
    expect(p1.past.map((g) => g[0].eventId)).toEqual(newestFirst.slice(0, PAST_PAGE_SIZE));
    expect(p1.past.flat().every((t) => t.holderUserId === buyer.id)).toBe(true);

    const p2 = await loadMyTickets(db, buyer.id, "2", later);
    expect(p2.past.map((g) => g[0].eventId)).toEqual(newestFirst.slice(PAST_PAGE_SIZE));
    // O primeiro evento teve 2 ingressos: ficam juntos no mesmo grupo.
    expect(p2.past.at(-1)).toHaveLength(2);

    // Página fora do intervalo vai para a última; valor malformado, para a primeira.
    expect((await loadMyTickets(db, buyer.id, "99", later)).pastPage.page).toBe(2);
    expect((await loadMyTickets(db, buyer.id, "abc", later)).pastPage.page).toBe(1);
  });
});
