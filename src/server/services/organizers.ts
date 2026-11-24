import "server-only";
import { cancelQueuedEmails, enqueueEmail } from "../email/outbox";
import { transactionalEmail } from "../email/templates";
import { env } from "../env";
import { inviteSchema, organizerApplicationSchema, type OrganizerApplicationInput } from "@/features/schemas";
import { onlyDigits } from "@/lib/br";
import { ORGANIZER_REVIEW_AREAS, type OrganizerReviewArea } from "@/lib/labels";
import { slugify } from "@/lib/utils";
import type { OrgRole } from "@/generated/prisma/client";
import type { Db, Tx } from "../db";
import { audit } from "../audit";
import { assertActive, assertOrgPermission, type Actor, assertAdminPermission } from "../auth/permissions";
import { encryptPII, hashToken, randomToken } from "../crypto";
import { verifyPassword } from "../auth/password";
import { AppError, forbidden, invalidState, notFound } from "../errors";
import { imageDimensions, MAX_IMAGE_BYTES, storeEventImage } from "../storage";
import { resolveCityFromIbge } from "./cities";

async function uniqueOrgSlug(client: Db | Tx, name: string): Promise<string> {
  const base = slugify(name) || "organizador";
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await client.organization.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  return `${base}-${randomToken(4).toLowerCase()}`;
}

/** Cidade-sede do cadastro: município do IBGE (cria a cidade se preciso) ou cidade antiga já cadastrada. */
async function applicationCityId(tx: Tx, input: ReturnType<typeof organizerApplicationSchema.parse>) {
  if (input.cityIbgeCode) return (await resolveCityFromIbge(tx, input.cityIbgeCode, input.cityUf)).id;
  return input.cityId || null;
}

function verificationData(input: ReturnType<typeof organizerApplicationSchema.parse>, actorId: string) {
  const digits = onlyDigits(input.document);
  return {
    legalType: input.legalType,
    legalName: input.legalName,
    documentType: input.legalType === "INDIVIDUAL" ? ("CPF" as const) : ("CNPJ" as const),
    documentEncrypted: encryptPII(digits),
    documentLast4: digits.slice(-4),
    submittedById: actorId,
  };
}

/** Limite de cadastros aguardando análise por usuário (evita spam na fila do admin). */
export const MAX_PENDING_APPLICATIONS = 3;

async function assertPendingCapacity(tx: Tx, userIds: string[]) {
  for (const id of [...new Set(userIds)].sort()) {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
    const pending = await tx.organizationMember.count({ where: { userId: id, role: "OWNER", organization: { status: "PENDING_REVIEW" } } });
    if (pending >= MAX_PENDING_APPLICATIONS) throw new AppError("LIMIT_EXCEEDED", "O limite de cadastros aguardando análise foi atingido. Aguarde a resposta antes de enviar outro cadastro.");
  }
}

/**
 * Cria uma NOVA organização e envia para análise. O usuário vira OWNER.
 * Serve tanto para o primeiro cadastro quanto para organizações adicionais.
 */
export async function submitOrganizerApplication(db: Db, actor: Actor, raw: OrganizerApplicationInput) {
  assertActive(actor);
  const input = organizerApplicationSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await assertPendingCapacity(tx, [actor.id]);
    const pending = await tx.organizationMember.count({
      where: { userId: actor.id, role: "OWNER", organization: { status: "PENDING_REVIEW" } },
    });
    if (pending >= MAX_PENDING_APPLICATIONS) {
      throw new AppError("LIMIT_EXCEEDED", `Você já tem ${pending} cadastros aguardando análise. Aguarde a resposta antes de criar outra organização.`);
    }
    const org = await tx.organization.create({
      data: {
        slug: await uniqueOrgSlug(tx, input.name),
        name: input.name,
        legalType: input.legalType,
        description: input.description,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone ? onlyDigits(input.contactPhone) : null,
        cityId: await applicationCityId(tx, input),
        websiteUrl: input.websiteUrl || null,
        instagramHandle: input.instagramHandle?.replace(/^@/, "") || null,
        status: "PENDING_REVIEW",
        members: { create: { userId: actor.id, role: "OWNER" } },
        verifications: { create: verificationData(input, actor.id) },
      },
    });
    await audit(tx, { actorUserId: actor.id, organizationId: org.id, action: "organization.submitted", entityType: "Organization", entityId: org.id });
    return org;
  });
}

