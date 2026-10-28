-- Volume sintético para medir planos de consulta (Fase 4). SOMENTE em banco
-- descartável recém-migrado: insere direto nas tabelas, sem passar pelos
-- serviços, e respeita os CHECKs e gatilhos das migrações.
-- Uso: npx tsx --conditions=react-server scripts/query-plans/run.mts --load
--
-- Volumes (aprox.): 60 mil usuários, 400 cidades, 800 organizações, 20 mil
-- eventos, 60 mil tipos de ingresso, 400 mil pedidos, ~600 mil ingressos,
-- ~30 mil transferências, 3,3 mil alterações, 12 mil pedidos de cancelamento,
-- 1 milhão de registros de auditoria. Distribuições enviesadas (cidade, evento
-- e comprador "populares") para que existam casos típicos e casos pesados.
SELECT setseed(0.42);

INSERT INTO "User" (id, email, name, "passwordHash", "platformRole", "updatedAt")
SELECT 'u' || n, 'user' || n || '@perf.test', 'Pessoa ' || n, 'x', CASE WHEN n = 0 THEN 'ADMIN' ELSE 'USER' END::"PlatformRole", now()
FROM generate_series(0, 60000) n;

INSERT INTO "City" (id, slug, name, state, timezone, "isFeatured")
SELECT 'c' || n, 'cidade-' || n, 'Cidade ' || n, (ARRAY['SP','RJ','MG','BA','PR','RS','PE','CE','SC','GO'])[1 + n % 10], 'America/Sao_Paulo', n <= 27
FROM generate_series(1, 400) n;

INSERT INTO "EventCategory" (id, slug, name, "sortOrder")
SELECT 'cat' || n, 'categoria-' || n, 'Categoria ' || n, n FROM generate_series(1, 12) n;

INSERT INTO "Organization" (id, slug, name, "legalType", "contactEmail", status, "updatedAt")
SELECT 'o' || n, 'org-' || n, 'Produtora ' || n, 'COMPANY', 'org' || n || '@perf.test',
  (CASE WHEN n % 10 = 0 THEN 'PENDING_REVIEW' WHEN n % 37 = 0 THEN 'SUSPENDED' ELSE 'APPROVED' END)::"OrganizationStatus", now()
FROM generate_series(1, 800) n;

INSERT INTO "OrganizationMember" (id, "organizationId", "userId", role)
SELECT 'om' || n, 'o' || n, 'u' || (59000 + n), 'OWNER' FROM generate_series(1, 800) n;

-- Cidade enviesada: a c1 concentra ~14% dos locais (capital grande).
INSERT INTO "Venue" (id, "cityId", name, slug, "updatedAt")
SELECT 'v' || n, 'c' || (1 + floor(400 * random() ^ 3))::int, 'Local ' || n, 'local-' || n, now()
FROM generate_series(1, 2000) n;

CREATE TEMP TABLE gen_event AS
SELECT n,
  date_trunc('hour', now() - interval '730 days' + random() * interval '1095 days') AS starts,
  CASE WHEN n % 10 = 0 THEN NULL ELSE 'v' || (1 + floor(2000 * random()))::int END AS venue,
  random() AS r
FROM generate_series(1, 20000) n;

INSERT INTO "Event" (id, "organizationId", slug, title, description, summary, "categoryId", "locationType", "venueId", "cityId",
  "startsAt", "endsAt", timezone, "salesStartAt", "salesEndAt", capacity, status, "isFeatured", "refundPolicy", "updatedAt")
SELECT 'e' || g.n, 'o' || (1 + g.n % 800), 'evento-' || g.n, 'Evento ' || g.n || ' ' || (ARRAY['Samba','Rock','Jazz','Forró','Teatro','Stand-up'])[1 + g.n % 6],
  'Descrição do evento ' || g.n, 'Resumo ' || g.n, 'cat' || (1 + g.n % 12),
  (CASE WHEN g.venue IS NULL THEN 'ONLINE' ELSE 'VENUE' END)::"LocationType", g.venue, v."cityId",
  g.starts, g.starts + interval '4 hours', 'America/Sao_Paulo', g.starts - interval '60 days', g.starts, 500,
  (CASE
    WHEN g.starts < now() THEN CASE WHEN g.r < 0.85 THEN 'COMPLETED' WHEN g.r < 0.90 THEN 'CANCELLED' ELSE 'ARCHIVED' END
    ELSE CASE WHEN g.r < 0.75 THEN 'PUBLISHED' WHEN g.r < 0.90 THEN 'DRAFT' WHEN g.r < 0.95 THEN 'PENDING_REVIEW' ELSE 'CANCELLED' END
  END)::"EventStatus",
  g.r > 0.98, 'Política padrão', now()
