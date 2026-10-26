import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { Db, Tx } from "./db";

export interface AuditInput {
  actorUserId?: string | null;
  organizationId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
}

export async function audit(client: Db | Tx, input: AuditInput): Promise<void> {
  await client.auditLog.create({ data: { ...input } });
}