/** Organizações das quais o usuário é membro (somente as dele), com o papel em cada uma. */
export async function listMyOrganizations(db: Db, actor: Actor) {
  assertActive(actor);
  const memberships = await db.organizationMember.findMany({
    where: { userId: actor.id },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          statusReason: true,
          paymentAccountStatus: true,
          createdAt: true,
          city: { select: { name: true, state: true } },
          _count: { select: { events: true, members: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => ({ role: m.role, joinedAt: m.createdAt, ...m.organization }));
}

/**
 * Reenvio após rejeição (ou complemento de cadastro em rascunho). Travas na ordem
 * User → Organization (a mesma da exclusão de conta): os OWNERs (limite de cadastros
 * em análise) e depois a organização, que serializa o reenvio com as decisões do
 * admin (`lockOrganization`) e com as mudanças de equipe (`lockOrganizationTeam`).
 * Permissão, status e OWNERs são conferidos de novo sob a trava.
 */
export async function resubmitOrganizerApplication(db: Db, actor: Actor, organizationId: string, raw: OrganizerApplicationInput) {
  await assertOrgPermission(db, actor, organizationId, "org:manage");
  const input = organizerApplicationSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const ownerIds = async () =>
      (await tx.organizationMember.findMany({ where: { organizationId, role: "OWNER" }, select: { userId: true } })).map((o) => o.userId).sort();
    const owners = await ownerIds();
    await assertPendingCapacity(tx, owners);
    const org = await lockOrganization(tx, organizationId);
    if (!org) throw notFound();
    await assertOrgPermission(tx, actor, organizationId, "org:manage");
    // A equipe mudou entre a leitura e a trava: um OWNER novo não teve o limite conferido.
    if ((await ownerIds()).join() !== owners.join()) throw new AppError("CONFLICT", "A equipe da organização mudou agora há pouco. Tente enviar de novo.");
    if (org.status !== "REJECTED" && org.status !== "DRAFT") throw invalidState("Esta organização não está aguardando reenvio.");
    const updated = await tx.organization.update({
      where: { id: organizationId },
      data: {
        name: input.name,
        legalType: input.legalType,
        description: input.description,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone ? onlyDigits(input.contactPhone) : null,
        cityId: await applicationCityId(tx, input),
        // Mesmas regras do cadastro novo: vazio apaga o valor anterior.
        websiteUrl: input.websiteUrl || null,
        instagramHandle: input.instagramHandle?.replace(/^@/, "") || null,
        status: "PENDING_REVIEW",
        statusReason: null,
        statusReasonArea: null,
        verifications: { create: verificationData(input, actor.id) },
      },
    });
    await audit(tx, { actorUserId: actor.id, organizationId, action: "organization.resubmitted", entityType: "Organization", entityId: organizationId });
    return updated;
  });
}

/**
 * Trava a linha da organização até o fim da transação. Decisões do admin
 * (aprovar, rejeitar, suspender, reativar) leem o status DEPOIS da trava, então
 * duas decisões simultâneas são serializadas e a segunda vê o resultado da primeira.
 */
async function lockOrganization(tx: Tx, organizationId: string) {
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
  return tx.organization.findUnique({ where: { id: organizationId } });
}

/**
 * Aprova ou recusa um cadastro em análise. Na recusa, `area` diz que parte do
 * cadastro corrigir (o reenvio abre nesse passo); sem ela, o reenvio usa o texto.
 */
export async function reviewOrganization(
  db: Db,
  admin: Actor,
  organizationId: string,
  decision: "APPROVE" | "REJECT",
  note?: string,
  area?: OrganizerReviewArea,
) {
  assertAdminPermission(admin, "organizers:review");
  if (decision === "REJECT" && !note?.trim()) throw new AppError("VALIDATION", "Informe o motivo da rejeição.");
  if (area !== undefined && !ORGANIZER_REVIEW_AREAS.includes(area)) throw new AppError("VALIDATION", "Área da recusa inválida.");
  const reasonArea = decision === "REJECT" ? (area ?? null) : null;
  return db.$transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) throw notFound();
    if (org.status !== "PENDING_REVIEW") throw invalidState("A organização não está em análise.");
    const newStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const latest = await tx.organizerVerification.findFirst({ where: { organizationId }, orderBy: { createdAt: "desc" } });
    if (latest) {
      await tx.organizerVerification.update({
        where: { id: latest.id },
        data: { status: newStatus, reviewedById: admin.id, reviewedAt: new Date(), decisionNote: note ?? null },
      });
    }
    const updated = await tx.organization.update({
      where: { id: organizationId },
      data: { status: newStatus, statusReason: note ?? null, statusReasonArea: reasonArea },
    });
    await audit(tx, {
      actorUserId: admin.id,
      organizationId,
      action: decision === "APPROVE" ? "organization.approved" : "organization.rejected",
      entityType: "Organization",
      entityId: organizationId,
      metadata: { previousStatus: org.status, newStatus, note: note ?? null, area: reasonArea },
    });
    return updated;
  });
}

