import { randomUUID } from "node:crypto";
import type { OrgRole, TicketKind } from "@/generated/prisma/client";
import { createPrismaClient } from "@/server/db";
import { SimulatedPaymentAdapter } from "@/server/payments/simulated";
import { createOrder } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";

export const db = createPrismaClient();
export const adapter = new SimulatedPaymentAdapter(db, process.env.SIMULATED_WEBHOOK_SECRET!);

export async function resetDb() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  await db.commissionRule.create({ data: { scope: "PLATFORM", percentBps: 700, policyVersion: "platform:default:v1" } });
}

let n = 0;
export async function makeUser(opts: { admin?: boolean; email?: string } = {}) {
  n++;
  return db.user.create({
    data: {
      email: opts.email ?? `user${n}-${randomUUID().slice(0, 6)}@test.local`,
      name: `Usuário ${n}`,
      passwordHash: "x",
      platformRole: opts.admin ? "ADMIN" : "USER",
    },
  });
}

export async function makeCity() {
  return db.city.upsert({
    where: { slug: "sao-paulo-sp" },
    create: { slug: "sao-paulo-sp", name: "São Paulo", state: "SP", timezone: "America/Sao_Paulo" },
    update: {},
  });
}

export async function makeCategory() {
  return db.eventCategory.upsert({ where: { slug: "shows" }, create: { slug: "shows", name: "Shows" }, update: {} });
}

export async function makeOrg(owner: { id: string }, opts: { status?: "APPROVED" | "PENDING_REVIEW"; extraMembers?: { userId: string; role: OrgRole }[] } = {}) {
  n++;
  return db.organization.create({
    data: {
      slug: `org-${n}-${randomUUID().slice(0, 6)}`,
      name: `Org ${n}`,
      legalType: "COMPANY",
      contactEmail: `org${n}@test.local`,
      status: opts.status ?? "APPROVED",
      paymentProvider: "simulated",
      paymentAccountStatus: "SIMULATED",
      members: { create: [{ userId: owner.id, role: "OWNER" }, ...(opts.extraMembers ?? [])] },
    },
  });
}

export interface TicketSpec {
  name?: string;
  kind?: TicketKind;
  priceCents: number;
  quantityTotal: number;
  maxPerOrder?: number;
}

export async function makeEvent(
  org: { id: string },
  opts: { tickets?: TicketSpec[]; capacity?: number; startsInDays?: number; halfPriceQuotaBps?: number; status?: "PUBLISHED" | "DRAFT" } = {},
) {
  const [city, category] = await Promise.all([makeCity(), makeCategory()]);
  const startsAt = new Date(Date.now() + (opts.startsInDays ?? 10) * 86_400_000);
  n++;
  return db.event.create({
    data: {
      organizationId: org.id,
      slug: `evento-${n}-${randomUUID().slice(0, 6)}`,
      title: `Evento ${n}`,
      description: "Descrição de teste com mais de vinte caracteres.",
      categoryId: category.id,
      cityId: city.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 4 * 3_600_000),
      timezone: "America/Sao_Paulo",
      salesStartAt: new Date(Date.now() - 86_400_000),
      salesEndAt: startsAt,
      capacity: opts.capacity ?? 1000,
      halfPriceQuotaBps: opts.halfPriceQuotaBps ?? null,
      status: opts.status ?? "PUBLISHED",
      refundPolicy: "Política de teste.",
      ticketTypes: {
        create: (opts.tickets ?? [{ priceCents: 10000, quantityTotal: 100 }]).map((t, i) => ({
          name: t.name ?? `Ingresso ${i + 1}`,
          kind: t.kind ?? (t.priceCents === 0 ? "FREE" : "GENERAL"),
          priceCents: t.priceCents,
          quantityTotal: t.quantityTotal,
          maxPerOrder: t.maxPerOrder ?? 10,
          sortOrder: i,
        })),
      },
    },
    include: { ticketTypes: { orderBy: { sortOrder: "asc" } } },
  });
}

export function orderInput(eventId: string, items: { ticketTypeId: string; quantity: number }[], extra: Record<string, unknown> = {}) {
  return { eventId, items, buyerName: "Comprador Teste", buyerEmail: "comprador@test.local", idempotencyKey: randomUUID(), ...extra };
}

export async function buy(user: { id: string; platformRole: "USER" | "ADMIN"; status: "ACTIVE" | "SUSPENDED" }, eventId: string, items: { ticketTypeId: string; quantity: number }[]) {
  return createOrder(db, user, orderInput(eventId, items), { providerIsSimulated: true });
}

/** Cria pedido, inicia PIX e aprova via webhook assinado. */
export async function buyAndPay(user: Parameters<typeof buy>[0], eventId: string, items: { ticketTypeId: string; quantity: number }[]) {
  const order = await buy(user, eventId, items);
  const payment = await startPayment(db, adapter, user, order.id, "PIX");
  const res = await handlePaymentWebhook(db, adapter, await adapter.simulate(payment.providerPaymentId!, "approve"));
  return { order, payment, webhook: res };
}

export async function ticketType(id: string) {
  return db.ticketType.findUniqueOrThrow({ where: { id } });
}