FROM gen_event g LEFT JOIN "Venue" v ON v.id = g.venue;

INSERT INTO "TicketType" (id, "eventId", name, kind, "priceCents", "quantityTotal", "sortOrder", "updatedAt")
SELECT 'tt' || n || '_' || k, 'e' || n, (ARRAY['Inteira','VIP','Meia'])[k], (ARRAY['GENERAL','VIP','HALF_PRICE'])[k]::"TicketKind",
  (ARRAY[5000, 15000, 2500])[k], 1000, k, now()
FROM generate_series(1, 20000) n, generate_series(1, 3) k;

INSERT INTO "EventImage" (id, "eventId", url, alt, "sortOrder")
SELECT 'img' || n || '_' || k, 'e' || n, '/placeholder/' || n || '-' || k || '.jpg', 'Foto ' || k, k
FROM generate_series(1, 20000) n, generate_series(1, 2) k;

INSERT INTO "CommissionRule" (id, scope, "percentBps", "policyVersion", "activeFrom")
VALUES ('cr0', 'PLATFORM', 1000, 'perf-platform-v1', now() - interval '3 years');
INSERT INTO "CommissionRule" (id, scope, "organizationId", "percentBps", "policyVersion", "activeFrom")
SELECT 'cr' || n, 'ORGANIZATION', 'o' || n, 800, 'perf-org-' || n, now() - interval '2 years' FROM generate_series(1, 50) n;

-- Pedidos: comprador enviesado (u1 tem ~1,8 mil pedidos; a mediana, poucos) e
-- eventos populares (e1… concentram vendas).
CREATE TEMP TABLE gen_order AS
SELECT n, 'u' || (1 + floor(60000 * random() ^ 2))::int AS uid, (1 + floor(20000 * random() ^ 1.5))::int AS ev,
  1 + floor(random() * 3)::int AS k, 1 + floor(random() * 3)::int AS q, random() AS r, random() AS r2
FROM generate_series(1, 400000) n;

INSERT INTO "Order" (id, "publicCode", "userId", "eventId", "organizationId", status, "subtotalCents", "serviceFeeCents", "totalCents",
  "commissionCents", "feePolicyVersion", "buyerName", "buyerEmail", "idempotencyKey", "isSimulated", "expiresAt", "paidAt", "createdAt", "updatedAt")
SELECT 'ord' || g.n, 'P' || lpad(g.n::text, 8, '0'), g.uid, e.id, e."organizationId",
  (CASE WHEN g.r < 0.75 THEN 'PAID' WHEN g.r < 0.90 THEN 'EXPIRED' WHEN g.r < 0.93 THEN 'CANCELLED' WHEN g.r < 0.97 THEN 'REFUNDED' ELSE 'PENDING_PAYMENT' END)::"OrderStatus",
  g.q * (ARRAY[5000, 15000, 2500])[g.k], 0, g.q * (ARRAY[5000, 15000, 2500])[g.k], 0, 'perf-platform-v1',
  'Pessoa', g.uid || '@perf.test', 'k' || g.n, true,
  e."startsAt" - g.r2 * interval '60 days' + interval '15 minutes',
  CASE WHEN g.r < 0.75 OR (g.r >= 0.93 AND g.r < 0.97) THEN e."startsAt" - g.r2 * interval '60 days' + interval '2 minutes' END,
  e."startsAt" - g.r2 * interval '60 days', now()
FROM gen_order g JOIN "Event" e ON e.id = 'e' || g.ev;

INSERT INTO "OrderItem" (id, "orderId", "ticketTypeId", "ticketTypeName", kind, "unitPriceCents", "commissionPerUnitCents", "serviceFeePerUnitCents", quantity, "listUnitPriceCents")
SELECT 'oi' || g.n, 'ord' || g.n, 'tt' || g.ev || '_' || g.k, (ARRAY['Inteira','VIP','Meia'])[g.k], (ARRAY['GENERAL','VIP','HALF_PRICE'])[g.k]::"TicketKind",
  (ARRAY[5000, 15000, 2500])[g.k], 0, 0, g.q, (ARRAY[5000, 15000, 2500])[g.k]
FROM gen_order g;

