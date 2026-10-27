// Seed de DESENVOLVIMENTO. Dados fictícios; contas de demonstração marcadas
// com isDemoAccount (o login delas é recusado em produção).
// Uso: npm run db:seed
import "dotenv/config";
import { createPrismaClient } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { encryptPII } from "@/server/crypto";
import { defaultTimezoneForUF } from "@/lib/br";
import { zonedDateKey, zonedLocalToUtc } from "@/lib/datetime";
import { slugify } from "@/lib/utils";
import { createOrder } from "@/server/services/orders";
import { startPayment } from "@/server/services/payments";
import { SimulatedPaymentAdapter } from "@/server/payments/simulated";
import { handlePaymentWebhook } from "@/server/services/payments";
import { checkInTicket } from "@/server/services/checkin";
import { requestCustomerRefund } from "@/server/services/refunds";
import { qrPayload } from "@/server/services/tickets";
import { randomUUID } from "node:crypto";

if (process.env.NODE_ENV === "production") {
  console.error("Seed de demonstração não pode rodar em produção.");
  process.exit(1);
}

const db = createPrismaClient();
export const DEMO_PASSWORD = "Demo@2026!";

// Capitais de todas as UFs + Franca (SP). Somente nomes e UFs.
const CITIES: [name: string, uf: string, featured: boolean][] = [
  ["São Paulo", "SP", true], ["Rio de Janeiro", "RJ", true], ["Belo Horizonte", "MG", true], ["Curitiba", "PR", true],
  ["Florianópolis", "SC", true], ["Brasília", "DF", true], ["Salvador", "BA", true], ["Recife", "PE", true],
  ["Porto Alegre", "RS", true], ["Franca", "SP", true], ["Rio Branco", "AC", false], ["Maceió", "AL", false],
  ["Macapá", "AP", false], ["Manaus", "AM", false], ["Fortaleza", "CE", false], ["Vitória", "ES", false],
  ["Goiânia", "GO", false], ["São Luís", "MA", false], ["Cuiabá", "MT", false], ["Campo Grande", "MS", false],
  ["Belém", "PA", false], ["João Pessoa", "PB", false], ["Teresina", "PI", false], ["Natal", "RN", false],
  ["Porto Velho", "RO", false], ["Boa Vista", "RR", false], ["Aracaju", "SE", false], ["Palmas", "TO", false],
];

const CATEGORIES = [
  ["shows-e-musica", "Shows e música"], ["festas", "Festas"], ["teatro", "Teatro e espetáculos"], ["stand-up", "Stand-up"],
  ["festivais", "Festivais"], ["gastronomia", "Gastronomia"], ["esportes", "Esportes"], ["cursos-e-workshops", "Cursos e workshops"],
  ["infantil", "Infantil"], ["congressos", "Congressos e palestras"],
] as const;

const DEMO_ADMIN_EMAIL = "admin@demo.eventobrasil.test";

/**
 * O seed só roda em banco sem dados de uso. Retorna a mensagem de recusa, ou
 * null quando pode prosseguir (tabelas de referência, como cidades do IBGE,
 * ainda são limpas pelo wipe).
 */
async function refusalReason(): Promise<{ message: string; code: number } | null> {
  if (await db.user.findUnique({ where: { email: DEMO_ADMIN_EMAIL }, select: { id: true } })) {
    return {
      code: 0,
      message:
        `Banco já contém o seed de demonstração (${DEMO_ADMIN_EMAIL} existe) — nada a fazer.\n` +
        "Se uma execução anterior foi interrompida, ou para recriar os dados: npm run db:reset -- --yes",
    };
  }
  const [users, orgs, orders] = await Promise.all([db.user.count(), db.organization.count(), db.order.count()]);
  if (users + orgs + orders > 0) {
    return {
      code: 1,
      message:
        `Banco não está vazio (${users} usuários, ${orgs} organizações, ${orders} pedidos) e não é o seed de demonstração.\n` +
        "O seed apaga todas as tabelas; recusado para não destruir dados. Use um banco novo ou npm run db:reset -- --yes.",
    };
  }
  return null;
}

async function wipe() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

/** Data local no fuso, `days` dias à frente, no horário hh:mm. */
function at(days: number, hhmm: string, tz: string) {
  return zonedLocalToUtc(`${zonedDateKey(new Date(Date.now() + days * 86_400_000), tz)}T${hhmm}`, tz);
}

