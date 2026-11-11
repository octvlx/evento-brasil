import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/primitives";
import { Scanner } from "@/features/checkin/scanner";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { resolveCheckinAccess } from "@/server/auth/permissions";
import { AppError } from "@/server/errors";
import { checkinHistory } from "@/server/services/checkin";
import { formatTime } from "@/lib/datetime";
import { CHECKIN_RESULT } from "@/lib/labels";

export const metadata: Metadata = { title: "Leitor de check-in", robots: { index: false } };

export default function ScannerPage({ params }: PageProps<"/check-in/[eventId]">) {
  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <Link href="/check-in" className={buttonVariants({ variant: "ghost", className: "mb-4" })}>
        <ArrowLeft aria-hidden /> Voltar aos eventos
      </Link>
      <Suspense fallback={<Skeleton className="h-[640px]" />}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function Content({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const user = await requireUser(`/check-in/${eventId}`);
  let canSeeAllHistory = false;
  try {
    ({ canSeeAllHistory } = await resolveCheckinAccess(db, user, eventId));
  } catch (err) {
    if (err instanceof AppError) notFound();
    throw err;
  }
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  const [admitted, total, history, divergences] = await Promise.all([
    db.issuedTicket.count({ where: { eventId, status: "CHECKED_IN" } }),
    db.issuedTicket.count({ where: { eventId, status: { in: ["VALID", "CHECKED_IN"] } } }),
    checkinHistory(db, user, eventId, 15),
    canSeeAllHistory ? db.ticketCheckin.count({ where: { eventId, divergence: { not: null } } }) : 0,
  ]);
  return (
    <>
      <h1 className="font-display text-2xl font-extrabold leading-tight">{event.title}</h1>
      <p className="mb-4 text-sm text-muted-foreground">Validação online — cada QR só é aceito uma vez. Sem internet, o leitor usa a lista baixada e confirma tudo ao reconectar.</p>
      <Scanner eventId={eventId} initialCounters={{ admitted, total }} />
      {divergences > 0 && (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm">
          {divergences === 1 ? "1 leitura offline" : `${divergences} leituras offline`} com divergência entre o aparelho e o servidor.{" "}
          <Link href={`/organizador/participantes?evento=${eventId}#divergencias`} className="font-semibold text-primary underline">
            Conferir
          </Link>
        </p>
      )}
      <section className="mt-8">
        <h2 className="mb-2 text-sm font-bold">Últimas leituras</h2>
        <ul className="divide-y divide-border rounded-2xl border border-border text-sm">
          {history.length === 0 && <li className="p-3 text-muted-foreground">Nenhuma leitura ainda.</li>}
          {history.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-2 p-3">
              <span className="tabular-nums text-muted-foreground">{formatTime(h.scannedAt, event.timezone)}</span>
              <span className="min-w-0 flex-1 truncate">{h.ticket?.holderName ?? "—"}</span>
              <span className={h.result === "ADMITTED" ? "font-semibold text-success" : "font-semibold text-destructive"}>{CHECKIN_RESULT[h.result]}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
