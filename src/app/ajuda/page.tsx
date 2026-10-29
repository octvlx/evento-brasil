import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ProsePage } from "@/components/site/prose-page";
import { Skeleton } from "@/components/ui/primitives";
import { CancellationRequestForm } from "@/features/orders/cancellation-form";
import { CancellationRequestList } from "@/features/orders/cancellation-list";
import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { listMyCancellationRequests, PROVISIONAL_CANCELLATION_RESPONSE_DAYS } from "@/server/services/cancellation-requests";
import { DEFAULT_REFUND_POLICY } from "@/server/services/refunds";
import { formatDateShort } from "@/lib/datetime";
import { DEFAULT_TRANSFER_POLICY } from "@/lib/transfer-policy";

export const metadata: Metadata = { title: "Central de ajuda" };

export default function HelpPage() {
  return (
    <ProsePage title="Central de ajuda">
      <h2>Comprando ingressos</h2>
      <ul>
        <li>Escolha os ingressos na página do evento. Eles ficam reservados por alguns minutos enquanto você paga.</li>
        <li>Pague com PIX (ou cartão, quando disponível). Os ingressos são emitidos somente após a confirmação do provedor de pagamento.</li>
        <li>Seus ingressos ficam em “Meus ingressos”, com QR code e PDF, e também chegam por e-mail.</li>
      </ul>
      <h2 id="transferencia">Transferência de ingresso</h2>
      <p>
        A transferência é gratuita. Consulte as regras do evento antes de comprar e em “Meus ingressos”: o organizador define o prazo para solicitar e aceitar,
        o limite de transferências aceitas e se permite devolver o ingresso a um titular anterior.
      </p>
      <p>
        Por padrão, a solicitação e o aceite devem ocorrer até {DEFAULT_TRANSFER_POLICY.transferDeadlineHours} horas antes do início do evento,
        com no máximo {DEFAULT_TRANSFER_POLICY.transferMaxTransfers} transferência aceita por ingresso e sem devolução após o aceite.
        O prazo exato é exibido no fuso do evento. Você pode cancelar um convite que ainda não foi aceito.
      </p>
      <p>
        Depois do aceite, o ingresso e um novo QR code passam para o destinatário. Não há desfazer: quando o evento permite devolução, ela exige uma nova transferência
        iniciada pelo titular atual, o aceite do destinatário e saldo no limite de transferências. Um eventual reembolso continua voltando para quem pagou.
      </p>
      <h2>Meia-entrada</h2>
      <p>Ao escolher meia-entrada, você declara ter direito ao benefício e deve apresentar o documento comprobatório na entrada do evento.</p>
      <h2 id="taxas">Taxas e repasses</h2>
      <p>
        A comissão padrão da plataforma é de 7% sobre o valor de face de cada ingresso pago. Ingressos gratuitos não pagam comissão. Dependendo da configuração do evento, a comissão é descontada do repasse ao
        organizador ou exibida ao comprador como taxa de serviço — sempre antes do pagamento.
      </p>
      <p>
        Quando há taxa de serviço para o comprador, os cards de eventos, a busca, as páginas de cidade e a página do evento mostram o <strong>preço total por ingresso</strong>, com a taxa discriminada — por
        exemplo, “R$ 107,00 (R$ 100,00 + R$ 7,00 de taxa)”. É o mesmo valor cobrado no pagamento.
      </p>
      <p>Exemplo (comissão descontada do organizador): ingresso de R$ 100,00 → comissão R$ 7,00 → R$ 93,00 ao organizador, antes dos custos do processador de pagamento.</p>
      <h2 id="cancelamento">Cancelar compra / arrependimento</h2>
      {/* TODO(jurídico): texto provisório — revisar prazos e redação (CDC art. 49, Decreto nº 13.108/2026; D3 em docs/conformidade-decreto-13108.md). */}
      <p className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">Texto provisório, pendente de revisão jurídica.</p>
      <CancellationPolicy />
      <h3 id="solicitar-cancelamento" className="font-display text-lg font-bold">
        Solicitar cancelamento
      </h3>
      <Suspense fallback={<Skeleton className="h-24" />}>
        <MyCancellations />
      </Suspense>
      <h2>Reembolsos</h2>
      <p>Cada evento exibe sua política na página do evento. O pedido de reembolso e o andamento do estorno ficam na página do pedido (veja “Cancelar compra / arrependimento” acima).</p>
      <h2 id="contato">Atendimento</h2>
      <p>Canal de atendimento a definir antes do lançamento (e-mail e WhatsApp oficiais da empresa).</p>
    </ProsePage>
  );
}

