import "server-only";
import { inviteSchema, organizerApplicationSchema, type OrganizerApplicationInput } from "@/features/schemas";
import { onlyDigits } from "@/lib/br";
import { slugify } from "@/lib/utils";
import type { Db, Tx } from "../db";
import { audit } from "../audit";
import { assertActive, assertOrgPermission, assertPlatformAdmin, type Actor } from "../auth/permissions";
import { encryptPII, hashToken, randomToken } from "../crypto";
import { AppError, invalidState, notFound } from "../errors";

async function uniqueOrgSlug(client: Db | Tx, name: string): Promise<string> {
  const base = slugify(name) || "organizador";
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await client.organization.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  return `${base}-${randomToken(4).toLowerCase()}`;
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

/**
 * Cria uma NOVA organização e envia para análise. O usuário vira OWNER.
 * Serve tanto para o primeiro cadastro quanto para organizações adicionais.
 */
export async function submitOrganizerApplication(db: Db, actor: Actor, raw: OrganizerApplicationInput) {
  assertActive(actor);
  const input = organizerApplicationSchema.parse(raw);
  return db.$transaction(async (tx) => {
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
        cityId: input.cityId || null,
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

/** Reenvio após rejeição (ou complemento de cadastro em rascunho). */
export async function resubmitOrganizerApplication(db: Db, actor: Actor, organizationId: string, raw: OrganizerApplicationInput) {
  await assertOrgPermission(db, actor, organizationId, "org:manage");
  const input = organizerApplicationSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (org.status !== "REJECTED" && org.status !== "DRAFT") throw invalidState("Esta organização não está aguardando reenvio.");
    const updated = await tx.organization.update({
      where: { id: organizationId },
      data: {
        name: input.name,
        legalType: input.legalType,
        description: input.description,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone ? onlyDigits(input.contactPhone) : null,
        cityId: input.cityId || null,
        status: "PENDING_REVIEW",
        statusReason: null,
        verifications: { create: verificationData(input, actor.id) },
      },
    });
    await audit(tx, { actorUserId: actor.id, organizationId, action: "organization.resubmitted", entityType: "Organization", entityId: organizationId });
    return updated;
  });
}

export async function reviewOrganization(db: Db, admin: Actor, organizationId: string, decision: "APPROVE" | "REJECT", note?: string) {
  assertPlatformAdmin(admin);
  if (decision === "REJECT" && !note?.trim()) throw new AppError("VALIDATION", "Informe o motivo da rejeição.");
  return db.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw notFound();
    if (org.status !== "PENDING_REVIEW") throw invalidState("A organização não está em análise.");
    const latest = await tx.organizerVerification.findFirst({ where: { organizationId }, orderBy: { createdAt: "desc" } });
    if (latest) {
      await tx.organizerVerification.update({
        where: { id: latest.id },
        data: { status: decision === "APPROVE" ? "APPROVED" : "REJECTED", reviewedById: admin.id, reviewedAt: new Date(), decisionNote: note ?? null },
      });
    }
    const updated = await tx.organization.update({
      where: { id: organizationId },
      data: { status: decision === "APPROVE" ? "APPROVED" : "REJECTED", statusReason: note ?? null },
    });
    await audit(tx, {
      actorUserId: admin.id,
      organizationId,
      action: decision === "APPROVE" ? "organization.approved" : "organization.rejected",
      entityType: "Organization",
      entityId: organizationId,
      metadata: { note: note ?? null },
    });
    return updated;
  });
}

export async function setOrganizationSuspended(db: Db, admin: Actor, organizationId: string, suspended: boolean, reason?: string) {
  assertPlatformAdmin(admin);
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
  if (suspended === (org.status === "SUSPENDED")) return org;
  if (!suspended && org.status !== "SUSPENDED") throw invalidState("Organização não está suspensa.");
  const updated = await db.organization.update({
    where: { id: organizationId },
    data: { status: suspended ? "SUSPENDED" : "APPROVED", statusReason: suspended ? (reason ?? "Suspensa pela plataforma") : null },
  });
  await audit(db, {
    actorUserId: admin.id,
    organizationId,
    action: suspended ? "organization.suspended" : "organization.reinstated",
    entityType: "Organization",
    entityId: organizationId,
    metadata: { reason: reason ?? null },
  });
  return updated;
}

