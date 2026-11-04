// Seed de DESENVOLVIMENTO. Dados fictícios; contas de demonstração marcadas
// com isDemoAccount (o login delas é recusado em produção).
// Uso: npm run db:seed
import "dotenv/config";
import { createPrismaClient } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { encryptPII, randomToken } from "@/server/crypto";
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
import { createHash, createHmac, randomUUID } from "node:crypto";

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

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Termos v1 (R10): RASCUNHOS técnicos, pendentes de revisão jurídica (D8). Os
 * textos das páginas ainda são JSX provisório, então o hash é um marcador
 * documentado, sha256("evento-brasil:termos:<KIND>:v1:rascunho"), e não o hash
 * do texto exibido. A versão final é uma linha nova (isDraft = false); a tabela
 * é somente inserção.
 */
export const DEMO_TERMS = [
  { kind: "BUYER", documentPath: "/termos" },
  { kind: "PRIVACY", documentPath: "/privacidade" },
  // Ainda sem página própria.
  { kind: "ORGANIZER", documentPath: null },
].map((t) => ({ ...t, version: "v1", textHash: sha256(`evento-brasil:termos:${t.kind}:v1:rascunho`) })) as {
  kind: "BUYER" | "PRIVACY" | "ORGANIZER";
  documentPath: string | null;
  version: string;
  textHash: string;
}[];

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
    db.user.create({ data: { email, name, passwordHash, isDemoAccount: true, emailVerifiedAt: new Date(), ...extra } });

  const admin = await user(DEMO_ADMIN_EMAIL, "Admin Demonstração", { platformRole: "ADMIN", adminRoles: ["SUPER_ADMIN"] });
  // Admin só de suporte (T6): vê clientes, transferências e cancelamentos; não mexe em comissões nem reembolsos.
  const supportAdmin = await user("suporte@demo.eventobrasil.test", "Sofia Suporte (demo)", { platformRole: "ADMIN", adminRoles: ["SUPPORT"] });
  const producer = await user("produtora@demo.eventobrasil.test", "Paula Produtora (demo)", { phone: "11912345678" });
  const producer2 = await user("coletivo@demo.eventobrasil.test", "Caio Coletivo (demo)");
  const pendingOwner = await user("novo.organizador@demo.eventobrasil.test", "Nina Nova (demo)");
  const staff = await user("portaria@demo.eventobrasil.test", "Pedro Portaria (demo)");
  const customer = await user("cliente@demo.eventobrasil.test", "Clara Cliente (demo)", { phone: "21998765432" });
  // Destinatária da transferência aceita.
  const friend = await user("amiga@demo.eventobrasil.test", "Ana Amiga (demo)");
  // Identidades e endereços exclusivamente fictícios para os compradores demo.
  for (const [buyer, cpf] of [[customer, "52998224725"], [friend, "11144477735"]] as const) {
    await db.user.update({ where: { id: buyer.id }, data: {
      cpfEncrypted: encryptPII(cpf),
      cpfHash: createHmac("sha256", process.env.DATA_ENCRYPTION_KEY!).update(`buyer-cpf:${cpf}`).digest("hex"),
      cpfLast2: cpf.slice(-2), birthDate: new Date("1995-04-15T00:00:00Z"),
      address: { create: { postalCode: "01001000", street: "Praça da Sé", number: "100", district: "Sé", city: "São Paulo", state: "SP" } },
    } });
  }

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
  const estreia = await org("estreia-eventos-demo", "Estreia Eventos (demo)", pendingOwner.id, "COMPANY", "PENDING_REVIEW", "45723174000110");

  // Termos v1 (rascunho) e aceites das contas demo, para o login não pedir reaceite.
  const terms = Object.fromEntries(
    await Promise.all(
      DEMO_TERMS.map(async (t) => [t.kind, await db.termsVersion.create({ data: { ...t, isDraft: true, publishedAt: new Date(Date.now() - 30 * 86_400_000) } })]),
    ),
  ) as Record<(typeof DEMO_TERMS)[number]["kind"], { id: string }>;
  await db.termsAcceptance.createMany({
    data: [
      ...[admin, supportAdmin, producer, producer2, pendingOwner, staff, customer, friend].flatMap((u) => [
        { userId: u.id, termsVersionId: terms.BUYER.id, context: "SIGNUP" as const },
        { userId: u.id, termsVersionId: terms.PRIVACY.id, context: "SIGNUP" as const },
      ]),
      ...[[producer, sonora], [producer2, coletivo], [pendingOwner, estreia]].map(([u, o]) => ({
        userId: u.id, termsVersionId: terms.ORGANIZER.id, context: "ORGANIZER_SIGNUP" as const, organizationId: o.id,
      })),
    ],
  });
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
  const oFestival = await buy(1, [{ idx: 0, qty: 2 }]);
  const oAxe = await buy(6, [{ idx: 0, qty: 2 }]);
  const oSunset = await buy(4, [{ idx: 0, qty: 1 }]);
  await buy(11, [{ idx: 0, qty: 2 }]);
  const o4 = await buy(5, [{ idx: 0, qty: 1 }]);
  // Um check-in e um reembolso para os relatórios.
  const t1 = await db.issuedTicket.findFirstOrThrow({ where: { orderId: o1.id } });
  await checkInTicket(db, producer, events[0].id, qrPayload(t1));
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

  // ── Conformidade (ADR 0003), por INSERT direto: os serviços são da Fase 3. ──

  // Aceite dos termos no checkout de cada compra da cliente.
  const customerOrders = await db.order.findMany({ where: { userId: customer.id }, select: { id: true, createdAt: true } });
  await db.termsAcceptance.createMany({
    data: customerOrders.map((o) => ({ userId: customer.id, termsVersionId: terms.BUYER.id, context: "CHECKOUT" as const, orderId: o.id, acceptedAt: o.createdAt })),
  });

  // Limite por conta (R4): a cliente já tem os 2 permitidos no Jazz no Mirante.
  await db.event.update({ where: { id: events[11].id }, data: { maxTicketsPerAccount: 2 } });

  // Alteração relevante (R8) com janela de reembolso aberta, num evento com pedido pago:
  // o Pôr do Sol Eletrônico começa 1 h mais tarde.
  const sunset = events[4];
  const shift = (d: Date) => new Date(d.getTime() + 3_600_000);
  await db.event.update({ where: { id: sunset.id }, data: { startsAt: shift(sunset.startsAt), endsAt: shift(sunset.endsAt) } });
  const change = await db.eventChange.create({
    data: {
      eventId: sunset.id,
      organizationId: sunset.organizationId,
      actorUserId: producer.id,
      changedFields: ["startsAt", "endsAt"],
      before: { startsAt: sunset.startsAt.toISOString(), endsAt: sunset.endsAt.toISOString() },
      after: { startsAt: shift(sunset.startsAt).toISOString(), endsAt: shift(sunset.endsAt).toISOString() },
      reason: "Atraso na montagem do palco: o evento começa 1 hora mais tarde (demonstração).",
      relevant: true,
      refundUntil: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  await db.auditLog.create({
    data: { actorUserId: producer.id, organizationId: sunset.organizationId, action: "event.change.buyers_notified", entityType: "EventChange", entityId: change.id, metadata: { orderIds: [oSunset.id] } },
  });

  // Transferência aceita (R6): um ingresso Inteira da Noite de Samba passa para a amiga.
  const samba = await db.issuedTicket.findFirstOrThrow({
    where: { orderId: o1.id, checkedInAt: null, status: "VALID", ticketType: { kind: "GENERAL" } },
    orderBy: { sequence: "asc" },
  });
  await db.$transaction(async (tx) => {
    const t = await tx.ticketTransfer.create({
      data: {
        ticketId: samba.id,
        eventId: samba.eventId,
        fromUserId: customer.id,
        fromHolderName: customer.name,
        fromHolderEmail: customer.email,
        toEmail: friend.email,
        tokenHash: sha256(randomToken(32)),
        createdById: customer.id,
        createdAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() + 5 * 86_400_000),
      },
    });
    await tx.ticketTransfer.update({
      where: { id: t.id },
      data: {
        status: "ACCEPTED",
        toUserId: friend.id,
        toHolderName: friend.name,
        previousTokenHash: sha256(samba.validationToken),
        decidedAt: new Date(Date.now() - 86_400_000),
        decidedById: friend.id,
      },
    });
    // O QR antigo deixa de valer; o titular passa a ser a amiga (o comprador continua userId).
    await tx.issuedTicket.update({
      where: { id: samba.id },
      data: { holderUserId: friend.id, holderName: friend.name, holderEmail: friend.email, validationToken: randomToken(32) },
    });
    await tx.auditLog.create({
      data: { actorUserId: friend.id, organizationId: sonora.id, action: "ticket.transfer.accepted", entityType: "TicketTransfer", entityId: t.id, metadata: { ticketId: samba.id, fromUserId: customer.id } },
    });
  });

  // Transferência pendente: um ingresso do Axé para quem ainda não tem conta.
  const axe = await db.issuedTicket.findFirstOrThrow({ where: { orderId: oAxe.id }, orderBy: { sequence: "asc" } });
  await db.ticketTransfer.create({
    data: {
      ticketId: axe.id,
      eventId: axe.eventId,
      fromUserId: customer.id,
      fromHolderName: customer.name,
      fromHolderEmail: customer.email,
      toEmail: "convidado@demo.eventobrasil.test",
      toHolderName: "Gabriel Convidado (demo)",
      tokenHash: sha256(randomToken(32)),
      createdById: customer.id,
      expiresAt: new Date(Date.now() + 3 * 86_400_000),
    },
  });

  // Pedido de cancelamento aberto (R5) na compra do Festival Litoral Sonoro.
  const festival = events[1];
  await db.cancellationRequest.create({
    data: {
      protocol: `CAN-${zonedDateKey(new Date(), "America/Sao_Paulo").replaceAll("-", "")}-SEED01`,
      orderId: oFestival.id,
      eventId: festival.id,
      organizationId: festival.organizationId,
      requestedById: customer.id,
      reason: "Não poderei comparecer na data do festival (demonstração).",
      autoEligibleAtRequest: true,
    },
  });

  console.log("Seed concluído. Senha de todas as contas demo:", DEMO_PASSWORD);
  console.log("Contas: admin@, produtora@, coletivo@, novo.organizador@, portaria@, cliente@, amiga@ (domínio demo.eventobrasil.test)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
