import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { ApplicationForm } from "@/features/organizer/application-form";
import { db } from "@/server/db";
import { getActiveMembership, requireUser } from "@/server/auth/current";
import { cityFormValue } from "@/server/services/cities";
import type { OrganizerApplicationInput } from "@/features/schemas";

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
  if (active && !["REJECTED", "DRAFT"].includes(active.organization.status)) redirect("/organizador");
  const org = active ? await db.organization.findUnique({ where: { id: active.organizationId }, include: { city: true } }) : null;
  // Cidade antiga sem código IBGE não encontrada na base: mantém o cityId até o usuário escolher outra.
  const city = org ? cityFormValue(org.city) : null;
  return (
    <>
      <PageTitle title="Venda ingressos na QQPega" subtitle="Cadastre sua organização. Após a aprovação, você poderá publicar eventos." />
      {org?.status === "REJECTED" && (
        <Alert variant="danger" className="mb-6">
          Seu cadastro anterior foi recusado: {org.statusReason ?? "sem motivo informado"}. Corrija os dados e envie novamente.
        </Alert>
      )}
      <Card className="p-6">
        <ApplicationForm
          resubmitOrganizationId={org && ["REJECTED", "DRAFT"].includes(org.status) ? org.id : undefined}
          defaults={
            org
              ? { name: org.name, legalType: org.legalType, contactEmail: org.contactEmail, cityUf: (city?.cityUf || undefined) as OrganizerApplicationInput["cityUf"], cityIbgeCode: city?.cityIbgeCode || undefined, cityName: city?.cityName || undefined, cityId: city?.cityIbgeCode ? undefined : (org.cityId ?? undefined), description: org.description ?? undefined }
              : { contactEmail: user.email }
          }
        />
      </Card>
    </>
  );
}
