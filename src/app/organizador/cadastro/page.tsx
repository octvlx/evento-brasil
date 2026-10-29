import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { ApplicationForm } from "@/features/organizer/application-form";
import { db } from "@/server/db";
import { getActiveMembership, requireUser } from "@/server/auth/current";

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
  const cities = await db.city.findMany({ orderBy: [{ state: "asc" }, { name: "asc" }] });
  const org = active ? await db.organization.findUnique({ where: { id: active.organizationId } }) : null;
  return (
    <>
      <PageTitle title="Venda ingressos no Evento Brasil" subtitle="Identifique o responsável pela organização. Esta análise é separada da sua conta de comprador e da verificação para recebimentos." />
      {org?.status === "REJECTED" && (
        <Alert variant="danger" className="mb-6">
          Seu cadastro anterior foi recusado: {org.statusReason ?? "sem motivo informado"}. Corrija os dados e envie novamente.
        </Alert>
      )}
      <Card className="p-6">
        <ApplicationForm
          cities={cities.map((c) => ({ id: c.id, label: `${c.name} – ${c.state}` }))}
          resubmitOrganizationId={org && ["REJECTED", "DRAFT"].includes(org.status) ? org.id : undefined}
          defaults={
            org
              ? { name: org.name, legalType: org.legalType, contactEmail: org.contactEmail, cityId: org.cityId ?? undefined, description: org.description ?? undefined }
              : { contactEmail: user.email }
          }
        />
      </Card>
    </>
  );
}
