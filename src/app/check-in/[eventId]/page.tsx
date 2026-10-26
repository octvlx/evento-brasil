import type { Metadata } from "next";
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
      <Suspense fallback={<Skeleton className="h-[640px]" />}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function Content({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const user = await requireUser(`/check-in/${eventId}`);
  try {
    await resolveCheckinAccess(db, user, eventId);
  } catch (err) {
    if (err instanceof AppError) notFound();
    throw err;
  }
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  const [admitted, total, history] = await Promise.all([
    db.issuedTicket.count({ where: { eventId, status: "CHECKED_IN" } }),
    db.issuedTicket.count({ where: { eventId, status: { in: ["VALID", "CHECKED_IN"] } } }),
    checkinHistory(db, user, eventId, 15),
  ]);
  return (
    <>
      <h1 className="font-display text-2xl font-extrabold leading-tight">{event.title}</h1>
      <p className="mb-4 text-sm text-muted-foreground">Validação online — cada QR só é aceito uma vez.</p>
      <Scanner eventId={eventId} initialCounters={{ admitted, total }} />
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
