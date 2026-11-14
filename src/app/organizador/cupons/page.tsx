import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { CouponsManager } from "@/features/organizer/coupons-manager";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { listOrganizationCoupons, ORG_COUPON_TIMEZONE } from "@/server/services/coupons";
import { utcToZonedLocalInput } from "@/lib/datetime";

export const metadata: Metadata = { title: "Cupons", robots: { index: false } };

export default function OrganizationCouponsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const { user, org, can } = await requireOrganizer("/organizador/cupons");
  if (!can("event:write")) redirect("/organizador");
  const coupons = await listOrganizationCoupons(db, user, org.id);
  const tz = ORG_COUPON_TIMEZONE;
  return (
    <>
      <PageTitle title="Cupons" subtitle="Cupons válidos em todos os eventos da organização. Para um cupom de um evento só, use a página de gestão do evento." />
      <Card className="p-6">
        <CouponsManager
          eventId={null}
          ticketTypes={[]}
          locked={org.status === "REJECTED" || org.status === "SUSPENDED"}
          items={coupons.map((c) => ({
            ...c,
            validFromLocal: c.validFrom ? utcToZonedLocalInput(c.validFrom, tz) : "",
            validUntilLocal: c.validUntil ? utcToZonedLocalInput(c.validUntil, tz) : "",
          }))}
        />
      </Card>
    </>
  );
}
