"use server";

// Prévia da equipe durante a manutenção (docs/manutencao.md): o admin liga aqui e o
// proxy deixa o navegador dele passar por todo o site até o cookie vencer ou ele sair.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "@/server/audit";
import { requireAdmin } from "@/server/auth/current";
import { db } from "@/server/db";
import { env } from "@/server/env";
import {
  MAINTENANCE_PREVIEW_COOKIE,
  MAINTENANCE_PREVIEW_HOURS,
  maintenanceConfig,
  signMaintenancePreview,
} from "@/server/maintenance";

export async function startMaintenancePreviewAction() {
  const admin = await requireAdmin();
  if (!maintenanceConfig().enabled) redirect("/admin");
  const expiresAt = new Date(Date.now() + MAINTENANCE_PREVIEW_HOURS * 3_600_000);
  (await cookies()).set(MAINTENANCE_PREVIEW_COOKIE, signMaintenancePreview(admin.id, expiresAt, env().AUTH_SECRET), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  await audit(db, {
    actorUserId: admin.id,
    action: "MAINTENANCE_PREVIEW_STARTED",
    entityType: "User",
    entityId: admin.id,
    metadata: { expiresAt: expiresAt.toISOString() },
  });
  redirect("/");
}

export async function stopMaintenancePreviewAction() {
  await requireAdmin();
  (await cookies()).delete(MAINTENANCE_PREVIEW_COOKIE);
  redirect("/admin");
}
