import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeft, QrCode } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/primitives";
import { db } from "@/server/db";
import { getActiveMembership, requireUser } from "@/server/auth/current";
import { roleHas } from "@/server/auth/permissions";
import { formatEventDateTime } from "@/lib/datetime";

export const metadata: Metadata = { title: "Check-in", robots: { index: false } };

export default function CheckinListPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Suspense fallback={<Skeleton className="mt-6 h-64" />}>
        <Content />
      </Suspense>
    </div>
  );
}

/** Eventos em que o usuário pode fazer check-in (até 12h após o término). */
async function checkinEvents(userId: string) {
  const memberships = await db.organizationMember.findMany({ where: { userId } });
  const fullAccessOrgs = memberships.filter((m) => roleHas(m.role, "checkin:history")).map((m) => m.organizationId);
  return db.event.findMany({
    where: {
      status: { in: ["PUBLISHED", "COMPLETED"] },
      endsAt: { gt: new Date(Date.now() - 12 * 3_600_000) },
      OR: [{ organizationId: { in: fullAccessOrgs } }, { staffAssignments: { some: { userId } } }],
    },
    orderBy: { startsAt: "asc" },
    include: { organization: { select: { name: true } } },
  });
}

async function Content() {
  const user = await requireUser("/check-in");
  const [{ memberships }, events] = await Promise.all([getActiveMembership(user.id), checkinEvents(user.id)]);
  const isOrganizer = memberships.some((m) => m.role !== "CHECKIN_STAFF");
  return (
    <>
      <Link href={isOrganizer ? "/organizador" : "/"} className={buttonVariants({ variant: "ghost", className: "mb-4" })}>
        <ArrowLeft aria-hidden /> {isOrganizer ? "Voltar ao painel do organizador" : "Voltar ao início"}
      </Link>
      <h1 className="font-display text-3xl font-extrabold tracking-tight">Check-in</h1>
      {!events.length && <p className="mt-6 text-muted-foreground">Nenhum evento atribuído a você no momento.</p>}
      <ul className="mt-6 space-y-3">
        {events.map((e) => (
          <li key={e.id}>
            <Link href={`/check-in/${e.id}`} className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4 hover:border-secondary">
              <QrCode className="size-8 text-secondary" aria-hidden />
              <div>
                <p className="font-semibold">{e.title}</p>
                <p className="text-sm text-muted-foreground">
                  {formatEventDateTime(e.startsAt, e.timezone)} · {e.organization.name}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