-- holderUserId fica a cargo do gatilho IssuedTicket_default_holder (= comprador).
INSERT INTO "IssuedTicket" (id, code, "orderId", "orderItemId", "eventId", "ticketTypeId", "userId", sequence, "validationToken", status, "checkedInAt", "revokedAt", "issuedAt")
SELECT 'it' || g.n || '_' || s, 'T' || g.n || 'S' || s, o.id, 'oi' || g.n, o."eventId", 'tt' || g.ev || '_' || g.k, o."userId", s, md5('tok' || g.n || '_' || s),
  (CASE WHEN o.status = 'REFUNDED' THEN 'REVOKED' WHEN e."startsAt" < now() AND g.r2 < 0.8 THEN 'CHECKED_IN' ELSE 'VALID' END)::"TicketStatus",
  CASE WHEN o.status <> 'REFUNDED' AND e."startsAt" < now() AND g.r2 < 0.8 THEN e."startsAt" END,
  CASE WHEN o.status = 'REFUNDED' THEN o."paidAt" + interval '1 day' END,
  o."paidAt"
FROM gen_order g JOIN "Order" o ON o.id = 'ord' || g.n JOIN "Event" e ON e.id = o."eventId", generate_series(1, g.q) s
WHERE o.status IN ('PAID', 'REFUNDED');

-- Transferências: ~5% dos ingressos; aceitas mudam o titular.
CREATE TEMP TABLE gen_transfer AS
SELECT row_number() OVER (ORDER BY t.id) AS n, t.id AS ticket, t."eventId", t."holderUserId" AS from_uid, t."issuedAt", random() AS r,
  'u' || (1 + floor(60000 * random()))::int AS to_uid
FROM "IssuedTicket" t WHERE abs(hashtext(t.id)) % 20 = 0;
UPDATE gen_transfer SET to_uid = 'u60000' WHERE to_uid = from_uid;

INSERT INTO "TicketTransfer" (id, "ticketId", "eventId", "initiatedBy", "fromUserId", "fromHolderName", "fromHolderEmail", "toUserId", "toEmail", "toHolderName",
  status, "tokenHash", "previousTokenHash", "createdById", "createdAt", "expiresAt", "decidedAt", "decidedById")
SELECT 'tr' || g.n, g.ticket, g."eventId", 'HOLDER', g.from_uid, 'Pessoa', g.from_uid || '@perf.test',
  CASE WHEN g.r < 0.6 OR g.r >= 0.9 THEN g.to_uid END,
  CASE WHEN g.r >= 0.6 AND g.r < 0.75 AND g.n % 2 = 0 THEN 'convidado' || g.n || '@perf.test' ELSE 'user' || substr(g.to_uid, 2) || '@perf.test' END,
  CASE WHEN g.r < 0.6 THEN 'Pessoa' END,
  (CASE WHEN g.r < 0.6 THEN 'ACCEPTED' WHEN g.r < 0.75 THEN 'PENDING' WHEN g.r < 0.85 THEN 'EXPIRED' ELSE 'CANCELLED' END)::"TicketTransferStatus",
  md5('h' || g.n) || md5('h2' || g.n),
  CASE WHEN g.r < 0.6 THEN md5('p' || g.n) || md5('p2' || g.n) END,
  g.from_uid,
  CASE WHEN g.r >= 0.6 AND g.r < 0.75 THEN now() - random() * interval '5 days' ELSE g."issuedAt" + interval '1 day' END,
  CASE WHEN g.r >= 0.6 AND g.r < 0.75 THEN now() + interval '2 days' ELSE g."issuedAt" + interval '8 days' END,
  CASE WHEN g.r < 0.6 OR g.r >= 0.75 THEN g."issuedAt" + interval '2 days' END,
  CASE WHEN g.r < 0.6 THEN g.to_uid WHEN g.r >= 0.85 THEN g.from_uid END
FROM gen_transfer g;

UPDATE "IssuedTicket" t SET "holderUserId" = tr."toUserId", "holderName" = tr."toHolderName", "holderEmail" = tr."toEmail"
FROM "TicketTransfer" tr WHERE tr."ticketId" = t.id AND tr.status = 'ACCEPTED';