export async function setOrganizationSuspended(db: Db, admin: Actor, organizationId: string, suspended: boolean, reason?: string) {
  assertAdminPermission(admin, "organizers:review");
  return db.$transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) throw notFound();
    if (suspended === (org.status === "SUSPENDED")) return org;
    if (!suspended && org.status !== "SUSPENDED") throw invalidState("Organização não está suspensa.");
    const newStatus = suspended ? "SUSPENDED" : "APPROVED";
    const updated = await tx.organization.update({
      where: { id: organizationId },
      data: { status: newStatus, statusReason: suspended ? (reason ?? "Suspensa pela plataforma") : null, statusReasonArea: null },
    });
    await audit(tx, {
      actorUserId: admin.id,
      organizationId,
      action: suspended ? "organization.suspended" : "organization.reinstated",
      entityType: "Organization",
      entityId: organizationId,
      metadata: { previousStatus: org.status, newStatus, reason: reason ?? null },
    });
    return updated;
  });
}

/** Liga/desliga a publicação sem revisão. Alteração e auditoria (com o valor anterior) juntas, sob trava. */
export async function setAutoPublish(db: Db, admin: Actor, organizationId: string, value: boolean) {
  assertAdminPermission(admin, "organizers:review");
  await db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ autoPublishEvents: boolean }[]>`SELECT "autoPublishEvents" FROM "Organization" WHERE id = ${organizationId} FOR NO KEY UPDATE`;
    if (!row) throw notFound("Organização não encontrada.");
    if (row.autoPublishEvents === value) return;
    await tx.organization.update({ where: { id: organizationId }, data: { autoPublishEvents: value } });
    await audit(tx, {
      actorUserId: admin.id,
      organizationId,
      action: "organization.auto_publish",
      entityType: "Organization",
      entityId: organizationId,
      metadata: { value, previous: row.autoPublishEvents },
    });
  });
}

/**
 * Conexão da conta de recebimento. No provedor simulado, marca SIMULATED.
 * Para o provedor real, o fluxo OAuth deve ser implementado após verificação.
 */
export async function connectPaymentAccount(db: Db, actor: Actor, organizationId: string, provider: { id: string; isSimulated: boolean }) {
  await assertOrgPermission(db, actor, organizationId, "org:manage");
  if (!provider.isSimulated) {
    throw new AppError("PROVIDER_ERROR", "Conexão com o provedor real ainda não disponível (integração pendente de verificação).");
  }
  const org = await db.organization.update({
    where: { id: organizationId },
    data: { paymentProvider: provider.id, paymentAccountStatus: "SIMULATED", paymentAccountExternalId: `sim-seller-${organizationId}` },
  });
  await audit(db, { actorUserId: actor.id, organizationId, action: "organization.payment_connected_simulated", entityType: "Organization", entityId: organizationId });
  return org;
}

export async function updateOrganizationProfile(
  db: Db,
  actor: Actor,
  organizationId: string,
  data: { description?: string; websiteUrl?: string | null; instagramHandle?: string | null; contactPhone?: string | null },
) {
  await assertOrgPermission(db, actor, organizationId, "org:manage");
  return db.organization.update({ where: { id: organizationId }, data });
}

// ── Logo e capa do perfil público ──

export type OrganizationImageKind = "logo" | "cover";

/** Tamanho mínimo, em pixels: logo quadrado-ish legível e capa larga o bastante para o topo do perfil. */
export const ORG_IMAGE_RULES: Record<OrganizationImageKind, { minWidth: number; minHeight: number; label: string }> = {
  logo: { minWidth: 200, minHeight: 200, label: "O logo" },
  cover: { minWidth: 1200, minHeight: 300, label: "A capa" },
};

/**
 * Troca (arquivo) ou remove (null) o logo ou a capa. O upload acontece aqui, com a
 * validação do armazenamento (tipo pelo conteúdo, até 5 MB) e tamanho mínimo, então
 * o banco só recebe URLs geradas pelo próprio armazenamento. Fica na pasta de imagens
 * da organização (a mesma das capas de evento).
 */
export async function setOrganizationImage(db: Db, actor: Actor, organizationId: string, kind: OrganizationImageKind, file: File | null) {
  await assertOrgPermission(db, actor, organizationId, "org:manage");
  const field = kind === "logo" ? "logoUrl" : "coverUrl";
  let url: string | null = null;
  if (file) {
    const rule = ORG_IMAGE_RULES[kind];
    if (file.size > MAX_IMAGE_BYTES) throw new AppError("VALIDATION", "Imagem muito grande (máximo 5 MB).");
    const dims = imageDimensions(new Uint8Array(await file.arrayBuffer()));
    if (!dims) throw new AppError("VALIDATION", "Envie uma imagem JPG, PNG ou WebP válida.");
    if (dims.width < rule.minWidth || dims.height < rule.minHeight)
      throw new AppError("VALIDATION", `${rule.label} precisa ter pelo menos ${rule.minWidth} × ${rule.minHeight} pixels (a imagem enviada tem ${dims.width} × ${dims.height}).`);
    url = (await storeEventImage(organizationId, file)).url;
  }
  const org = await db.organization.update({ where: { id: organizationId }, data: { [field]: url }, select: { id: true, logoUrl: true, coverUrl: true } });
  await audit(db, {
    actorUserId: actor.id,
    organizationId,
    action: `organization.${kind}_${url ? "updated" : "removed"}`,
    entityType: "Organization",
    entityId: organizationId,
    metadata: { url },
  });
  return org;
}