/** Formulário de pedido de cancelamento com protocolo (L5b) e os pedidos já feitos, para quem está logado. */
async function MyCancellations() {
  const user = await getCurrentUser();
  if (!user)
    return (
      <p>
        <Link href={`/entrar?next=${encodeURIComponent("/ajuda#cancelamento")}`} className="font-semibold text-secondary hover:underline">
          Entre na sua conta
        </Link>{" "}
        para pedir o cancelamento de uma compra e acompanhar o protocolo.
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
    <div className="space-y-4 [&_li]:ml-0! [&_li]:list-none!">
      <p>
        Se o seu caso não se encaixa nas condições acima, peça o cancelamento aqui (ou no botão da página do pedido). Você recebe um <strong>número de protocolo</strong> e o prazo de resposta.
      </p>
      <CancellationRequestForm orders={orders.map((o) => ({ id: o.id, label: `${o.publicCode} · ${o.event.title} · ${formatDateShort(o.createdAt)}` }))} responseDays={PROVISIONAL_CANCELLATION_RESPONSE_DAYS} />
      {requests.length > 0 && (
        <>
          <p className="font-semibold">Meus pedidos de cancelamento</p>
          <CancellationRequestList items={requests} showOrder />
        </>
      )}
    </div>
  );
}

/** Prazos padrão de um evento novo; cada evento pode definir os seus (mostrados na página do evento). */
function CancellationPolicy() {
  const { refundWindowDays: windowDays, refundMinHoursBeforeEvent: minHoursBeforeEvent } = DEFAULT_REFUND_POLICY;
  return (
    <>
      <p>
        Você pode desistir de uma compra paga e receber o <strong>reembolso integral</strong> — valor dos ingressos e taxa de serviço, se houver — pelo mesmo meio de pagamento, desde que:
      </p>
      <ul>
        <li>
          o pedido tenha sido pago há no máximo <strong>{windowDays} dias</strong>;
        </li>
        <li>
          faltem pelo menos <strong>{minHoursBeforeEvent} horas</strong> para o início do evento;
        </li>
        <li>nenhum ingresso do pedido tenha sido usado na entrada.</li>
      </ul>
      <p>
        Esses são os prazos padrão. Cada evento pode definir prazos próprios, mostrados na página do evento e aplicados ao seu pedido; depois que há ingressos vendidos, o organizador só pode torná-los mais
        favoráveis a você.
      </p>
      <p>
        <strong>Como pedir:</strong> entre em{" "}
        <Link href="/meus-ingressos" className="font-semibold text-secondary hover:underline">
          Meus ingressos
        </Link>
        , abra o pedido no “Histórico de pedidos” e toque em “Solicitar reembolso”. Os ingressos do pedido são cancelados na hora e a página mostra o andamento do estorno.
      </p>
      <p>
        <strong>Evento cancelado:</strong> o reembolso integral, incluindo a taxa de serviço, é feito automaticamente — você não precisa pedir.
      </p>
      <p>
        <strong>Pedido aguardando pagamento:</strong> use “Cancelar pedido” na página do pedido; nada é cobrado e a reserva é liberada.
      </p>
      <p>
        <strong>Fora dessas condições:</strong> fale com o{" "}
        <a href="#contato" className="font-semibold text-secondary hover:underline">
          atendimento
        </a>{" "}
        informando o código do pedido.
      </p>
    </>
  );
}
