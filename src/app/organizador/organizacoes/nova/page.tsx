import type { Metadata } from "next";
import { Suspense } from "react";
import { Alert, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { ApplicationForm } from "@/features/organizer/application-form";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { MAX_PENDING_APPLICATIONS } from "@/server/services/organizers";

export const metadata: Metadata = { title: "Nova organização", robots: { index: false } };

export default function NewOrganizationPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[600px]" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const user = await requireUser("/organizador/organizacoes/nova");
  const pending = await db.organizationMember.count({ where: { userId: user.id, role: "OWNER", organization: { status: "PENDING_REVIEW" } } });
  return (
    <>
      <PageTitle title="Nova organização" subtitle="Você será o responsável (OWNER). A nova organização passa por análise antes de publicar eventos." />
      {pending >= MAX_PENDING_APPLICATIONS && (
        <Alert variant="warning" className="mb-6">
          Você já tem {pending} cadastros aguardando análise — o limite é {MAX_PENDING_APPLICATIONS}. Aguarde a resposta antes de criar outra organização.
        </Alert>
      )}
      <ApplicationForm userId={user.id} defaults={{ contactEmail: user.email }} />
    </>
  );
}
