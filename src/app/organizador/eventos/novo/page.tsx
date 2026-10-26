import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { EventForm } from "@/features/organizer/event-form";
import { eventFormOptions } from "@/features/organizer/form-data";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";

export const metadata: Metadata = { title: "Novo evento", robots: { index: false } };

export default function NewEventPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[700px]" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const { org, can } = await requireOrganizer("/organizador/eventos/novo");
  if (!can("event:write")) redirect("/organizador");
  const options = await eventFormOptions(db, org.id);
  return (
    <>
      <PageTitle title="Novo evento" subtitle="Comece pelo rascunho; depois cadastre os ingressos e publique." />
      <Card className="p-6">
        <EventForm
          eventId={null}
          {...options}
          defaults={{
            refundPolicy: "Reembolso integral em até 7 dias após a compra, desde que solicitado até 48 horas antes do início do evento. Em caso de cancelamento, reembolso automático.",
          }}
        />
      </Card>
    </>
  );
}
