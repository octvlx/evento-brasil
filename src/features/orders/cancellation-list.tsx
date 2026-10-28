import Link from "next/link";
import type { CancellationRequestStatus } from "@/generated/prisma/client";
import { Badge } from "@/components/ui/primitives";
import { formatDateShort, formatDateTimeShort } from "@/lib/datetime";
import { WithdrawCancellationButton } from "./cancellation-form";

export const CANCELLATION_STATUS: Record<CancellationRequestStatus, { label: string; tone: "default" | "success" | "warning" | "danger" }> = {
  OPEN: { label: "Em análise", tone: "warning" },
  APPROVED: { label: "Aprovado", tone: "success" },
  REJECTED: { label: "Recusado", tone: "danger" },
  WITHDRAWN: { label: "Desistência", tone: "default" },
};

export interface CancellationRequestItem {
  id: string;
  protocol: string;
  status: CancellationRequestStatus;
  reason: string;
  createdAt: Date;
  respondBy: Date | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  orderId: string;
  order?: { publicCode: string };
  event?: { title: string };
}

/** Pedidos de cancelamento do comprador (página do pedido, /ajuda e /meus-pedidos). */
export function CancellationRequestList({ items, showOrder = false }: { items: CancellationRequestItem[]; showOrder?: boolean }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-3" data-testid="cancellation-requests">
      {items.map((r) => {
        const st = CANCELLATION_STATUS[r.status];
        return (
          <li key={r.id} className="space-y-1 rounded-2xl border border-border p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold">{r.protocol}</span>
              <Badge variant={st.tone}>{st.label}</Badge>
              {showOrder && r.order && (
                <Link href={`/pedido/${r.orderId}`} className="text-secondary hover:underline">
                  Pedido {r.order.publicCode}
                  {r.event ? ` · ${r.event.title}` : ""}
                </Link>
              )}
            </div>
            <p className="text-muted-foreground">
              Aberto em {formatDateShort(r.createdAt)}
              {r.status === "OPEN" && r.respondBy && <> · resposta até {formatDateTimeShort(r.respondBy)}</>}
              {r.status !== "OPEN" && r.decidedAt && <> · respondido em {formatDateShort(r.decidedAt)}</>}
            </p>
            <p>
              <span className="text-muted-foreground">Motivo:</span> {r.reason}
            </p>
            {r.decisionNote && (
              <p>
                <span className="text-muted-foreground">Resposta:</span> {r.decisionNote}
              </p>
            )}
            {r.status === "APPROVED" && <p className="text-muted-foreground">O reembolso aparece no quadro “Reembolso” da página do pedido.</p>}
            {r.status === "OPEN" && <WithdrawCancellationButton requestId={r.id} />}
          </li>
        );
      })}
    </ul>
  );
}
