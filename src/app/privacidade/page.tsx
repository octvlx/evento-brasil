import type { Metadata } from "next";
import { ProsePage } from "@/components/site/prose-page";

export const metadata: Metadata = { title: "Política de privacidade" };

export default function PrivacyPage() {
  return (
    <ProsePage title="Política de privacidade (LGPD)" notice="Rascunho técnico. Bases legais, encarregado (DPO), prazos de retenção e operadores devem ser definidos com assessoria jurídica antes do lançamento.">
      <h2>Dados que coletamos</h2>
      <ul>
        <li>Compradores: nome e e-mail no cadastro básico, senha quando usada e celular opcional. Para concluir a primeira compra, solicitamos CPF, data de nascimento e endereço. O endereço é salvo para reutilização nas próximas compras. Também tratamos pedidos, ingressos e registros de check-in.</li>
        <li>Organizadores: dados cadastrais e CPF/CNPJ armazenado cifrado no cadastro separado de produtor. Dados adicionais para recebimentos dependem das exigências aplicáveis e do provedor de pagamento.</li>
        <li>Não armazenamos números de cartão: eles são tratados diretamente pelo provedor de pagamento.</li>
      </ul>
      <h2>Para que usamos</h2>
      <ul>
        <li>Emitir, entregar e validar ingressos; processar pagamentos e reembolsos.</li>
        <li>Prevenir fraudes e cumprir obrigações legais.</li>
        <li>Compartilhar com o organizador do evento os dados necessários para o controle de acesso (nome do participante e status do ingresso).</li>
      </ul>
      <h2>Confirmação e endereço</h2>
      <p>Usamos seu e-mail para confirmar o acesso à conta. Quando você escolhe entrar com Google, recebemos os dados necessários para autenticação. Na busca por CEP, somente o CEP é enviado ao ViaCEP; as sugestões podem ser corrigidas manualmente. O CPF é armazenado cifrado e aparece mascarado na revisão da compra.</p>
      <h2>Seus direitos</h2>
      <p>Você pode solicitar acesso, correção, portabilidade e exclusão de dados, ressalvadas as informações que precisam ser mantidas por obrigação legal. Em Minha conta você baixa seus dados e exclui a conta: nome, e-mail, celular, CPF e endereço são apagados, e os registros das compras ficam guardados sem identificação pelo prazo legal. Canal do encarregado: a definir.</p>
      <h2>Cookies</h2>
      <p>Usamos cookies essenciais de sessão e de preferência de cidade. Não há cookies de publicidade nesta versão.</p>
    </ProsePage>
  );
}