/** Dias até o próximo sábado (0 se hoje for sábado). */
function daysToSaturday(tz: string) {
  const dow = new Date(`${zonedDateKey(new Date(), tz)}T12:00:00Z`).getUTCDay();
  return (6 - dow + 7) % 7;
}

async function main() {
  const refusal = await refusalReason();
  if (refusal) {
    (refusal.code === 0 ? console.log : console.error)(refusal.message);
    process.exitCode = refusal.code;
    return;
  }
  await wipe();
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const user = (email: string, name: string, extra: object = {}) =>
    db.user.create({ data: { email, name, passwordHash, isDemoAccount: true, ...extra } });

  const admin = await user(DEMO_ADMIN_EMAIL, "Admin Demonstração", { platformRole: "ADMIN" });
  const producer = await user("produtora@demo.eventobrasil.test", "Paula Produtora (demo)", { phone: "11912345678" });
  const producer2 = await user("coletivo@demo.eventobrasil.test", "Caio Coletivo (demo)");
  const pendingOwner = await user("novo.organizador@demo.eventobrasil.test", "Nina Nova (demo)");
  const staff = await user("portaria@demo.eventobrasil.test", "Pedro Portaria (demo)");
  const customer = await user("cliente@demo.eventobrasil.test", "Clara Cliente (demo)", { phone: "21998765432" });

  await db.commissionRule.create({
    data: { scope: "PLATFORM", percentBps: 700, bearer: "ORGANIZER", processingFeeBearer: "ORGANIZER", policyVersion: "platform:default:v1", createdById: admin.id },
  });

  const categories = Object.fromEntries(
    await Promise.all(CATEGORIES.map(async ([slug, name], i) => [slug, await db.eventCategory.create({ data: { slug, name, sortOrder: i } })])),
  );
  const cities: Record<string, Awaited<ReturnType<typeof db.city.create>>> = {};
  for (const [name, uf, isFeatured] of CITIES) {
    cities[name] = await db.city.create({
      data: { name, state: uf, slug: slugify(`${name}-${uf}`), timezone: defaultTimezoneForUF(uf), isFeatured },
    });
  }

  const org = (slug: string, name: string, ownerId: string, legalType: "INDIVIDUAL" | "COMPANY", status: "APPROVED" | "PENDING_REVIEW", doc: string) =>
    db.organization.create({
      data: {
        slug,
        name,
        legalType,
        description: `${name} é uma organização FICTÍCIA criada para demonstração do Evento Brasil.`,
        contactEmail: `contato+${slug}@demo.eventobrasil.test`,
        status,
        autoPublishEvents: status === "APPROVED",
        paymentProvider: status === "APPROVED" ? "simulated" : null,
        paymentAccountStatus: status === "APPROVED" ? "SIMULATED" : "NOT_CONNECTED",
        paymentAccountExternalId: status === "APPROVED" ? `sim-seller-${slug}` : null,
        members: { create: { userId: ownerId, role: "OWNER" } },
        verifications: {
          create: {
            legalType,
            legalName: `${name} (fictício)`,
            documentType: legalType === "INDIVIDUAL" ? "CPF" : "CNPJ",
            // Documentos de teste válidos apenas pelo dígito verificador.
            documentEncrypted: encryptPII(doc),
            documentLast4: doc.slice(-4),
            status: status === "APPROVED" ? "APPROVED" : "SUBMITTED",
            submittedById: ownerId,
            reviewedById: status === "APPROVED" ? admin.id : null,
            reviewedAt: status === "APPROVED" ? new Date() : null,
          },
        },
      },
    });
  const sonora = await org("sonora-producoes-demo", "Sonora Produções (demo)", producer.id, "COMPANY", "APPROVED", "11222333000181");
  const coletivo = await org("coletivo-ritmo-demo", "Coletivo Ritmo (demo)", producer2.id, "INDIVIDUAL", "APPROVED", "52998224725");
  await org("estreia-eventos-demo", "Estreia Eventos (demo)", pendingOwner.id, "COMPANY", "PENDING_REVIEW", "45723174000110");
  await db.organizationMember.create({ data: { organizationId: sonora.id, userId: staff.id, role: "CHECKIN_STAFF" } });

  const venue = (cityName: string, label: string, capacity: number) =>
    db.venue.create({
      data: {
        cityId: cities[cityName].id,
        name: `${label} — local fictício`,
        slug: slugify(`${label}-${cityName}`),
        capacity,
        isFictional: true,
        // Sem endereço: locais de demonstração não existem.
        addressLine: null,
        accessibilityInfo: "Informações de acessibilidade ilustrativas: rampa de acesso e banheiro adaptado.",
      },
    });

  type Tt = { name: string; kind: "GENERAL" | "VIP" | "PROMOTIONAL" | "EARLY_BIRD" | "HALF_PRICE" | "FREE"; price: number; qty: number; max?: number };
  const mkEvent = async (o: {
    orgId: string;
    title: string;
    summary: string;
    category: keyof typeof categories;
    city: string;
    venueLabel: string;
    days: number;
    start: string;
    durationH: number;
    capacity: number;
    age?: number;
    featured?: boolean;
    halfQuota?: number;
    tickets: Tt[];
  }) => {
    const city = cities[o.city];
    const tz = city.timezone;
    const v = await venue(o.city, o.venueLabel, o.capacity);
    const startsAt = at(o.days, o.start, tz);
    const slug = slugify(`${o.title} ${o.city}`);
    return db.event.create({
      data: {
        organizationId: o.orgId,
        slug,
        title: o.title,
        summary: o.summary,
        description: `${o.summary}\n\nEste é um evento FICTÍCIO de demonstração. Nenhum ingresso real é vendido e o local não existe.`,
        categoryId: categories[o.category].id,
        coverImageUrl: `/placeholder/${slug}.svg`,
        venueId: v.id,
        cityId: city.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + o.durationH * 3_600_000),
        timezone: tz,
        ageRestriction: o.age ?? 0,
        salesStartAt: new Date(Date.now() - 7 * 86_400_000),
        salesEndAt: new Date(startsAt.getTime() + 2 * 3_600_000),
        capacity: o.capacity,
        halfPriceQuotaBps: o.halfQuota ?? null,
        status: "PUBLISHED",
        publishedAt: new Date(),
        isFeatured: o.featured ?? false,
        refundPolicy: "Reembolso integral em até 7 dias após a compra, desde que solicitado até 48h antes do evento. Em caso de cancelamento, reembolso automático.",
        accessibilityInfo: "Espaço reservado para cadeirantes e acompanhantes. Intérprete de Libras sob solicitação (ilustrativo).",
        ticketTypes: {
          create: o.tickets.map((t, i) => ({ name: t.name, kind: t.kind, priceCents: t.price, quantityTotal: t.qty, maxPerOrder: t.max ?? 6, sortOrder: i })),
        },
      },
    });
  };

  const sat = daysToSaturday("America/Sao_Paulo");
  const events = [
    await mkEvent({ orgId: sonora.id, title: "Noite de Samba no Terraço", summary: "Roda de samba com convidados e feijoada no fim de tarde.", category: "shows-e-musica", city: "São Paulo", venueLabel: "Terraço Aurora", days: sat, start: "18:00", durationH: 6, capacity: 300, featured: true, halfQuota: 4000,
      tickets: [{ name: "Inteira", kind: "GENERAL", price: 8000, qty: 200 }, { name: "Meia-entrada", kind: "HALF_PRICE", price: 4000, qty: 120 }, { name: "Camarote", kind: "VIP", price: 18000, qty: 40, max: 4 }] }),
    await mkEvent({ orgId: sonora.id, title: "Festival Litoral Sonoro", summary: "Dois palcos, música brasileira contemporânea e feira criativa.", category: "festivais", city: "Rio de Janeiro", venueLabel: "Arena Maré Alta", days: 21, start: "14:00", durationH: 10, capacity: 2000, featured: true, halfQuota: 4000,
      tickets: [{ name: "Lote promocional", kind: "EARLY_BIRD", price: 12000, qty: 300 }, { name: "Inteira", kind: "GENERAL", price: 18000, qty: 1200 }, { name: "Meia-entrada", kind: "HALF_PRICE", price: 9000, qty: 800 }, { name: "Área VIP", kind: "VIP", price: 38000, qty: 150, max: 4 }] }),
    await mkEvent({ orgId: coletivo.id, title: "Stand-up na Serra", summary: "Quatro comediantes, uma noite de humor mineiro.", category: "stand-up", city: "Belo Horizonte", venueLabel: "Teatro Pequeno Horizonte", days: sat + 1, start: "20:00", durationH: 2, capacity: 180, age: 14, featured: true, halfQuota: 4000,
      tickets: [{ name: "Inteira", kind: "GENERAL", price: 6000, qty: 140 }, { name: "Meia-entrada", kind: "HALF_PRICE", price: 3000, qty: 72 }] }),
    await mkEvent({ orgId: coletivo.id, title: "Workshop de Fotografia Urbana", summary: "Saída fotográfica guiada e edição básica no celular.", category: "cursos-e-workshops", city: "Curitiba", venueLabel: "Estúdio Araucária", days: 9, start: "09:00", durationH: 4, capacity: 25,
      tickets: [{ name: "Participante", kind: "GENERAL", price: 15000, qty: 25, max: 2 }] }),
    await mkEvent({ orgId: sonora.id, title: "Pôr do Sol Eletrônico", summary: "DJs locais ao pôr do sol, à beira da lagoa.", category: "festas", city: "Florianópolis", venueLabel: "Deck da Lagoa", days: sat, start: "16:00", durationH: 7, capacity: 500, age: 18, featured: true,
      tickets: [{ name: "Pista", kind: "GENERAL", price: 9000, qty: 450 }, { name: "Open bar VIP", kind: "VIP", price: 25000, qty: 50, max: 4 }] }),
    await mkEvent({ orgId: coletivo.id, title: "Congresso Cerrado Digital", summary: "Palestras sobre tecnologia, governo digital e inovação.", category: "congressos", city: "Brasília", venueLabel: "Centro de Convenções Planalto", days: 30, start: "08:30", durationH: 9, capacity: 800,
      tickets: [{ name: "Lote 1", kind: "EARLY_BIRD", price: 19000, qty: 200 }, { name: "Inteira", kind: "GENERAL", price: 29000, qty: 500 }, { name: "Estudante (meia)", kind: "HALF_PRICE", price: 14500, qty: 200 }] }),
    await mkEvent({ orgId: sonora.id, title: "Axé de Rua — Ensaio Aberto", summary: "Ensaio aberto de bloco com percussão ao vivo.", category: "festas", city: "Salvador", venueLabel: "Largo do Farol", days: 6, start: "19:00", durationH: 4, capacity: 1500, featured: true,
      tickets: [{ name: "Entrada gratuita", kind: "FREE", price: 0, qty: 1500, max: 4 }] }),
    await mkEvent({ orgId: coletivo.id, title: "Frevo & Maracatu na Praça", summary: "Oficina de passos de frevo seguida de cortejo de maracatu.", category: "shows-e-musica", city: "Recife", venueLabel: "Praça das Calungas", days: sat + 7, start: "16:00", durationH: 4, capacity: 400, halfQuota: 4000,
      tickets: [{ name: "Inteira", kind: "GENERAL", price: 4000, qty: 300 }, { name: "Meia-entrada", kind: "HALF_PRICE", price: 2000, qty: 160 }] }),
    await mkEvent({ orgId: sonora.id, title: "Feira Gastronômica do Sul", summary: "Chefs convidados, churrasco e vinhos da serra gaúcha.", category: "gastronomia", city: "Porto Alegre", venueLabel: "Galpão Guaíba", days: 13, start: "12:00", durationH: 8, capacity: 900, age: 18,
      tickets: [{ name: "Entrada + degustação", kind: "GENERAL", price: 7000, qty: 800 }, { name: "Promocional (2 pessoas)", kind: "PROMOTIONAL", price: 12000, qty: 100, max: 2 }] }),
    await mkEvent({ orgId: coletivo.id, title: "Corrida Noturna das Três Colinas", summary: "Corrida de 5 km e 10 km com kit e medalha.", category: "esportes", city: "Franca", venueLabel: "Parque das Colinas", days: 16, start: "19:30", durationH: 3, capacity: 600,
      tickets: [{ name: "Kit 5 km", kind: "GENERAL", price: 9000, qty: 300 }, { name: "Kit 10 km", kind: "GENERAL", price: 11000, qty: 300 }] }),
    await mkEvent({ orgId: sonora.id, title: "Teatro Infantil: A Lua Curiosa", summary: "Espetáculo musical para crianças de 3 a 9 anos.", category: "infantil", city: "São Paulo", venueLabel: "Teatro Jardim", days: sat + 1, start: "11:00", durationH: 1.5, capacity: 120, halfQuota: 4000,
      tickets: [{ name: "Inteira", kind: "GENERAL", price: 5000, qty: 80 }, { name: "Meia-entrada", kind: "HALF_PRICE", price: 2500, qty: 48 }] }),
    await mkEvent({ orgId: coletivo.id, title: "Jazz no Mirante", summary: "Quarteto de jazz instrumental com vista para a cidade.", category: "shows-e-musica", city: "Rio de Janeiro", venueLabel: "Mirante Azul", days: 4, start: "20:30", durationH: 2.5, capacity: 6,
      tickets: [{ name: "Mesa individual", kind: "GENERAL", price: 12000, qty: 6, max: 2 }] }),
  ];

  // Compras reais pelo fluxo de serviço (provedor simulado), para os painéis.
  const adapter = new SimulatedPaymentAdapter(db, process.env.SIMULATED_WEBHOOK_SECRET ?? "dev-only-simulated-webhook-secret");
  const buy = async (eventIdx: number, tickets: { idx: number; qty: number }[], half = false) => {
    const e = events[eventIdx];
    const types = await db.ticketType.findMany({ where: { eventId: e.id }, orderBy: { sortOrder: "asc" } });
    const order = await createOrder(
      db,
      customer,
      {
        eventId: e.id,
        items: tickets.map((t) => ({ ticketTypeId: types[t.idx].id, quantity: t.qty })),
        buyerName: customer.name,
        buyerEmail: customer.email,
        halfPriceDeclaration: half,
        idempotencyKey: randomUUID(),
      },
      { providerIsSimulated: true },
    );
    if (order.totalCents === 0) return order;
    const payment = await startPayment(db, adapter, customer, order.id, "PIX");
    await handlePaymentWebhook(db, adapter, await adapter.simulate(payment.providerPaymentId!, "approve"));
    return order;
  };
  const o1 = await buy(0, [{ idx: 0, qty: 2 }, { idx: 1, qty: 1 }], true);
  await buy(1, [{ idx: 0, qty: 2 }]);
  await buy(6, [{ idx: 0, qty: 2 }]);
  await buy(4, [{ idx: 0, qty: 1 }]);
  await buy(11, [{ idx: 0, qty: 2 }]);
  const o4 = await buy(5, [{ idx: 0, qty: 1 }]);
  // Um check-in e um reembolso para os relatórios.
  const t1 = await db.issuedTicket.findFirstOrThrow({ where: { orderId: o1.id } });
  await checkInTicket(db, producer, events[0].id, qrPayload(t1));
  process.env.REFUND_WINDOW_DAYS ??= "7";
  process.env.REFUND_MIN_HOURS_BEFORE_EVENT ??= "48";
  try {
    await requestCustomerRefund(db, adapter, customer, o4.id);
  } catch (e) {
    console.warn("Reembolso de demonstração não aplicado:", (e as Error).message);
  }
  await db.eventStaffAssignment.create({ data: { eventId: events[0].id, userId: staff.id, assignedById: producer.id } });

  // Cupom e link rastreado de exemplo (ADR 0002). Sem efeito no preço até o passo 2.
  // A meia-entrada fica fora do cupom (D3): só os tipos que não são HALF_PRICE.
  const sambaTypes = await db.ticketType.findMany({ where: { eventId: events[0].id, kind: { not: "HALF_PRICE" } }, select: { id: true } });
  const demo10 = await db.coupon.create({
    data: {
      organizationId: sonora.id,
      eventId: events[0].id,
      code: "DEMO10",
      description: "Cupom de demonstração: 10% na Noite de Samba (exceto meia-entrada)",
      discountType: "PERCENT",
      percentBps: 1000,
      maxUses: 100,
      createdById: producer.id,
      ticketTypes: { create: sambaTypes.map((t) => ({ ticketTypeId: t.id })) },
    },
  });
  await db.trackingLink.create({
    data: {
      organizationId: sonora.id,
      eventId: events[0].id,
      code: "demoSamba1",
      name: "Instagram — divulgação (demo)",
      utmSource: "instagram",
      utmMedium: "social",
      utmCampaign: "noite-de-samba",
      couponId: demo10.id,
      createdById: producer.id,
    },
  });

  console.log("Seed concluído. Senha de todas as contas demo:", DEMO_PASSWORD);
  console.log("Contas: admin@, produtora@, coletivo@, novo.organizador@, portaria@, cliente@ (domínio demo.eventobrasil.test)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
