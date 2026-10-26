import type { Metadata } from "next";
import { ProsePage } from "@/components/site/prose-page";

export const metadata: Metadata = { title: "Política de privacidade" };

export default function PrivacyPage() {
  return (
    <ProsePage title="Política de privacidade (LGPD)" notice="Rascunho técnico. Bases legais, encarregado (DPO), prazos de retenção e operadores devem ser definidos com assessoria jurídica antes do lançamento.">
      <h2>Dados que coletamos</h2>
      <ul>
        <li>Compradores: nome, e-mail, celular (opcional), histórico de pedidos e ingressos, registros de check-in.</li>
        <li>Organizadores: dados cadastrais e CPF/CNPJ (armazenado cifrado), necessários para repasses e obrigações fiscais.</li>
        <li>Não armazenamos números de cartão: eles são tratados diretamente pelo provedor de pagamento.</li>
      </ul>
      <h2>Para que usamos</h2>
      <ul>
        <li>Emitir, entregar e validar ingressos; processar pagamentos e reembolsos.</li>
        <li>Prevenir fraudes e cumprir obrigações legais.</li>
        <li>Compartilhar com o organizador do evento os dados necessários para o controle de acesso (nome do participante e status do ingresso).</li>
      </ul>
      <h2>Seus direitos</h2>
      <p>Você pode solicitar acesso, correção, portabilidade e exclusão de dados, ressalvadas as informações que precisam ser mantidas por obrigação legal. Canal do encarregado: a definir.</p>
      <h2>Cookies</h2>
      <p>Usamos cookies essenciais de sessão e de preferência de cidade. Não há cookies de publicidade nesta versão.</p>
    </ProsePage>
  );
}
