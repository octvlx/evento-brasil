import "server-only";
import type { TermsAcceptanceContext, TermsKind, TermsVersion } from "@/generated/prisma/client";
import type { Db, Tx } from "../db";
import { AppError } from "../errors";

// Aceite de termos versionados (R10, ADR 0003 §4). TermsVersion e TermsAcceptance
// são somente inserção; versão vigente = maior publishedAt <= agora por tipo.
// Os textos atuais são rascunho (isDraft) até D8: o aceite do rascunho é
// registrado normalmente e a versão final entra como linha nova (reaceite).

/** O comprador aceita os termos de uso e a política de privacidade juntos. */
export const BUYER_KINDS: readonly TermsKind[] = ["BUYER", "PRIVACY"];

export interface AcceptanceMeta {
  context: TermsAcceptanceContext;
  ip?: string | null;
  userAgent?: string | null;
  /** Obrigatório em CHECKOUT (CHECK TermsAcceptance_checkout_order). */
  orderId?: string;
  /** Obrigatório em ORGANIZER_SIGNUP. */
  organizationId?: string;
}

const warned = new Set<TermsKind>();

/**
 * Versão vigente de cada tipo pedido. Tipo sem versão publicada fica de fora:
 * não há o que aceitar (banco sem o seed de termos). Avisa uma vez por processo.
 */
export async function currentTermsVersions(db: Db | Tx, kinds: readonly TermsKind[], now = new Date()): Promise<TermsVersion[]> {
  const found = await Promise.all(
    kinds.map((kind) => db.termsVersion.findFirst({ where: { kind, publishedAt: { lte: now } }, orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }] })),
  );
  const versions: TermsVersion[] = [];
  found.forEach((v, i) => {
    if (v) return void versions.push(v);
    const kind = kinds[i];
    if (!warned.has(kind)) {
      warned.add(kind);
      console.warn(`[terms] Nenhuma TermsVersion publicada para ${kind}: aceite não exigido nem registrado. Rode o seed de termos.`);
    }
  });
  return versions;
}

/** Tipos cuja versão vigente o usuário ainda não aceitou (em qualquer contexto). */
export async function pendingTermsKinds(db: Db | Tx, userId: string, kinds: readonly TermsKind[] = BUYER_KINDS, now = new Date()): Promise<TermsKind[]> {
  const versions = await currentTermsVersions(db, kinds, now);
  if (!versions.length) return [];
  const accepted = await db.termsAcceptance.findMany({
    where: { userId, termsVersionId: { in: versions.map((v) => v.id) } },
    select: { termsVersionId: true },
  });
  const done = new Set(accepted.map((a) => a.termsVersionId));
  return versions.filter((v) => !done.has(v.id)).map((v) => v.kind);
}

export async function hasAccepted(db: Db | Tx, userId: string, kinds: readonly TermsKind[] = BUYER_KINDS, now = new Date()): Promise<boolean> {
  return (await pendingTermsKinds(db, userId, kinds, now)).length === 0;
}

/**
 * Portão da compra: com versão vigente não aceita e sem o aceite marcado, falha
 * com TERMS_REQUIRED. Retorna os tipos a gravar como aceite CHECKOUT do pedido.
 */
export async function checkoutTermsGate(db: Db | Tx, userId: string, acceptTerms: boolean | undefined): Promise<TermsKind[]> {
  const pending = await pendingTermsKinds(db, userId);
  if (pending.length && acceptTerms !== true)
    throw new AppError("TERMS_REQUIRED", "Os termos de uso ou a política de privacidade foram atualizados. Leia e aceite a versão atual para continuar.");
  return pending;
}

/**
 * Registra o aceite das versões vigentes. Idempotente por usuário + versão
 * (e por organização, no contrato do organizador): versão já aceita não gera
 * linha nova. Retorna as versões efetivamente registradas.
 */
export async function recordAcceptance(db: Db, userId: string, kinds: readonly TermsKind[], meta: AcceptanceMeta): Promise<TermsVersion[]> {
  return db.$transaction((tx) => recordAcceptanceTx(tx, userId, kinds, meta));
}

export async function recordAcceptanceTx(tx: Tx, userId: string, kinds: readonly TermsKind[], meta: AcceptanceMeta): Promise<TermsVersion[]> {
  // Serializa aceites do mesmo usuário (cadastro/reaceite não têm índice único).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`terms:${userId}`}))`;
  const versions = await currentTermsVersions(tx, kinds);
  const organizationId = meta.context === "ORGANIZER_SIGNUP" ? meta.organizationId : undefined;
  const recorded: TermsVersion[] = [];
  for (const v of versions) {
    const existing = await tx.termsAcceptance.findFirst({
      where: { userId, termsVersionId: v.id, ...(organizationId ? { organizationId } : {}) },
      select: { id: true },
    });
    if (existing) continue;
    await tx.termsAcceptance.create({
      data: {
        userId,
        termsVersionId: v.id,
        context: meta.context,
        orderId: meta.context === "CHECKOUT" ? meta.orderId : null,
        organizationId: organizationId ?? null,
        ip: meta.ip?.slice(0, 64) ?? null,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
      },
    });
    recorded.push(v);
  }
  return recorded;
}
