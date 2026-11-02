import "server-only";
import type { Db } from "../db";
import { audit } from "../audit";
import { assertActive, type Actor } from "../auth/permissions";

// Exportação dos dados do titular (LGPD art. 18, II e V; R9). Só dados do próprio
// usuário: nada de senha, hashes de token, token do QR, dados do pagamento no
// provedor nem dados pessoais de outras pessoas (ex.: quem transferiu um ingresso
// para o usuário). Exclusão/anonimização: services/account-deletion.ts (prazos provisórios até D6).

export const DATA_EXPORT_FORMAT = "evento-brasil/meus-dados@1";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function exportUserData(db: Db, actor: Actor) {
  assertActive(actor);
  const userId = actor.id;
  const [user, sessions, memberships, orders, heldTickets, transfers, cancellations, acceptances] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, email: true, phone: true, emailVerifiedAt: true, cpfLast2: true, birthDate: true, address: { select: { postalCode: true, street: true, number: true, complement: true, district: true, city: true, state: true } }, platformRole: true, status: true, createdAt: true, updatedAt: true },
    }),
    db.session.findMany({ where: { userId }, select: { createdAt: true, lastSeenAt: true, expiresAt: true, userAgent: true }, orderBy: { createdAt: "desc" } }),
    db.organizationMember.findMany({ where: { userId }, select: { role: true, createdAt: true, organization: { select: { name: true, slug: true } } } }),
    db.order.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        publicCode: true,
        status: true,
        currency: true,
        subtotalCents: true,
        serviceFeeCents: true,
        discountCents: true,
        totalCents: true,
        couponCode: true,
        buyerName: true,
        buyerEmail: true,
        buyerPhone: true,
        createdAt: true,
        paidAt: true,
        cancelledAt: true,
        utmSource: true,
        utmMedium: true,
        utmCampaign: true,
        utmContent: true,
        utmTerm: true,
        event: { select: { title: true, slug: true, startsAt: true } },
        organization: { select: { name: true } },
        items: { select: { ticketTypeName: true, kind: true, unitPriceCents: true, serviceFeePerUnitCents: true, quantity: true, attendees: true } },
        payments: { select: { method: true, status: true, amountCents: true, createdAt: true, paidAt: true }, orderBy: { createdAt: "asc" } },
        refunds: { select: { amountCents: true, status: true, reason: true, createdAt: true, processedAt: true }, orderBy: { createdAt: "asc" } },
      },
    }),
    db.issuedTicket.findMany({
      where: { holderUserId: userId },
      orderBy: { issuedAt: "desc" },
      select: {
        code: true,
        status: true,
        holderName: true,
        holderEmail: true,
        issuedAt: true,
        checkedInAt: true,
        revokedAt: true,
        revocationReason: true,
        userId: true,
        order: { select: { publicCode: true } },
        ticketType: { select: { name: true, kind: true } },
        event: { select: { title: true, slug: true, startsAt: true } },
      },
    }),
    db.ticketTransfer.findMany({
      where: { OR: [{ fromUserId: userId }, { toUserId: userId }] },
      orderBy: { createdAt: "desc" },
      select: {
        fromUserId: true,
        toEmail: true,
        toHolderName: true,
        status: true,
        initiatedBy: true,
        createdAt: true,
        expiresAt: true,
        decidedAt: true,
        requestIp: true,
        ticket: { select: { code: true } },
        event: { select: { title: true } },
      },
    }),
    db.cancellationRequest.findMany({
      where: { requestedById: userId },
      orderBy: { createdAt: "desc" },
      select: { protocol: true, status: true, reason: true, decisionNote: true, createdAt: true, decidedAt: true, order: { select: { publicCode: true } } },
    }),
    db.termsAcceptance.findMany({
      where: { userId },
      orderBy: { acceptedAt: "asc" },
      select: {
        context: true,
        acceptedAt: true,
        ip: true,
        userAgent: true,
        termsVersion: { select: { kind: true, version: true, textHash: true, isDraft: true, documentPath: true } },
        order: { select: { publicCode: true } },
        organization: { select: { name: true } },
      },
    }),
  ]);

  return {
    format: DATA_EXPORT_FORMAT,
    generatedAt: new Date().toISOString(),
    profile: { ...user, cpfMasked: user.cpfLast2 ? `***.***.***-${user.cpfLast2}` : null, emailVerifiedAt: iso(user.emailVerifiedAt), birthDate: user.birthDate?.toISOString().slice(0, 10) ?? null, createdAt: iso(user.createdAt), updatedAt: iso(user.updatedAt) },
    sessions: sessions.map((s) => ({ createdAt: iso(s.createdAt), lastSeenAt: iso(s.lastSeenAt), expiresAt: iso(s.expiresAt), userAgent: s.userAgent })),
    organizations: memberships.map((m) => ({ name: m.organization.name, slug: m.organization.slug, role: m.role, since: iso(m.createdAt) })),
    orders: orders.map((o) => ({
      code: o.publicCode,
      status: o.status,
      event: { title: o.event.title, slug: o.event.slug, startsAt: iso(o.event.startsAt) },
      seller: o.organization.name,
      buyer: { name: o.buyerName, email: o.buyerEmail, phone: o.buyerPhone },
      currency: o.currency,
      subtotalCents: o.subtotalCents,
      serviceFeeCents: o.serviceFeeCents,
      discountCents: o.discountCents,
      totalCents: o.totalCents,
      couponCode: o.couponCode,
      utm: { source: o.utmSource, medium: o.utmMedium, campaign: o.utmCampaign, content: o.utmContent, term: o.utmTerm },
      createdAt: iso(o.createdAt),
      paidAt: iso(o.paidAt),
      cancelledAt: iso(o.cancelledAt),
      items: o.items,
      payments: o.payments.map((p) => ({ ...p, createdAt: iso(p.createdAt), paidAt: iso(p.paidAt) })),
      refunds: o.refunds.map((r) => ({ ...r, createdAt: iso(r.createdAt), processedAt: iso(r.processedAt) })),
    })),
    tickets: heldTickets.map((t) => ({
      code: t.code,
      status: t.status,
      event: { title: t.event.title, slug: t.event.slug, startsAt: iso(t.event.startsAt) },
      ticketType: t.ticketType.name,
      kind: t.ticketType.kind,
      holderName: t.holderName,
      holderEmail: t.holderEmail,
      // Pedido só quando o próprio usuário comprou; recebido por transferência não expõe o pedido de outra pessoa.
      orderCode: t.userId === userId ? t.order.publicCode : null,
      receivedByTransfer: t.userId !== userId,
      issuedAt: iso(t.issuedAt),
      checkedInAt: iso(t.checkedInAt),
      revokedAt: iso(t.revokedAt),
      revocationReason: t.revocationReason,
    })),
    transfers: transfers.map((t) => {
      const sent = t.fromUserId === userId;
      return {
        direction: sent ? "SENT" : "RECEIVED",
        ticketCode: t.ticket.code,
        event: t.event.title,
        status: t.status,
        initiatedBy: t.initiatedBy,
        // Destinatário informado pelo próprio usuário; quem enviou para ele não é exportado.
        toEmail: sent ? t.toEmail : null,
        toHolderName: sent ? t.toHolderName : null,
        requestIp: sent ? t.requestIp : null,
        createdAt: iso(t.createdAt),
        expiresAt: iso(t.expiresAt),
        decidedAt: iso(t.decidedAt),
      };
    }),
    cancellationRequests: cancellations.map((c) => ({
      protocol: c.protocol,
      orderCode: c.order.publicCode,
      status: c.status,
      reason: c.reason,
      decisionNote: c.decisionNote,
      createdAt: iso(c.createdAt),
      decidedAt: iso(c.decidedAt),
    })),
    termsAcceptances: acceptances.map((a) => ({
      kind: a.termsVersion.kind,
      version: a.termsVersion.version,
      textHash: a.termsVersion.textHash,
      isDraft: a.termsVersion.isDraft,
      documentPath: a.termsVersion.documentPath,
      context: a.context,
      orderCode: a.order?.publicCode ?? null,
      organization: a.organization?.name ?? null,
      acceptedAt: iso(a.acceptedAt),
      ip: a.ip,
      userAgent: a.userAgent,
    })),
  };
}

export type UserDataExport = Awaited<ReturnType<typeof exportUserData>>;

/** Exporta e registra a exportação no log de auditoria (sem o conteúdo). */
export async function exportUserDataAudited(db: Db, actor: Actor, client: { ip?: string | null } = {}) {
  const data = await exportUserData(db, actor);
  await audit(db, {
    actorUserId: actor.id,
    action: "user.data_exported",
    entityType: "User",
    entityId: actor.id,
    metadata: { format: DATA_EXPORT_FORMAT, ip: client.ip ?? null, orders: data.orders.length, tickets: data.tickets.length },
  });
  return data;
}
