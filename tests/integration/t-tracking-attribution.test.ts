// ADR 0002, passo 4: rota pública /r/[code] (clique, cookie eb_attr, links
// arquivados/desconhecidos) e atribuição do pedido lida só do cookie na Server Action.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { db, makeEvent, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";

// A Server Action lê cookies e a sessão do pedido HTTP: aqui, um pote de cookies e um usuário fixos.
const jar = new Map<string, string>();
let currentUser: Awaited<ReturnType<typeof makeUser>> | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
  }),
  // createOrderAction lê o IP para o limite de pedidos (conformidade, L4a).
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ refresh: () => {} }));
vi.mock("@/server/auth/current", () => ({
  getCurrentUser: async () => currentUser,
  requireUser: async () => currentUser,
  requireAdmin: async () => currentUser,
}));

const { GET } = await import("@/app/r/[code]/route");
const { captureUtmAction, createOrderAction } = await import("@/features/orders/actions");

beforeEach(async () => {
  await resetDb();
  jar.clear();
  currentUser = null;
});
afterEach(async () => {
  expect(await checkFinancialInvariants(db)).toEqual([]);
});

async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ name: "Inteira", priceCents: 10000, quantityTotal: 50 }] });
  const other = await makeEvent(org, { tickets: [{ name: "Inteira", priceCents: 10000, quantityTotal: 50 }] });
  const coupon = await db.coupon.create({
    data: { organizationId: org.id, eventId: event.id, code: "LINK10", discountType: "PERCENT", percentBps: 1000, maxUsesPerUser: null, createdById: owner.id },
  });
  const link = (data: { code: string; eventId?: string; archivedAt?: Date; couponId?: string }) =>
    db.trackingLink.create({
      data: { organizationId: org.id, eventId: event.id, name: "Instagram", utmSource: "instagram", utmMedium: "social", utmCampaign: "lancamento", createdById: owner.id, ...data },
    });
  return { owner, org, event, other, coupon, link };
}

const visit = (code: string) => GET(new Request(`http://localhost:3000/r/${code}`), { params: Promise.resolve({ code }) });

function attrCookie(res: Response) {
  const header = res.headers.get("set-cookie");
  if (!header) return null;
  const [pair, ...attrs] = header.split(";").map((p) => p.trim());
  const value = decodeURIComponent(pair.slice(pair.indexOf("=") + 1));
  return { name: pair.slice(0, pair.indexOf("=")), value, attrs: attrs.map((a) => a.toLowerCase()) };
}

