import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Building2, Plus } from "lucide-react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle } from "@/components/site/panel-shell";
import { switchOrganizationAction } from "@/features/organizer/actions";
import { db } from "@/server/db";
import { getActiveMembership, requireUser } from "@/server/auth/current";
import { listMyOrganizations } from "@/server/services/organizers";
import { formatDateShort } from "@/lib/datetime";
import { ORG_ROLE, ORG_STATUS, PAYMENT_ACCOUNT_STATUS, toneToBadge } from "@/lib/labels";

export const metadata: Metadata = { title: "Minhas organizações", robots: { index: false } };

export default function OrganizationsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const user = await requireUser("/organizador/organizacoes");
  const orgs = await listMyOrganizations(db, user);
  if (!orgs.length) redirect("/organizador/cadastro");
  const { active } = await getActiveMembership(user.id);

  return (
    <>
      <PageTitle
        title="Minhas organizações"
        subtitle="Cada organização tem eventos, equipe e financeiro separados."
        actions={
          <Link href="/organizador/organizacoes/nova" className={buttonVariants({ variant: "accent" })}>
            <Plus aria-hidden /> Nova organização
          </Link>
        }
      />
      <ul className="grid gap-4 md:grid-cols-2">
        {orgs.map((o) => {
          const st = ORG_STATUS[o.status];
          const isActive = o.id === active?.organizationId;
          return (
            <li key={o.id} className={`rounded-2xl border bg-card p-5 ${isActive ? "border-secondary ring-2 ring-secondary/30" : "border-border"}`}>
              <div className="flex items-start gap-3">
                <span className="bg-hero grid size-11 shrink-0 place-items-center rounded-xl font-display text-lg font-extrabold text-white" aria-hidden>
                  {o.name.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-display text-lg font-bold">{o.name}</h2>
                  <p className="text-xs text-muted-foreground">
                    {o.city ? `${o.city.name} – ${o.city.state} · ` : ""}desde {formatDateShort(o.createdAt)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge variant={toneToBadge[st.tone]}>{st.label}</Badge>
                    <Badge variant="outline">{ORG_ROLE[o.role]}</Badge>
                    {isActive && <Badge variant="primary">Ativa</Badge>}
                  </div>
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-xl bg-muted p-2">
                  <dt className="text-muted-foreground">Eventos</dt>
                  <dd className="font-bold tabular-nums">{o._count.events}</dd>
                </div>
                <div className="rounded-xl bg-muted p-2">
                  <dt className="text-muted-foreground">Equipe</dt>
                  <dd className="font-bold tabular-nums">{o._count.members}</dd>
                </div>
                <div className="rounded-xl bg-muted p-2">
                  <dt className="text-muted-foreground">Recebimento</dt>
                  <dd className="truncate font-bold">{PAYMENT_ACCOUNT_STATUS[o.paymentAccountStatus].split(" ")[0]}</dd>
                </div>
              </dl>
              {o.status === "REJECTED" && o.statusReason && <p className="mt-3 text-xs text-destructive">Motivo da recusa: {o.statusReason}</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                {!isActive && (
                  <form action={switchOrganizationAction}>
                    <input type="hidden" name="organizationId" value={o.id} />
                    <button className={buttonVariants({ variant: "secondary", size: "sm" })}>
                      <Building2 aria-hidden /> Usar esta organização
                    </button>
                  </form>
                )}
                {o.status === "APPROVED" && (
                  <Link href={`/organizadores/${o.slug}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                    Ver perfil público
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