// ── Equipe ──

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Convites ainda utilizáveis (não aceitos, não revogados, não vencidos) por organização. */
export const MAX_PENDING_INVITATIONS = 30;

/** Hierarquia de papéis para impedir escalada de privilégio (EVENT_MANAGER e FINANCE no mesmo nível). */
const ROLE_RANK: Record<OrgRole, number> = { OWNER: 4, ADMIN: 3, EVENT_MANAGER: 2, FINANCE: 2, CHECKIN_STAFF: 1 };

/** Quem gerencia a equipe não concede nem altera um papel acima do próprio; só OWNER mexe em OWNER. */
function assertCanManageRole(actorRole: OrgRole, role: OrgRole) {
  if (ROLE_RANK[role] > ROLE_RANK[actorRole]) throw forbidden("Você não pode conceder ou alterar um papel acima do seu.");
}

/** Papéis que `actorRole` pode conceder (a interface usa para montar as opções; o servidor revalida). */
export function assignableRoles(actorRole: OrgRole): OrgRole[] {
  return (Object.keys(ROLE_RANK) as OrgRole[]).filter((r) => ROLE_RANK[r] <= ROLE_RANK[actorRole]);
}

/**
 * Serializa as mudanças de equipe de uma organização: sem isso, dois OWNERs
 * rebaixando um ao outro ao mesmo tempo deixariam a organização sem responsável.
 * FOR NO KEY UPDATE não bloqueia inserções que só referenciam a organização.
 */
