import { createHash } from "node:crypto";
import type { User } from "@/generated/prisma/client";
import { buyerCpfHash } from "@/server/services/buyer-profile";
import { encryptPII } from "@/server/crypto";
import { db } from "./fixtures";

/** Explicit completed-buyer fixture for tests of unrelated public action contracts. */
export async function makeBuyerReady(user: User) {
  const seed = createHash("sha256").update(user.id).digest().readUInt32BE(0) % 1000000000;
  const digits = String(seed).padStart(9, "0").split("").map(Number);
  for (const size of [9, 10]) { const remainder = digits.slice(0, size).reduce((sum, value, index) => sum + value * (size + 1 - index), 0) % 11; digits.push(remainder < 2 ? 0 : 11 - remainder); }
  const cpf = digits.join("");
  return db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), cpfEncrypted: encryptPII(cpf), cpfHash: buyerCpfHash(cpf), cpfLast2: cpf.slice(-2), birthDate: new Date("1995-04-15T00:00:00.000Z"), address: { upsert: { create: { postalCode: "01001000", street: "Praça da Sé", number: "1", district: "Sé", city: "São Paulo", state: "SP" }, update: {} } } } });
}
