import type { Metadata } from "next";
import { ProsePage } from "@/components/site/prose-page";

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
      <p>Exemplo (comissão descontada do organizador): ingresso de R$ 100,00 → comissão R$ 7,00 → R$ 93,00 ao organizador, antes dos custos do processador de pagamento.</p>
      <h2>Reembolsos</h2>
      <p>Cada evento exibe sua política. Pedidos elegíveis podem ser reembolsados pela página do pedido. Se o evento for cancelado, o reembolso é iniciado automaticamente.</p>
      <h2 id="contato">Atendimento</h2>
      <p>Canal de atendimento a definir antes do lançamento (e-mail e WhatsApp oficiais da empresa).</p>
    </ProsePage>
  );
}