describe("T — link rastreado /r/[code]", () => {
  it("conta o clique, grava eb_attr (httpOnly, lax, 7 dias) com o id e os UTMs do link e redireciona ao evento", async () => {
    const { event, link } = await setup();
    const l = await link({ code: "insta1" });

    const res = await visit("insta1");
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe(`/eventos/${event.slug}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = attrCookie(res)!;
    expect(cookie.name).toBe("eb_attr");
    expect(JSON.parse(cookie.value)).toEqual({ trackingLinkId: l.id, utmSource: "instagram", utmMedium: "social", utmCampaign: "lancamento" });
    expect(cookie.attrs).toEqual(expect.arrayContaining(["httponly", "samesite=lax", "path=/", `max-age=${7 * 24 * 3600}`]));
    expect(cookie.attrs).not.toContain("secure"); // só em produção

    await visit("insta1");
    expect((await db.trackingLink.findUniqueOrThrow({ where: { id: l.id } })).clicks).toBe(2);
  });

  it("cliques simultâneos são todos contados (incremento atômico)", async () => {
    const { link } = await setup();
    const l = await link({ code: "corrida" });
    await Promise.all(Array.from({ length: 20 }, () => visit("corrida")));
    expect((await db.trackingLink.findUniqueOrThrow({ where: { id: l.id } })).clicks).toBe(20);
  });

  it("código desconhecido, malformado ou link arquivado: vai para /eventos, sem cookie e sem contar clique", async () => {
    const { link } = await setup();
    const archived = await link({ code: "antigo1", archivedAt: new Date() });
    for (const code of ["naoexiste", "antigo1", "curto", "x".repeat(40), "a%20b"]) {
      const res = await visit(code);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/eventos");
      expect(attrCookie(res)).toBeNull();
    }
    expect((await db.trackingLink.findUniqueOrThrow({ where: { id: archived.id } })).clicks).toBe(0);
  });

  it("link de evento que não está público não redireciona para ele", async () => {
    const { org, owner } = await setup();
    const draft = await makeEvent(org, { status: "DRAFT" });
    await db.trackingLink.create({ data: { organizationId: org.id, eventId: draft.id, code: "rascunho", name: "x", createdById: owner.id } });
    const res = await visit("rascunho");
    expect(new URL(res.headers.get("location")!).pathname).toBe("/eventos");
    expect(attrCookie(res)).toBeNull();
  });
});

describe("T — atribuição na Server Action", () => {
  it("usa o cookie do link (com o cupom pré-aplicado) e ignora a atribuição enviada no corpo", async () => {
    const { event, coupon, link } = await setup();
    const l = await link({ code: "comcupom", couponId: coupon.id });
    jar.set("eb_attr", attrCookie(await visit("comcupom"))!.value);
    currentUser = await makeUser();

    const res = await createOrderAction(
      orderInput(event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }], {
        couponCode: "LINK10",
        attribution: { trackingLinkId: "forjado", utmSource: "corpo-da-requisicao" },
      }) as Parameters<typeof createOrderAction>[0],
    );
    expect(res.ok).toBe(true);
    const order = await db.order.findUniqueOrThrow({ where: { id: res.ok ? res.data.orderId : "" } });
    expect(order).toMatchObject({ trackingLinkId: l.id, utmSource: "instagram", utmMedium: "social", utmCampaign: "lancamento", couponCode: "LINK10", discountCents: 1000 });
  });

  it("sem cookie, a atribuição do corpo é descartada", async () => {
    const { event } = await setup();
    currentUser = await makeUser();
    const res = await createOrderAction(
      orderInput(event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }], { attribution: { utmSource: "forjado" } }) as Parameters<typeof createOrderAction>[0],
    );
    expect(res.ok).toBe(true);
    const order = await db.order.findUniqueOrThrow({ where: { id: res.ok ? res.data.orderId : "" } });
    expect(order).toMatchObject({ trackingLinkId: null, utmSource: null });
  });

  it("UTMs soltos da URL do evento substituem o link anterior; link de outro evento é descartado pelo serviço", async () => {
    const { event, other, link } = await setup();
    await link({ code: "outroev", eventId: other.id });
    jar.set("eb_attr", attrCookie(await visit("outroev"))!.value);
    currentUser = await makeUser();

    // Cookie de link de outro evento: o pedido deste evento fica sem link e sem os UTMs do link.
    let res = await createOrderAction(orderInput(event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]) as Parameters<typeof createOrderAction>[0]);
    expect(res.ok).toBe(true);
    expect(await db.order.findUniqueOrThrow({ where: { id: res.ok ? res.data.orderId : "" } })).toMatchObject({ trackingLinkId: null, utmSource: null });

    // Visita com UTMs soltos: último clique vence, sem link.
    await captureUtmAction({ utm_source: "newsletter", utm_campaign: "x".repeat(500), outro: "ignorado" });
    expect(JSON.parse(jar.get("eb_attr")!)).toEqual({ utmSource: "newsletter", utmCampaign: "x".repeat(200) });
    res = await createOrderAction(orderInput(event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]) as Parameters<typeof createOrderAction>[0]);
    expect(res.ok).toBe(true);
    expect(await db.order.findUniqueOrThrow({ where: { id: res.ok ? res.data.orderId : "" } })).toMatchObject({ trackingLinkId: null, utmSource: "newsletter", utmCampaign: "x".repeat(200) });
  });

  it("cookie adulterado é ignorado", async () => {
    const { event } = await setup();
    currentUser = await makeUser();
    jar.set("eb_attr", "{not json");
    const res = await createOrderAction(orderInput(event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]) as Parameters<typeof createOrderAction>[0]);
    expect(res.ok).toBe(true);
    expect(await db.order.findUniqueOrThrow({ where: { id: res.ok ? res.data.orderId : "" } })).toMatchObject({ trackingLinkId: null, utmSource: null });
  });
});
