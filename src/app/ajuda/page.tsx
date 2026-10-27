import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { ProsePage } from "@/components/site/prose-page";
import { refundPolicyFromEnv } from "@/server/services/refunds";

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
      <Suspense fallback={<p>Carregando a política de cancelamento…</p>}>
        <CancellationPolicy />
      </Suspense>
      <h2>Reembolsos</h2>
      <p>Cada evento exibe sua política na página do evento. O pedido de reembolso e o andamento do estorno ficam na página do pedido (veja “Cancelar compra / arrependimento” acima).</p>
      <h2 id="contato">Atendimento</h2>
      <p>Canal de atendimento a definir antes do lançamento (e-mail e WhatsApp oficiais da empresa).</p>
    </ProsePage>
  );
}

/** Prazos lidos da configuração em tempo de requisição — os mesmos que a elegibilidade de reembolso aplica. */
async function CancellationPolicy() {
  await connection();
  const { windowDays, minHoursBeforeEvent } = refundPolicyFromEnv();
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
