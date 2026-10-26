import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import QRCode from "qrcode";
import { Download, MapPin } from "lucide-react";
import { Alert, Badge, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { qrPayload } from "@/server/services/tickets";
import { formatDateLong, formatTime, timezoneLabel } from "@/lib/datetime";
import { TICKET_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Ingresso", robots: { index: false } };

export default function TicketPage({ params }: PageProps<"/ingressos/[code]">) {
  return (
    <div className="mx-auto max-w-md px-4 py-8">
      <Suspense fallback={<Skeleton className="h-[560px] rounded-3xl" />}>
        <TicketContent params={params} />
      </Suspense>
    </div>
  );
}

async function TicketContent({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const user = await requireUser(`/ingressos/${code}`);
  const t = await db.issuedTicket.findUnique({
    where: { code },
    include: { ticketType: true, order: { select: { publicCode: true, isSimulated: true } }, event: { include: { venue: { include: { city: true } }, city: true } } },
  });
  // Mesma resposta para inexistente e de outra pessoa (não revela existência).
  if (!t || t.userId !== user.id) notFound();
  const st = TICKET_STATUS[t.status];
  const tz = t.event.timezone;
  const city = t.event.venue?.city ?? t.event.city;
  const svg = t.status === "VALID" ? await QRCode.toString(qrPayload(t), { type: "svg", margin: 1, errorCorrectionLevel: "M" }) : null;

  return (
    <article className="overflow-hidden rounded-3xl border border-border bg-card shadow-xl">
      <div className="bg-hero p-6 text-white">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/70">{t.ticketType.name}</p>
        <h1 className="mt-1 font-display text-2xl font-extrabold leading-tight">{t.event.title}</h1>
        <p className="mt-2 text-sm text-white/85 first-letter:uppercase">
          {formatDateLong(t.event.startsAt, tz)} · {formatTime(t.event.startsAt, tz)} ({timezoneLabel(t.event.startsAt, tz)})
        </p>
        <p className="mt-1 flex items-center gap-1 text-sm text-white/85">
          <MapPin className="size-3.5" aria-hidden /> {t.event.locationType === "ONLINE" ? "Online" : [t.event.venue?.name, city && `${city.name} – ${city.state}`].filter(Boolean).join(", ")}
        </p>
      </div>
      <div className="relative border-t-2 border-dashed border-border p-6 text-center">
        {t.order.isSimulated && <Alert variant="warning" className="mb-4 text-left">Ingresso de teste (pagamento simulado). Sem validade real.</Alert>}
        {svg ? (
          <div className="mx-auto w-64 rounded-2xl bg-white p-3 [&_svg]:h-auto [&_svg]:w-full" role="img" aria-label="QR code do ingresso" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="mx-auto grid size-64 place-items-center rounded-2xl bg-muted text-sm text-muted-foreground">
            {t.status === "CHECKED_IN" ? "Ingresso já utilizado" : "Ingresso cancelado"}
          </div>
        )}
        <p className="mt-4 font-mono text-lg font-bold tracking-[0.2em]">{t.code}</p>
        <div className="mt-2 flex items-center justify-center gap-2">
          <Badge variant={st.tone === "success" ? "success" : st.tone === "danger" ? "danger" : "default"}>{st.label}</Badge>
          <span className="text-xs text-muted-foreground">Pedido {t.order.publicCode}</span>
        </div>
        <p className="mt-3 text-sm">
          Titular: <strong>{t.holderName}</strong>
        </p>
        {t.ticketType.kind === "HALF_PRICE" && <p className="mt-1 text-xs text-warning">Meia-entrada: apresente o documento comprobatório na entrada.</p>}
        {t.status !== "REVOKED" && (
          <a href={`/api/tickets/${t.code}/pdf`} className={buttonVariants({ variant: "outline", className: "mt-5" })}>
            <Download aria-hidden /> Baixar PDF
          </a>
        )}
        <p className="mt-4 text-xs text-muted-foreground">Não compartilhe este QR code: ele é validado uma única vez na entrada.</p>
      </div>
    </article>
  );
}
