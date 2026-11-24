import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { MessageCircleQuestion, ReceiptText, Ticket, Undo2 } from "lucide-react";
import { Card, Skeleton } from "@/components/ui/primitives";
import { helpTopics } from "@/content/help";
import { COMPANY } from "@/content/legal/company";
import { HelpCenter } from "@/features/help/help-center";
import { CancellationRequestForm } from "@/features/orders/cancellation-form";
import { CancellationRequestList } from "@/features/orders/cancellation-list";
import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { listMyCancellationRequests, PROVISIONAL_CANCELLATION_RESPONSE_DAYS } from "@/server/services/cancellation-requests";
import { formatDateShort } from "@/lib/datetime";

export const metadata: Metadata = {
  title: "Central de ajuda",
  description: "Respostas sobre compra, ingressos, transferência, cancelamento, reembolso, meia-entrada e taxas na TICKET24.",
};

// Âncoras usadas por links do site: #cancelamento (CANCEL_HELP_HREF), #transferencia,
// #taxas e #contato (rodapé) e #solicitar-cancelamento (pedido com protocolo).

const SHORTCUTS = [
  { href: "/meus-ingressos", icon: Ticket, title: "Meus ingressos", text: "QR code, carteira digital e transferência" },
  { href: "/meus-pedidos", icon: ReceiptText, title: "Meus pedidos", text: "Pagamento, reembolso e comprovante" },
  { href: "#cancelamento", icon: Undo2, title: "Cancelar compra", text: "Arrependimento e reembolso" },
  { href: "#contato", icon: MessageCircleQuestion, title: "Falar com a gente", text: "Cancelamento com protocolo e atendimento" },
] as const;

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <header>
        <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Central de ajuda</h1>
        <p className="mt-2 text-muted-foreground">Como podemos ajudar? Busque uma dúvida ou escolha um tema.</p>
      </header>

      <nav aria-label="Atalhos" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SHORTCUTS.map(({ href, icon: Icon, title, text }) => (
          <Link key={href} href={href} className="flex items-start gap-3 rounded-2xl bg-night p-4 text-white transition-opacity hover:opacity-90">
            <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-accent" />
            <span>
              <span className="block font-semibold">{title}</span>
              <span className="block text-xs text-white/70">{text}</span>
            </span>
          </Link>
        ))}
      </nav>

      <div className="mt-10">
        <HelpCenter topics={helpTopics()} />
      </div>

      <section id="contato" className="mt-12 scroll-mt-24">
        <h2 className="font-display text-xl font-bold">Ainda precisa de ajuda?</h2>
        <Card className="mt-3 space-y-4 p-5">
          <div id="solicitar-cancelamento" className="scroll-mt-24">
            <h3 className="font-display text-lg font-bold">Pedido de cancelamento</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Para cancelar uma compra que não se encaixa no reembolso automático. Você recebe um <strong>número de protocolo</strong> e a resposta sai em até{" "}
              {PROVISIONAL_CANCELLATION_RESPONSE_DAYS} dias. Também dá para pedir pela página do pedido.
            </p>
            <div className="mt-3">
              <Suspense fallback={<Skeleton className="h-24" />}>
                <MyCancellations />
              </Suspense>
            </div>
          </div>
          <div className="border-t border-border pt-4">
            <h3 className="font-display text-lg font-bold">Outros assuntos</h3>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="support-email">
              Para qualquer outro assunto, escreva para{" "}
              <a href={`mailto:${COMPANY.supportEmail}`} className="font-semibold text-foreground underline underline-offset-4">
                {COMPANY.supportEmail}
              </a>
              . Se for sobre uma compra, informe o código do pedido, que aparece em Meus pedidos.
            </p>
          </div>
        </Card>
      </section>
    </div>
  );
}

/** Formulário de pedido de cancelamento com protocolo (L5b) e os pedidos já feitos, para quem está logado. */
async function MyCancellations() {
  const user = await getCurrentUser();
  if (!user)
    return (
      <p>
        <Link href={`/entrar?next=${encodeURIComponent("/ajuda#solicitar-cancelamento")}`} className="font-semibold text-secondary hover:underline">
          Entre na sua conta
        </Link>{" "}
        para pedir o cancelamento e acompanhar o protocolo.
      </p>
    );
  const [requests, orders] = await Promise.all([
    listMyCancellationRequests(db, user),
    db.order.findMany({
      where: { userId: user.id, status: { in: ["PAID", "PENDING_PAYMENT"] }, cancellations: { none: { status: "OPEN" } } },
      select: { id: true, publicCode: true, createdAt: true, event: { select: { title: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return (
    <div className="space-y-4">
      {orders.length > 0 ? (
        <CancellationRequestForm
          orders={orders.map((o) => ({ id: o.id, label: `${o.publicCode} · ${o.event.title} · ${formatDateShort(o.createdAt)}` }))}
          responseDays={PROVISIONAL_CANCELLATION_RESPONSE_DAYS}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Você não tem pedidos pagos ou aguardando pagamento para cancelar.</p>
      )}
      {requests.length > 0 && (
        <>
          <p className="font-semibold">Meus pedidos de cancelamento</p>
          <CancellationRequestList items={requests} showOrder />
        </>
      )}
    </div>
  );
}
