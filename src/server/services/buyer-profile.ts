import "server-only";
import { createHmac } from "node:crypto";
import { buyerAddressSchema, buyerPersonalSchema } from "@/features/buyer/schemas";
import type { Db } from "../db";
import { assertActive, type Actor } from "../auth/permissions";
import { audit } from "../audit";
import { encryptPII } from "../crypto";
import { env } from "../env";
import { AppError } from "../errors";

export function buyerCpfHash(cpf: string) {
  return createHmac("sha256", env().DATA_ENCRYPTION_KEY).update(`buyer-cpf:${cpf}`).digest("hex");
}

export async function getBuyerCheckoutProfile(db: Db, actor: Actor) {
  assertActive(actor);
  const user = await db.user.findUniqueOrThrow({ where: { id: actor.id }, select: {
    name: true, email: true, emailVerifiedAt: true, cpfEncrypted: true, cpfHash: true,
    cpfLast2: true, birthDate: true, address: true,
  } });
  return {
    name: user.name, email: user.email, emailVerified: !!user.emailVerifiedAt,
    cpfMasked: user.cpfLast2 ? `***.***.***-${user.cpfLast2}` : null,
    birthDate: user.birthDate?.toISOString().slice(0, 10) ?? null,
    personalComplete: !!(user.name && user.cpfEncrypted && user.cpfHash && user.birthDate),
    address: user.address ? { postalCode: user.address.postalCode, street: user.address.street,
      number: user.address.number, complement: user.address.complement ?? "", district: user.address.district,
      city: user.address.city, state: user.address.state } : null,
  };
}

export async function saveBuyerPersonalData(db: Db, actor: Actor, raw: unknown) {
  assertActive(actor);
  const parsed = buyerPersonalSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Dados pessoais inválidos.");
  const input = parsed.data;
  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id} FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { cpfHash: true } });
      if (!user.cpfHash && !input.cpf) throw new AppError("VALIDATION", "Informe seu CPF para concluir o cadastro.");
      if (user.cpfHash && input.cpf && buyerCpfHash(input.cpf) !== user.cpfHash) {
        throw new AppError("FORBIDDEN", "O CPF cadastrado não pode ser alterado aqui. Fale com o suporte.");
      }
      await tx.user.update({ where: { id: actor.id }, data: { name: input.name,
        birthDate: new Date(`${input.birthDate}T00:00:00.000Z`),
        ...(!user.cpfHash && input.cpf ? { cpfEncrypted: encryptPII(input.cpf), cpfHash: buyerCpfHash(input.cpf), cpfLast2: input.cpf.slice(-2) } : {}),
      } });
      await audit(tx, { actorUserId: actor.id, action: "buyer.profile_updated", entityType: "User", entityId: actor.id });
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw new AppError("CONFLICT", "Este CPF já está cadastrado. Fale com o suporte.");
    }
    throw error;
  }
  return getBuyerCheckoutProfile(db, actor);
}

export async function saveBuyerAddress(db: Db, actor: Actor, raw: unknown) {
  assertActive(actor);
  const parsed = buyerAddressSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Endereço inválido.");
  const data = { ...parsed.data, complement: parsed.data.complement ?? null };
  await db.$transaction(async (tx) => {
    await tx.userAddress.upsert({ where: { userId: actor.id }, create: { userId: actor.id, ...data }, update: data });
    await audit(tx, { actorUserId: actor.id, action: "buyer.address_updated", entityType: "User", entityId: actor.id });
  });
  return getBuyerCheckoutProfile(db, actor);
}