export async function setAutoPublish(db: Db, admin: Actor, organizationId: string, value: boolean) {
  assertPlatformAdmin(admin);
  await db.organization.update({ where: { id: organizationId }, data: { autoPublishEvents: value } });
  await audit(db, { actorUserId: admin.id, organizationId, action: "organization.auto_publish", entityType: "Organization", entityId: organizationId, metadata: { value } });
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

// ── Equipe ──

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function inviteMember(db: Db, actor: Actor, organizationId: string, raw: unknown) {
  await assertOrgPermission(db, actor, organizationId, "members:manage");
  const input = inviteSchema.parse(raw);
  if (input.eventId) {
    const ev = await db.event.findFirst({ where: { id: input.eventId, organizationId }, select: { id: true } });
    if (!ev) throw notFound("Evento não encontrado nesta organização.");
  }
  const token = randomToken(32);
  const invitation = await db.organizationInvitation.create({
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
  await audit(db, {
    actorUserId: actor.id,
    organizationId,
    action: "member.invited",
    entityType: "OrganizationInvitation",
    entityId: invitation.id,
    metadata: { role: input.role, eventId: input.eventId ?? null },
  });
  return { invitation, token };
}

/** O token prova acesso à caixa de e-mail; o e-mail da conta também precisa coincidir. */
export async function acceptInvitation(db: Db, actor: Actor & { email: string }, token: string) {
  assertActive(actor);
  return db.$transaction(async (tx) => {
    const inv = await tx.organizationInvitation.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt < new Date()) throw new AppError("NOT_FOUND", "Convite inválido ou expirado.");
    if (inv.email !== actor.email.toLowerCase()) throw new AppError("FORBIDDEN", "Este convite foi enviado para outro e-mail.");
    const existing = await tx.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: inv.organizationId, userId: actor.id } },
    });
    if (!existing) await tx.organizationMember.create({ data: { organizationId: inv.organizationId, userId: actor.id, role: inv.role } });
    if (inv.eventId) {
      await tx.eventStaffAssignment.upsert({
        where: { eventId_userId: { eventId: inv.eventId, userId: actor.id } },
        create: { eventId: inv.eventId, userId: actor.id, assignedById: inv.invitedById },
        update: {},
      });
    }
    await tx.organizationInvitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date(), acceptedById: actor.id } });
    await audit(tx, { actorUserId: actor.id, organizationId: inv.organizationId, action: "member.joined", entityType: "OrganizationInvitation", entityId: inv.id });
    return inv;
  });
}

export async function assignStaffToEvent(db: Db, actor: Actor, eventId: string, userId: string, assign: boolean) {
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { organizationId: true } });
  await assertOrgPermission(db, actor, event.organizationId, "members:manage");
  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: event.organizationId, userId } },
  });
  if (!member) throw new AppError("VALIDATION", "Usuário não pertence à organização.");
  if (assign) {
    await db.eventStaffAssignment.upsert({
      where: { eventId_userId: { eventId, userId } },
      create: { eventId, userId, assignedById: actor.id },
      update: {},
    });
  } else {
    await db.eventStaffAssignment.deleteMany({ where: { eventId, userId } });
  }
  await audit(db, {
    actorUserId: actor.id,
    organizationId: event.organizationId,
    action: assign ? "staff.assigned" : "staff.unassigned",
    entityType: "Event",
    entityId: eventId,
    metadata: { userId },
  });
}

export async function removeMember(db: Db, actor: Actor, organizationId: string, userId: string) {
  await assertOrgPermission(db, actor, organizationId, "members:manage");
  const target = await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
  if (!target) throw notFound();
  if (target.role === "OWNER") {
    const owners = await db.organizationMember.count({ where: { organizationId, role: "OWNER" } });
    if (owners <= 1) throw new AppError("VALIDATION", "A organização precisa de ao menos um responsável (OWNER).");
  }
  await db.$transaction([
    db.eventStaffAssignment.deleteMany({ where: { userId, event: { organizationId } } }),
    db.organizationMember.delete({ where: { id: target.id } }),
  ]);
  await audit(db, { actorUserId: actor.id, organizationId, action: "member.removed", entityType: "OrganizationMember", entityId: target.id, metadata: { userId } });
}
