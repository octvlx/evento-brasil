import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { ApplicationSubmitted } from "@/features/organizer/application-submitted";
import { db } from "@/server/db";
import { getActiveMembership, requireUser } from "@/server/auth/current";

export const metadata: Metadata = { title: "Cadastro enviado", robots: { index: false } };

export default function OrganizerApplicationSentPage() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto h-[420px] max-w-2xl" />}>
      <Content />
    </Suspense>
  );
}

/** Só com a organização ativa em análise; outros status seguem para onde fazem sentido. */
async function Content() {
  const user = await requireUser("/organizador/cadastro/enviado");
  const { active } = await getActiveMembership(user.id);
  if (!active || ["REJECTED", "DRAFT"].includes(active.organization.status)) redirect("/organizador/cadastro");
  if (active.organization.status !== "PENDING_REVIEW") redirect("/organizador");
  const submissions = await db.organizerVerification.count({ where: { organizationId: active.organizationId } });
  return (
    <>
      <PageTitle title={active.organization.name} subtitle="Cadastro de organizador" />
      <ApplicationSubmitted name={active.organization.name} resubmitted={submissions > 1} />
    </>
  );
}
