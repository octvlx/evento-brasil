// Aviso para páginas do painel cujas ações ficam bloqueadas com a organização
// suspensa (assertOrgPermission só libera leitura e financeiro). Sem ele, o serviço
// lança "Esta organização está suspensa" e a página cai na tela genérica de erro.
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { PageTitle } from "@/components/site/panel-shell";
import { db } from "@/server/db";

export async function SuspendedOrganizationNotice({ organizationId, title, blocked }: { organizationId: string; title: string; /** O que não dá para fazer, no infinitivo ("criar ou editar cupons"). */ blocked: string }) {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { statusReason: true } });
  return (
    <>
      <PageTitle title={title} />
      <div role="status" className="flex gap-3 rounded-2xl border border-warning/30 bg-warning-soft p-5 text-sm text-warning">
        <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="space-y-2">
          <p className="font-semibold">Esta organização está suspensa pela plataforma.</p>
          {org?.statusReason && <p>Motivo: {org.statusReason}</p>}
          <p>Enquanto a suspensão durar, não é possível {blocked}. Vendas, repasses e participantes continuam disponíveis para consulta.</p>
          <p>
            <Link href="/ajuda#contato" className="font-semibold underline underline-offset-2">
              Fale com o atendimento
            </Link>{" "}
            para resolver.
          </p>
        </div>
      </div>
    </>
  );
}