-- Alterações relevantes ao longo de 2 anos (~1% com janela aberta hoje) e prorrogações.
INSERT INTO "EventChange" (id, "eventId", "organizationId", "changedFields", before, after, reason, relevant, "refundUntil", "createdAt")
SELECT 'ec' || n, e.id, e."organizationId", ARRAY['startsAt','endsAt'], '{}'::jsonb, '{}'::jsonb, 'Mudança de horário', n % 10 <> 0, c.at + interval '7 days', c.at
FROM generate_series(1, 3000) n
CROSS JOIN LATERAL (SELECT now() - random() * interval '730 days' AS at, 1 + floor(20000 * random())::int + 0 * n AS ev) c
JOIN "Event" e ON e.id = 'e' || c.ev;
INSERT INTO "EventChange" (id, "eventId", "organizationId", "changedFields", before, after, reason, "refundUntil", "extendsChangeId", "createdAt")
SELECT 'ecx' || n, ec."eventId", ec."organizationId", ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, 'Prorrogação', ec."refundUntil" + interval '7 days', ec.id, ec."createdAt" + interval '1 day'
FROM generate_series(1, 300) n JOIN "EventChange" ec ON ec.id = 'ec' || (n * 10 - 3);

-- Pedidos de cancelamento: ~8% abertos (recentes), o resto decidido.
CREATE TEMP TABLE gen_cancel AS
SELECT row_number() OVER (ORDER BY o.id) AS n, o.id, o."eventId", o."organizationId", o."userId", o."paidAt", random() AS r
FROM "Order" o WHERE o.status = 'PAID' AND abs(hashtext(o.id)) % 25 = 0 LIMIT 12000;

INSERT INTO "CancellationRequest" (id, protocol, "orderId", "eventId", "organizationId", "requestedById", reason, status, "respondBy",
  "decisionNote", "decidedById", "decidedAt", "createdAt", "updatedAt")
SELECT 'cq' || g.n,
  'CAN-' || to_char(c.at, 'YYYYMMDD') || '-' || (
    SELECT string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + ((g.n >> (5 * i)) & 31)::int, 1), '' ORDER BY i DESC) FROM generate_series(0, 5) i),
  g.id, g."eventId", g."organizationId", g."userId", 'Desisti da compra',
  (CASE WHEN g.r < 0.08 THEN 'OPEN' WHEN g.r < 0.68 THEN 'APPROVED' WHEN g.r < 0.88 THEN 'REJECTED' ELSE 'WITHDRAWN' END)::"CancellationRequestStatus",
  CASE WHEN g.n % 2 = 0 THEN c.at + interval '10 days' END,
  CASE WHEN g.r >= 0.68 AND g.r < 0.88 THEN 'Fora do prazo' END,
  CASE WHEN g.r < 0.08 THEN NULL WHEN g.r < 0.88 THEN 'u0' ELSE g."userId" END,
  CASE WHEN g.r >= 0.08 THEN c.at + interval '2 days' END,
  c.at, now()
FROM gen_cancel g
CROSS JOIN LATERAL (SELECT CASE WHEN g.r < 0.08 THEN now() - random() * interval '15 days' ELSE g."paidAt" + interval '1 day' END AS at OFFSET 0) c;

INSERT INTO "TermsVersion" (id, kind, version, "textHash", "publishedAt")
SELECT 'tv' || k, k::"TermsKind", 'v1', md5(k) || md5(k || 'x'), now() - interval '400 days' FROM unnest(ARRAY['BUYER','PRIVACY','ORGANIZER']) k;
INSERT INTO "TermsAcceptance" (id, "userId", "termsVersionId", context, "acceptedAt")
SELECT 'ta' || n || k, 'u' || n, 'tv' || k, 'SIGNUP', now() - interval '300 days' FROM generate_series(0, 60000) n, unnest(ARRAY['BUYER','PRIVACY']) k;

-- Auditoria: 1 milhão de linhas em 2 anos; ações frequentes primeiro (enviesado).
INSERT INTO "AuditLog" (id, "actorUserId", "organizationId", action, "entityType", "entityId", "createdAt")
SELECT 'al' || n, 'u' || (1 + floor(60000 * random()))::int, CASE WHEN n % 2 = 0 THEN 'o' || (1 + n % 800) END,
  a.action, split_part(a.action, '.', 1), 'x' || n, now() - random() * interval '730 days'
FROM generate_series(1, 1000000) n
CROSS JOIN LATERAL (SELECT (ARRAY[
  'payment.started', 'event.wizard_progress', 'event.updated', 'user.registered', 'refund.requested', 'refund.succeeded',
  'member.joined', 'event.created', 'ticket.transfer.requested', 'ticket.transfer.accepted', 'cancellation.requested',
  'coupon.created', 'refund.attempt_failed', 'terms.accepted', 'ticket.transfer.cancelled', 'cancellation.withdrawn',
  'event.relevant_change', 'event.change_notified', 'attendees.exported', 'event.change_window_extended'
])[1 + floor(20 * random() ^ 2)::int + 0 * n] AS action) a;

-- VACUUM ANALYZE roda em seguida, fora desta transação (run.mts).