async function lockOrganizationTeam(tx: Tx, organizationId: string) {
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR NO KEY UPDATE`;
}

async function assertNotLastOwner(tx: Tx, organizationId: string) {
  const owners = await tx.organizationMember.count({ where: { organizationId, role: "OWNER" } });
  if (owners <= 1) throw new AppError("VALIDATION", "A organização precisa de ao menos um responsável (OWNER).");
}

const invitationInvalid = () => new AppError("NOT_FOUND", "Convite inválido ou expirado.");

/** Convite ainda utilizável: nem aceito, nem revogado/recusado, nem vencido. */
const usableInvitation = () => ({ acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } });

export async function inviteMember(db: Db, actor: Actor, organizationId: string, raw: unknown) {
  const input = inviteSchema.parse(raw);
  const token = randomToken(32);
  return db.$transaction(async (tx) => {
    const { role: actorRole } = await assertOrgPermission(tx, actor, organizationId, "members:manage");
    assertCanManageRole(actorRole, input.role);
    if (input.eventId) {
      const ev = await tx.event.findFirst({ where: { id: input.eventId, organizationId }, select: { id: true } });
      if (!ev) throw notFound("Evento não encontrado nesta organização.");
    }
    // Limites contra abuso e engano: um convite ativo por e-mail e no máximo
    // MAX_PENDING_INVITATIONS ativos (vencidos não contam). A trava serializa convites simultâneos.
    await lockOrganizationTeam(tx, organizationId);
    if (await tx.organizationInvitation.findFirst({ where: { organizationId, email: input.email, ...usableInvitation() }, select: { id: true } }))
      throw new AppError("CONFLICT", "Já existe um convite pendente para este e-mail. Reenvie ou revogue o convite atual.");
    if ((await tx.organizationInvitation.count({ where: { organizationId, ...usableInvitation() } })) >= MAX_PENDING_INVITATIONS)
      throw new AppError("LIMIT_EXCEEDED", `A organização já tem ${MAX_PENDING_INVITATIONS} convites pendentes. Revogue convites antigos antes de enviar novos.`);
    const invitation = await tx.organizationInvitation.create({
      data: {
        organizationId,
        email: input.email,
        role: input.role,
        eventId: input.eventId ?? null,
        tokenHash: hashToken(token),
        invitedById: actor.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "member.invited",
      entityType: "OrganizationInvitation",
      entityId: invitation.id,
      metadata: { role: input.role, eventId: input.eventId ?? null },
    });
    const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } });
    await enqueueEmail(tx, { dedupeKey: "invitation:" + invitation.id, template: "ORGANIZER_INVITATION", recipient: invitation.email, expiresAt: invitation.expiresAt, message: transactionalEmail("invitation", "Convite para " + organization.name, ["Você recebeu um convite para participar da equipe.", "Entre na conta do endereço destinatário para responder.", "Não compartilhe este link."], env().APP_URL + "/convite/" + token) });
    return { invitation, token };
  });
}

/** Convites ainda não aceitos nem revogados (inclui vencidos, que podem ser reenviados). */
export async function listPendingInvitations(db: Db, actor: Actor, organizationId: string) {
  await assertOrgPermission(db, actor, organizationId, "members:manage");
  const invitations = await db.organizationInvitation.findMany({
    where: { organizationId, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  const eventIds = [...new Set(invitations.flatMap((i) => (i.eventId ? [i.eventId] : [])))];
  const userIds = [...new Set(invitations.map((i) => i.invitedById))];
  const [events, inviters] = await Promise.all([
    db.event.findMany({ where: { id: { in: eventIds }, organizationId }, select: { id: true, title: true } }),
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
  ]);
  const now = new Date();
  return invitations.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    expired: i.expiresAt <= now,
    eventTitle: events.find((e) => e.id === i.eventId)?.title ?? null,
    invitedByName: inviters.find((u) => u.id === i.invitedById)?.name ?? null,
  }));
}

/** Carrega um convite pendente da organização e confere se o ator pode mexer no papel convidado. */
async function pendingInvitationForManager(tx: Tx, actor: Actor, organizationId: string, invitationId: string) {
  const { role: actorRole } = await assertOrgPermission(tx, actor, organizationId, "members:manage");
  const inv = await tx.organizationInvitation.findFirst({ where: { id: invitationId, organizationId } });
  if (!inv) throw notFound("Convite não encontrado.");
  assertCanManageRole(actorRole, inv.role);
  if (inv.acceptedAt || inv.revokedAt) throw invalidState("Este convite já foi aceito ou revogado.");
  return inv;
}

export async function revokeInvitation(db: Db, actor: Actor, organizationId: string, invitationId: string) {
  return db.$transaction(async (tx) => {
    const inv = await pendingInvitationForManager(tx, actor, organizationId, invitationId);
    // Condicional: perde para um aceite concorrente em vez de revogar um convite já usado.
    const { count } = await tx.organizationInvitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw invalidState("Este convite já foi aceito ou revogado.");
    // O e-mail ainda na fila levaria um link que não vale mais.
    await cancelQueuedEmails(tx, { prefix: "invitation:" + inv.id }, "INVITATION_REVOKED");
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "member.invitation_revoked",
      entityType: "OrganizationInvitation",
      entityId: inv.id,
      metadata: { email: inv.email, role: inv.role },
    });
  });
}

/** Gera um novo token (o anterior deixa de funcionar) e renova a validade. */
export async function resendInvitation(db: Db, actor: Actor, organizationId: string, invitationId: string) {
  const token = randomToken(32);
  return db.$transaction(async (tx) => {
    const inv = await pendingInvitationForManager(tx, actor, organizationId, invitationId);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const { count } = await tx.organizationInvitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null },
      data: { tokenHash: hashToken(token), expiresAt },
    });
    if (count === 0) throw invalidState("Este convite já foi aceito ou revogado.");
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "member.invitation_resent",
      entityType: "OrganizationInvitation",
      entityId: inv.id,
      metadata: { email: inv.email, role: inv.role },
    });
    // O link anterior parou de valer: não envia o e-mail dele se ainda estiver na fila.
    await cancelQueuedEmails(tx, { prefix: "invitation:" + inv.id }, "INVITATION_SUPERSEDED");
    await enqueueEmail(tx, { dedupeKey: "invitation:" + inv.id + ":" + hashToken(token), template: "ORGANIZER_INVITATION", recipient: inv.email, expiresAt, message: transactionalEmail("invitation", "Convite para a equipe", ["Um novo convite foi emitido. O link anterior não pode mais ser utilizado."], env().APP_URL + "/convite/" + token) });
    return { invitation: { ...inv, expiresAt }, token };
  });
}

/** Resumo exibido em /convite/[token]; null se o convite não puder mais ser usado. */
export async function getInvitationForInvitee(db: Db, actor: Actor & { email: string }, token: string) {
  assertActive(actor);
  const inv = await db.organizationInvitation.findFirst({
    where: { tokenHash: hashToken(token), ...usableInvitation() },
    select: { role: true, email: true, eventId: true, expiresAt: true, organization: { select: { name: true } } },
  });
  if (!inv) return null;
  if (inv.email !== actor.email.toLowerCase()) return { emailMatches: false as const };
  const event = inv.eventId ? await db.event.findUnique({ where: { id: inv.eventId }, select: { title: true } }) : null;
  return { emailMatches: true as const, organizationName: inv.organization.name, role: inv.role, eventTitle: event?.title ?? null, expiresAt: inv.expiresAt };
}

/** O token prova acesso à caixa de e-mail; o e-mail da conta também precisa coincidir. */
async function invitationForInvitee(tx: Tx, actor: Actor & { email: string }, token: string) {
  assertActive(actor);
  const inv = await tx.organizationInvitation.findFirst({ where: { tokenHash: hashToken(token), ...usableInvitation() } });
  if (!inv) throw invitationInvalid();
  if (inv.email !== actor.email.toLowerCase()) throw new AppError("FORBIDDEN", "Este convite foi enviado para outro e-mail.");
  return inv;
}

export async function acceptInvitation(db: Db, actor: Actor & { email: string }, token: string) {
  return db.$transaction(async (tx) => {
    const inv = await invitationForInvitee(tx, actor, token);
    // Reivindica o convite de forma atômica: com aceites simultâneos (ou revogação/
    // reenvio concorrente), só uma transação obtém count = 1.
    const { count } = await tx.organizationInvitation.updateMany({
      where: { id: inv.id, tokenHash: inv.tokenHash, ...usableInvitation() },
      data: { acceptedAt: new Date(), acceptedById: actor.id },
    });
    if (count === 0) throw invitationInvalid();
    // Quem já é membro mantém o papel atual; ON CONFLICT DO NOTHING cobre convites diferentes aceitos em paralelo.
    await tx.organizationMember.createMany({
      data: [{ organizationId: inv.organizationId, userId: actor.id, role: inv.role }],
      skipDuplicates: true,
    });
    if (inv.eventId) {
      await tx.eventStaffAssignment.createMany({
        data: [{ eventId: inv.eventId, userId: actor.id, assignedById: inv.invitedById }],
        skipDuplicates: true,
      });
    }
    await audit(tx, { actorUserId: actor.id, organizationId: inv.organizationId, action: "member.joined", entityType: "OrganizationInvitation", entityId: inv.id });
    return inv;
  });
}

/** O convidado recusa: o convite fica revogado (não há coluna própria; a recusa fica na auditoria). */
export async function declineInvitation(db: Db, actor: Actor & { email: string }, token: string) {
  return db.$transaction(async (tx) => {
    const inv = await invitationForInvitee(tx, actor, token);
    const { count } = await tx.organizationInvitation.updateMany({
      where: { id: inv.id, tokenHash: inv.tokenHash, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw invitationInvalid();
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: inv.organizationId,
      action: "member.invitation_declined",
      entityType: "OrganizationInvitation",
      entityId: inv.id,
    });
  });
}

/**
 * Atribui ou retira um membro da portaria de um evento. Trava a equipe da
 * organização: a retirada espera as leituras de check-in em curso, e as seguintes
 * já não admitem (ver `lockOrganizationForCheckin`).
 */
export async function assignStaffToEvent(db: Db, actor: Actor, eventId: string, userId: string, assign: boolean) {
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { organizationId: true } });
  await db.$transaction(async (tx) => {
    await lockOrganizationTeam(tx, event.organizationId);
    await assertOrgPermission(tx, actor, event.organizationId, "members:manage");
    const member = await tx.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: event.organizationId, userId } },
    });
    if (!member) throw new AppError("VALIDATION", "Usuário não pertence à organização.");
    if (assign) {
      await tx.eventStaffAssignment.upsert({
        where: { eventId_userId: { eventId, userId } },
        create: { eventId, userId, assignedById: actor.id },
        update: {},
      });
    } else {
      await tx.eventStaffAssignment.deleteMany({ where: { eventId, userId } });
    }
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: event.organizationId,
      action: assign ? "staff.assigned" : "staff.unassigned",
      entityType: "Event",
      entityId: eventId,
      metadata: { userId },
    });
  });
}

/**
 * Altera o papel de um membro. Regras (no servidor): quem altera precisa de
 * `members:manage`; não mexe em quem está acima dele nem concede papel acima do
 * próprio (só OWNER cria OWNER); a organização nunca fica sem OWNER.
 */
export async function changeMemberRole(db: Db, actor: Actor, organizationId: string, userId: string, role: OrgRole) {
  if (!Object.hasOwn(ROLE_RANK, role)) throw new AppError("VALIDATION", "Papel inválido.");
  return db.$transaction(async (tx) => {
    await lockOrganizationTeam(tx, organizationId);
    const { role: actorRole } = await assertOrgPermission(tx, actor, organizationId, "members:manage");
    const target = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
    if (!target) throw notFound("Membro não encontrado.");
    if (target.role === role) return target;
    assertCanManageRole(actorRole, target.role);
    assertCanManageRole(actorRole, role);
    if (target.role === "OWNER") await assertNotLastOwner(tx, organizationId);
    const updated = await tx.organizationMember.update({ where: { id: target.id }, data: { role } });
    // Atribuições por evento só valem para CHECKIN_STAFF; não deixa concessões antigas para trás.
    if (target.role === "CHECKIN_STAFF") await tx.eventStaffAssignment.deleteMany({ where: { userId, event: { organizationId } } });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "member.role_changed",
      entityType: "OrganizationMember",
      entityId: target.id,
      metadata: { userId, from: target.role, to: role },
    });
    return updated;
  });
}

export async function removeMember(db: Db, actor: Actor, organizationId: string, userId: string) {
  await db.$transaction(async (tx) => {
    await lockOrganizationTeam(tx, organizationId);
    const { role: actorRole } = await assertOrgPermission(tx, actor, organizationId, "members:manage");
    const target = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
    if (!target) throw notFound();
    assertCanManageRole(actorRole, target.role);
    if (target.role === "OWNER") await assertNotLastOwner(tx, organizationId);
    await tx.eventStaffAssignment.deleteMany({ where: { userId, event: { organizationId } } });
    await tx.organizationMember.delete({ where: { id: target.id } });
    await audit(tx, { actorUserId: actor.id, organizationId, action: "member.removed", entityType: "OrganizationMember", entityId: target.id, metadata: { userId } });
  });
}

// ───────────────────────────── Transferência de responsável ─────────────────────────────

export const OWNERSHIP_TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Pedido pendente e ainda no prazo. */
const liveTransfer = (now = new Date()) => ({ status: "PENDING" as const, expiresAt: { gt: now } });

async function assertOwner(tx: Tx, actor: Actor, organizationId: string) {
  const { role } = await assertOrgPermission(tx, actor, organizationId, "members:manage");
  if (role !== "OWNER") throw new AppError("FORBIDDEN", "Só o responsável (OWNER) pode transferir a organização.");
}

/** Confirma a senha de quem pede (conta só com login do Google não tem senha própria). */
async function confirmPassword(db: Db | Tx, userId: string, password: string | undefined) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, googleSubject: true } });
  if (user.googleSubject && !password) return;
  if (!password || !(await verifyPassword(password, user.passwordHash))) throw new AppError("FORBIDDEN", "Senha incorreta.");
}

/**
 * O dono atual pede a transferência para outro membro. Nada muda até o aceite; um novo
 * pedido cancela o anterior. O destinatário recebe o link por e-mail.
 */
export async function requestOwnershipTransfer(db: Db, actor: Actor, organizationId: string, toUserId: string, password: string | undefined, now = new Date()) {
  await confirmPassword(db, actor.id, password);
  const token = randomToken(32);
  return db.$transaction(async (tx) => {
    await lockOrganizationTeam(tx, organizationId);
    await assertOwner(tx, actor, organizationId);
    if (toUserId === actor.id) throw new AppError("VALIDATION", "Escolha outro membro da equipe.");
    const target = await tx.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: toUserId } },
      include: { user: { select: { email: true, name: true, status: true } } },
    });
    if (!target) throw notFound("Membro não encontrado.");
    if (target.role === "OWNER") throw new AppError("VALIDATION", "Este membro já é responsável pela organização.");
    if (target.user.status !== "ACTIVE") throw new AppError("VALIDATION", "Esta conta está suspensa.");
    const replaced = await tx.organizationOwnershipTransfer.findMany({ where: { organizationId, status: "PENDING" }, select: { id: true } });
    await tx.organizationOwnershipTransfer.updateMany({ where: { organizationId, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: now } });
    await cancelQueuedEmails(tx, replaced.map((r) => "ownership:" + r.id), "OWNERSHIP_TRANSFER_SUPERSEDED");
    const transfer = await tx.organizationOwnershipTransfer.create({
      data: { organizationId, fromUserId: actor.id, toUserId, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + OWNERSHIP_TRANSFER_TTL_MS) },
    });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "organization.ownership_transfer_requested",
      entityType: "OrganizationOwnershipTransfer",
      entityId: transfer.id,
      metadata: { toUserId, fromRole: "OWNER", toRole: target.role },
    });
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } });
    await enqueueEmail(tx, {
      dedupeKey: "ownership:" + transfer.id,
      template: "ORGANIZATION_OWNERSHIP_TRANSFER",
      recipient: target.user.email,
      expiresAt: transfer.expiresAt,
      message: transactionalEmail(
        "ownership",
        "Transferência de responsável",
        [`Você foi indicado para ser o novo responsável por ${org.name}.`, "Entre com esta conta e confirme pelo link. Até lá, nada muda.", "Não compartilhe este link."],
        env().APP_URL + "/organizador/propriedade/" + token,
      ),
    });
    return { transfer, token };
  });
}

/** Pedido pendente da organização (tela da equipe). */
export async function pendingOwnershipTransfer(db: Db, actor: Actor, organizationId: string, now = new Date()) {
  await assertOrgPermission(db, actor, organizationId, "members:manage");
  const t = await db.organizationOwnershipTransfer.findFirst({ where: { organizationId, ...liveTransfer(now) } });
  if (!t) return null;
  const to = await db.user.findUnique({ where: { id: t.toUserId }, select: { name: true, email: true } });
  return { id: t.id, expiresAt: t.expiresAt, toName: to?.name ?? null, toEmail: to?.email ?? null };
}

/** Resumo para a página do link; null se o pedido não puder mais ser respondido. */
export async function getOwnershipTransferForRecipient(db: Db, actor: Actor, token: string, now = new Date()) {
  assertActive(actor);
  const t = await db.organizationOwnershipTransfer.findFirst({
    where: { tokenHash: hashToken(token), ...liveTransfer(now) },
    include: { organization: { select: { name: true } } },
  });
  if (!t) return null;
  if (t.toUserId !== actor.id) return { forMe: false as const };
  const from = await db.user.findUnique({ where: { id: t.fromUserId }, select: { name: true } });
  return { forMe: true as const, organizationName: t.organization.name, fromName: from?.name ?? null, expiresAt: t.expiresAt };
}

const transferGone = () => new AppError("NOT_FOUND", "Este pedido de transferência é inválido, expirou ou foi cancelado.");

/** O destinatário aceita: vira OWNER e quem pediu passa a ADMIN, na mesma transação. */
export async function acceptOwnershipTransfer(db: Db, actor: Actor, token: string, now = new Date()) {
  assertActive(actor);
  return db.$transaction(async (tx) => {
    const t = await tx.organizationOwnershipTransfer.findFirst({ where: { tokenHash: hashToken(token), ...liveTransfer(now) } });
    if (!t || t.toUserId !== actor.id) throw transferGone();
    await lockOrganizationTeam(tx, t.organizationId);
    // Reivindica o pedido: aceite duplo ou cancelamento concorrente perdem aqui.
    const { count } = await tx.organizationOwnershipTransfer.updateMany({ where: { id: t.id, ...liveTransfer(now) }, data: { status: "ACCEPTED", decidedAt: now } });
    if (count !== 1) throw transferGone();
    const [from, to] = await Promise.all([
      tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: t.organizationId, userId: t.fromUserId } } }),
      tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: t.organizationId, userId: t.toUserId } } }),
    ]);
    // A equipe mudou depois do pedido (quem pediu não é mais dono, ou o destinatário saiu).
    if (from?.role !== "OWNER" || !to) throw invalidState("A equipe mudou depois do pedido. Peça uma nova transferência.");
    await tx.organizationMember.update({ where: { id: to.id }, data: { role: "OWNER" } });
    if (to.role === "CHECKIN_STAFF") await tx.eventStaffAssignment.deleteMany({ where: { userId: to.userId, event: { organizationId: t.organizationId } } });
    await tx.organizationMember.update({ where: { id: from.id }, data: { role: "ADMIN" } });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: t.organizationId,
      action: "organization.ownership_transferred",
      entityType: "OrganizationOwnershipTransfer",
      entityId: t.id,
      metadata: { fromUserId: t.fromUserId, toUserId: t.toUserId, previousRole: to.role },
    });
    const [org, users] = await Promise.all([
      tx.organization.findUniqueOrThrow({ where: { id: t.organizationId }, select: { name: true } }),
      tx.user.findMany({ where: { id: { in: [t.fromUserId, t.toUserId] } }, select: { id: true, email: true } }),
    ]);
    for (const u of users) {
      await enqueueEmail(tx, {
        dedupeKey: `ownership:${t.id}:accepted:${u.id}`,
        template: "ORGANIZATION_OWNERSHIP_CHANGED",
        recipient: u.email,
        message: transactionalEmail(
          "ownership",
          "Novo responsável pela organização",
          [
            u.id === t.toUserId ? `Você agora é o responsável por ${org.name}.` : `A transferência de ${org.name} foi aceita. Você continua na equipe como administrador.`,
            "Se você não reconhece esta mudança, fale com o suporte.",
          ],
          env().APP_URL + "/organizador/equipe",
        ),
      });
    }
    return { organizationId: t.organizationId };
  });
}

/** O destinatário recusa. */
export async function declineOwnershipTransfer(db: Db, actor: Actor, token: string, now = new Date()) {
  assertActive(actor);
  return db.$transaction(async (tx) => {
    const t = await tx.organizationOwnershipTransfer.findFirst({ where: { tokenHash: hashToken(token), ...liveTransfer(now) } });
    if (!t || t.toUserId !== actor.id) throw transferGone();
    const { count } = await tx.organizationOwnershipTransfer.updateMany({ where: { id: t.id, ...liveTransfer(now) }, data: { status: "DECLINED", decidedAt: now } });
    if (count !== 1) throw transferGone();
    await cancelQueuedEmails(tx, ["ownership:" + t.id], "OWNERSHIP_TRANSFER_DECLINED");
    await audit(tx, { actorUserId: actor.id, organizationId: t.organizationId, action: "organization.ownership_transfer_declined", entityType: "OrganizationOwnershipTransfer", entityId: t.id });
  });
}

/** Um responsável cancela o pedido pendente. */
export async function cancelOwnershipTransfer(db: Db, actor: Actor, organizationId: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    await lockOrganizationTeam(tx, organizationId);
    await assertOwner(tx, actor, organizationId);
    const t = await tx.organizationOwnershipTransfer.findFirst({ where: { organizationId, status: "PENDING" } });
    if (!t) throw notFound("Não há transferência pendente.");
    await tx.organizationOwnershipTransfer.update({ where: { id: t.id }, data: { status: "CANCELLED", decidedAt: now } });
    await cancelQueuedEmails(tx, ["ownership:" + t.id], "OWNERSHIP_TRANSFER_CANCELLED");
    await audit(tx, { actorUserId: actor.id, organizationId, action: "organization.ownership_transfer_cancelled", entityType: "OrganizationOwnershipTransfer", entityId: t.id });
  });
}
