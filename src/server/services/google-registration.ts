import "server-only";
import type { Db } from "../db";
import { googleIdentitySchema, readGoogleCookie } from "../auth/google";
import { hashPassword } from "../auth/password";
import { randomToken } from "../crypto";
import { AppError } from "../errors";
import { BUYER_KINDS, recordAcceptanceTx } from "./terms";
import { audit } from "../audit";

export async function registerGoogleUser(db: Db, rawCookie: string | undefined, acceptTerms: boolean, acceptPrivacy: boolean, client: { ip?: string | null; userAgent?: string | null } = {}) {
  if (acceptTerms !== true || acceptPrivacy !== true) throw new AppError("VALIDATION", "Leia e aceite os termos e confirme a ciência da política de privacidade.");
  const identity = googleIdentitySchema.parse(readGoogleCookie("pending", rawCookie));
  const passwordHash = await hashPassword(randomToken(64));
  try {
    const user = await db.$transaction(async (tx) => {
      if (await tx.user.findFirst({ where: { OR: [{ googleSubject: identity.subject }, { email: identity.email }] }, select: { id: true } })) throw new AppError("CONFLICT", "Esta conta já existe. Volte à página de login para entrar.");
      const user = await tx.user.create({ data: { email: identity.email, name: identity.name, googleSubject: identity.subject, emailVerifiedAt: new Date(), passwordHash } });
      const accepted = await recordAcceptanceTx(tx, user.id, BUYER_KINDS, { context: "SIGNUP", ...client });
      await audit(tx, { actorUserId: user.id, action: "user.registered", entityType: "User", entityId: user.id, metadata: { provider: "google", termsAccepted: accepted.map(v => `${v.kind}:${v.version}`) } });
      return user;
    });
    return { user, next: identity.next };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new AppError("CONFLICT", "Esta conta já existe. Volte à página de login para entrar.");
    throw error;
  }
}
