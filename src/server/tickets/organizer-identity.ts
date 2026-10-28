// Identificação do organizador responsável no ingresso (Decreto 13.108/2026, L10b):
// razão social e CNPJ da pessoa jurídica, ou só o nome da pessoa física — o CPF nunca
// é exibido. Vem da verificação APROVADA mais recente (o documento fica cifrado).
import "server-only";
import type { Db, Tx } from "../db";
import { decryptPII } from "../crypto";
import { formatCNPJ } from "@/lib/br";

export interface OrganizerIdentity {
  /** Razão social (PJ), nome civil (PF) ou, sem verificação aprovada, o nome público. */
  name: string;
  /** Só pessoa jurídica, já formatado (00.000.000/0000-00). */
  cnpj: string | null;
}

/** Uma linha: "Razão Social · CNPJ 00.000.000/0000-00" ou só o nome. */
export const organizerIdentityLine = (o: OrganizerIdentity) => (o.cnpj ? `${o.name} · CNPJ ${o.cnpj}` : o.name);

export async function organizerIdentities(client: Db | Tx, organizationIds: string[]): Promise<Map<string, OrganizerIdentity>> {
  const ids = [...new Set(organizationIds)];
  const out = new Map<string, OrganizerIdentity>();
  if (!ids.length) return out;
  const orgs = await client.organization.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      verifications: { where: { status: "APPROVED" }, orderBy: { createdAt: "desc" }, take: 1, select: { legalType: true, legalName: true, documentType: true, documentEncrypted: true } },
    },
  });
  for (const org of orgs) {
    const v = org.verifications[0];
    if (!v) {
      out.set(org.id, { name: org.name, cnpj: null });
      continue;
    }
    let cnpj: string | null = null;
    if (v.legalType === "COMPANY" && v.documentType === "CNPJ") {
      try {
        cnpj = formatCNPJ(decryptPII(v.documentEncrypted));
      } catch (err) {
        // Chave trocada ou dado corrompido: o ingresso sai com a razão social, sem o CNPJ.
        console.error(`[ingresso] não foi possível ler o CNPJ da organização ${org.id}:`, err);
      }
    }
    out.set(org.id, { name: v.legalName, cnpj });
  }
  return out;
}

export async function organizerIdentity(client: Db | Tx, organizationId: string): Promise<OrganizerIdentity | null> {
  return (await organizerIdentities(client, [organizationId])).get(organizationId) ?? null;
}
