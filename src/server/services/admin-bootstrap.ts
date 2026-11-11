import "server-only";
import type { Db } from "../db";
import { audit } from "../audit";
import { AppError } from "../errors";

/**
 * Primeiro administrador da plataforma (npm run admin:promote). Só funciona enquanto não
 * houver um SUPER_ADMIN ativo: depois disso, papéis se gerenciam em /admin/usuarios, com
 * 2FA e auditoria do próprio painel. A pessoa precisa já ter conta com e-mail confirmado.
 */
export async function bootstrapFirstAdmin(db: Db, email: string): Promise<{ userId: string }> {
  return db.$transaction(async (tx) => {
    const existing = await tx.user.count({ where: { platformRole: "ADMIN", adminRoles: { has: "SUPER_ADMIN" }, status: "ACTIVE", anonymizedAt: null } });
    if (existing > 0) throw new AppError("INVALID_STATE", "Já existe um superadministrador ativo; gerencie papéis em /admin/usuarios.");
    const user = await tx.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.anonymizedAt) throw new AppError("NOT_FOUND", "Nenhuma conta com esse e-mail. Cadastre-se no site primeiro.");
    if (user.isDemoAccount) throw new AppError("INVALID_STATE", "Contas de demonstração não podem ser administradoras.");
    if (user.status !== "ACTIVE") throw new AppError("INVALID_STATE", "A conta não está ativa.");
    if (!user.emailVerifiedAt) throw new AppError("INVALID_STATE", "Confirme o e-mail da conta antes de torná-la administradora.");
    await tx.user.update({ where: { id: user.id }, data: { platformRole: "ADMIN", adminRoles: ["SUPER_ADMIN"] } });
    await audit(tx, { actorUserId: null, action: "admin.bootstrap", entityType: "User", entityId: user.id, metadata: { before: { platformRole: user.platformRole, adminRoles: user.adminRoles }, after: { platformRole: "ADMIN", adminRoles: ["SUPER_ADMIN"] } } });
    return { userId: user.id };
  });
}
