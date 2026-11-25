// Suporte (users:manage) não age sobre a conta de outro admin: suspender ou zerar o
// 2FA de um super admin exige admins:manage. Clientes continuam com o suporte.
import type { AdminRole } from "@/generated/prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth/sessions";
import { totpCode, totpStep } from "@/server/auth/totp";
import { hashToken } from "@/server/crypto";
import { adminResetTwoFactor, confirmTotpEnrollment, startTotpEnrollment } from "@/server/services/two-factor";
import { setUserSuspended } from "@/server/services/users";
import { db, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const T0 = new Date();
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const codeAt = (secret: string, when: Date) => totpCode(secret, totpStep(when));
const reason = "Perdeu o celular; identidade confirmada";

let n = 0;
async function enrolledAdmin(roles: AdminRole[]) {
  const user = await db.user.create({
    data: { email: `adm-${++n}-${Date.now()}@test.local`, name: `Admin ${n}`, passwordHash: "x", platformRole: "ADMIN", adminRoles: roles },
  });
  const { secret } = await startTotpEnrollment(db, user.id, T0);
  await confirmTotpEnrollment(db, user.id, codeAt(secret, T0), null, T0);
  return { user: await db.user.findUniqueOrThrow({ where: { id: user.id } }), secret };
}

describe("ações de suporte sobre a conta de outro admin", () => {
  it("suporte não suspende nem zera o 2FA de um super admin; nada muda", async () => {
    const support = await enrolledAdmin(["SUPPORT"]);
    const superAdmin = await enrolledAdmin(["SUPER_ADMIN"]);
    const session = await createSession(db, superAdmin.user.id);

    await expect(setUserSuspended(db, support.user, superAdmin.user.id, true, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      adminResetTwoFactor(db, support.user, superAdmin.user.id, { adminCode: codeAt(support.secret, later(60)), reason }, later(60)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const after = await db.user.findUniqueOrThrow({ where: { id: superAdmin.user.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.totpEnabledAt).not.toBeNull();
    expect(await db.session.count({ where: { tokenHash: hashToken(session.token) } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: { in: ["user.suspended", "mfa.reset_by_admin"] } } })).toBe(0);
  });

  it("suporte também não age sobre admin de outro sub-papel (financeiro)", async () => {
    const support = await enrolledAdmin(["SUPPORT"]);
    const finance = await enrolledAdmin(["FINANCE"]);
    await expect(setUserSuspended(db, support.user, finance.user.id, true, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("suporte continua suspendendo e zerando o 2FA de clientes", async () => {
    const support = await enrolledAdmin(["SUPPORT"]);
    const customer = await makeUser();
    const { secret } = await startTotpEnrollment(db, customer.id, T0);
    await confirmTotpEnrollment(db, customer.id, codeAt(secret, T0), null, T0);
    await adminResetTwoFactor(db, support.user, customer.id, { adminCode: codeAt(support.secret, later(60)), reason }, later(60));
    await setUserSuspended(db, support.user, customer.id, true, "fraude");
    expect(await db.user.findUniqueOrThrow({ where: { id: customer.id } })).toMatchObject({ status: "SUSPENDED", totpEnabledAt: null });
  });

  it("super admin suspende e zera o 2FA de outro admin", async () => {
    const superAdmin = await enrolledAdmin(["SUPER_ADMIN"]);
    const support = await enrolledAdmin(["SUPPORT"]);
    await adminResetTwoFactor(db, superAdmin.user, support.user.id, { adminCode: codeAt(superAdmin.secret, later(60)), reason }, later(60));
    await setUserSuspended(db, superAdmin.user, support.user.id, true, "desligado");
    expect(await db.user.findUniqueOrThrow({ where: { id: support.user.id } })).toMatchObject({ status: "SUSPENDED", totpEnabledAt: null });
  });
});
