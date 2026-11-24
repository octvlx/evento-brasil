import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { ApplicationForm } from "@/features/organizer/application-form";
import { db } from "@/server/db";
import { getActiveMembership, requireUser } from "@/server/auth/current";
import { cityFormValue } from "@/server/services/cities";
import { maskPhone } from "@/features/organizer/application-steps";

export const metadata: Metadata = { title: "Cadastro de organizador", robots: { index: false } };

export default function OrganizerSignupPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[600px]" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const user = await requireUser("/organizador/cadastro");
  const { active } = await getActiveMembership(user.id);
  // Em análise: a tela "Enviado" explica o que acontece agora (é para lá que o envio leva).
  if (active?.organization.status === "PENDING_REVIEW") redirect("/organizador/cadastro/enviado");
  if (active && !["REJECTED", "DRAFT"].includes(active.organization.status)) redirect("/organizador");
  const org = active ? await db.organization.findUnique({ where: { id: active.organizationId }, include: { city: true } }) : null;
  // Cidade antiga sem código IBGE não encontrada na base: mantém o cityId até o usuário escolher outra.
  const city = org ? cityFormValue(org.city) : null;
  const resubmit = org && ["REJECTED", "DRAFT"].includes(org.status) ? org : null;
  return (
    <>
      <PageTitle title="Venda ingressos na TICKET24" subtitle="Cadastre sua organização em poucos passos. Após a aprovação, você poderá publicar eventos." />
      <ApplicationForm
        userId={user.id}
        resubmitOrganizationId={resubmit?.id}
        rejectionReason={resubmit?.status === "REJECTED" ? (resubmit.statusReason ?? null) : undefined}
        defaults={
          resubmit
            ? {
                name: resubmit.name,
                legalType: resubmit.legalType,
                contactEmail: resubmit.contactEmail,
                contactPhone: resubmit.contactPhone ? maskPhone(resubmit.contactPhone) : undefined,
                websiteUrl: resubmit.websiteUrl ?? undefined,
                instagramHandle: resubmit.instagramHandle ?? undefined,
                cityUf: city?.cityUf || undefined,
                cityIbgeCode: city?.cityIbgeCode || undefined,
                cityName: city?.cityName || undefined,
                cityId: city?.cityIbgeCode ? undefined : (resubmit.cityId ?? undefined),
                description: resubmit.description ?? undefined,
              }
            : { contactEmail: user.email }
        }
      />
    </>
  );
}
