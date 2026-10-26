import type { Metadata } from "next";
import { ProsePage } from "@/components/site/prose-page";

export const metadata: Metadata = { title: "Termos de uso" };

export default function TermsPage() {
  return (
    <ProsePage title="Termos de uso" notice="Rascunho técnico para desenvolvimento. O texto definitivo deve ser redigido e revisado por assessoria jurídica antes do lançamento.">
      <h2>1. O serviço</h2>
      <p>O Evento Brasil é um marketplace que conecta organizadores de eventos a compradores. A realização, o conteúdo e a segurança de cada evento são de responsabilidade do organizador indicado na página do evento.</p>
      <h2>2. Compra e pagamento</h2>
      <p>Os pagamentos são processados por instituição de pagamento parceira. Os ingressos só são emitidos após a confirmação do pagamento pelo provedor.</p>
      <h2>3. Taxas</h2>
      <p>Taxas aplicáveis são exibidas antes da conclusão da compra.</p>
      <h2>4. Reembolsos e cancelamentos</h2>
      <p>Aplicam-se a política do evento e a legislação de defesa do consumidor vigente.</p>
      <h2>5. Ingressos</h2>
      <p>Cada ingresso possui QR code de uso único. O compartilhamento indevido pode resultar na perda do acesso.</p>
    </ProsePage>
  );
}
