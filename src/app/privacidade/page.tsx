import type { Metadata } from "next";
import { ProsePage } from "@/components/site/prose-page";

export const metadata: Metadata = { title: "Política de privacidade" };

export default function PrivacyPage() {
  return (
    <ProsePage title="Política de privacidade (LGPD)" notice="Rascunho técnico. Bases legais, encarregado (DPO), prazos de retenção e operadores devem ser definidos com assessoria jurídica antes do lançamento.">
      <h2>Dados que coletamos</h2>
      <ul>
        <li>Compradores: nome, e-mail e senha para a conta. O celular e sua verificação por SMS são obrigatórios nos novos cadastros. Também tratamos o histórico de pedidos e ingressos e os registros de check-in.</li>
        <li>Organizadores: dados de identificação e CPF/CNPJ (armazenado cifrado), coletados separadamente no cadastro de produtor para análise da organização. Informações adicionais para recebimentos dependem das exigências do provedor de pagamento e das obrigações aplicáveis.</li>
        <li>No checkout, podemos solicitar dados adicionais exigidos pelo provedor de pagamento ou pela emissão fiscal aplicável. Esses dados não fazem parte do cadastro básico de comprador.</li>
        <li>Não armazenamos números de cartão: eles são tratados diretamente pelo provedor de pagamento.</li>
      </ul>
      <h2>Para que usamos</h2>
      <ul>
        <li>Emitir, entregar e validar ingressos; processar pagamentos e reembolsos.</li>
        <li>Prevenir fraudes e cumprir obrigações legais.</li>
        <li>Compartilhar com o organizador do evento os dados necessários para o controle de acesso (nome do participante e status do ingresso).</li>
      </ul>
      <h2>Verificação do celular</h2>
      <p>Com sua autorização específica, usamos a Twilio para enviar e conferir códigos de verificação por SMS. Seu número de celular e o código informado são processados pela Twilio para essa finalidade. Essa autorização não inclui mensagens de marketing.</p>
      <p>Os registros temporários de verificação são mantidos por até 24 horas e depois excluídos. O registro da autorização associada ao cadastro concluído e os registros de segurança seguem a política de retenção, ainda sujeita à definição e revisão jurídica antes do lançamento.</p>
      <p>O uso da Twilio pode envolver processamento de dados fora do Brasil. As condições contratuais e os mecanismos legais aplicáveis a essas transferências precisam ser avaliados antes do lançamento; este rascunho não confirma que essa avaliação foi concluída.</p>
      <h2>Seus direitos</h2>
      <p>Você pode solicitar acesso, correção, portabilidade e exclusão de dados, ressalvadas as informações que precisam ser mantidas por obrigação legal. Canal do encarregado: a definir.</p>
      <h2>Cookies</h2>
      <p>Usamos cookies essenciais de sessão e de preferência de cidade. Não há cookies de publicidade nesta versão.</p>
    </ProsePage>
  );
}
