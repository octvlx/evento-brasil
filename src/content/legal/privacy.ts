import { COMPANY, COMPANY_IDENTIFICATION } from "./company";
import type { LegalDocument } from "./types";

// Política de privacidade (LGPD). Os prazos de retenção vêm de src/server/retention.ts
// (provisórios até a decisão D6); tests/unit/legal-documents.test.ts confere a coerência.

export const PRIVACY_POLICY: LegalDocument = {
  kind: "PRIVACY",
  title: "Política de privacidade",
  version: "1.0",
  path: "/privacidade",
  updatedAt: "2026-11-23",
  sections: [
    {
      title: "1. Quem trata seus dados",
      blocks: [
        COMPANY_IDENTIFICATION,
        "A TICKET24 é a controladora dos dados pessoais tratados na plataforma, nos termos da Lei Geral de Proteção de Dados (Lei nº 13.709/2018, LGPD). Quando um organizador recebe dados para realizar o evento, ele também passa a ser controlador do uso que fizer deles.",
        `Encarregado pelo tratamento de dados (DPO): ${COMPANY.dpoName}, pelo e-mail ${COMPANY.dpoEmail}.`,
      ],
    },
    {
      title: "2. Dados que coletamos",
      blocks: [
        {
          list: [
            "Cadastro: nome, e-mail, senha (guardada só como hash) e, se você quiser, celular. Se você entrar com Google, recebemos nome, e-mail e o identificador da conta Google.",
            "Primeira compra: CPF (guardado cifrado e exibido mascarado), data de nascimento e endereço, que fica salvo para as próximas compras.",
            "Pedidos e ingressos: eventos, ingressos, valores, datas, status de pagamento e reembolso, nome e e-mail do titular e dos participantes nominados, transferências e registros de entrada (check-in).",
            "Pagamento: o identificador do pagamento no Mercado Pago e os dados da cobrança PIX enquanto ela está em aberto. Não recebemos nem guardamos dados de cartão.",
            "Aceite de termos: versão aceita, data, endereço IP e navegador, como prova do aceite.",
            "Organizadores: dados da organização, nome civil ou razão social, CPF ou CNPJ (guardado cifrado), contatos, membros da equipe e a conexão com a conta do Mercado Pago.",
            "Dados técnicos: cookies essenciais e controles contra abuso (como limite de tentativas de login), que guardam apenas um código derivado do IP, apagado em poucas horas.",
          ],
        },
      ],
    },
    {
      title: "3. Para que usamos e com qual base legal",
      blocks: [
        {
          list: [
            "Criar e manter sua conta, vender, emitir, entregar, transferir e validar ingressos, processar pagamentos, cancelamentos e reembolsos: execução do contrato (LGPD, art. 7º, V).",
            "Cumprir obrigações fiscais, contábeis, de defesa do consumidor e da legislação sobre venda de ingressos e meia-entrada: cumprimento de obrigação legal (art. 7º, II).",
            "Prevenir fraudes, uso de robôs e cambismo, e garantir a segurança da conta e da portaria: legítimo interesse (art. 7º, IX) e prevenção à fraude (art. 11, II, \"g\", quando aplicável).",
            "Guardar registros para nos defender ou exercer direitos em processos: exercício regular de direitos (art. 7º, VI).",
            "Enviar mensagens sobre seus pedidos e ingressos: execução do contrato.",
          ],
        },
        "Não vendemos seus dados e não usamos cookies de publicidade.",
      ],
    },
    {
      title: "4. Com quem compartilhamos",
      blocks: [
        {
          list: [
            "Organizador do evento: nome e e-mail do titular, tipo e status do ingresso, registros de entrada e, na meia-entrada, a indicação do benefício. O organizador só pode usar esses dados para realizar o evento e cumprir a lei.",
            "Mercado Pago: dados do pedido necessários ao pagamento e ao reembolso. O Mercado Pago trata os dados de pagamento sob a política de privacidade dele.",
            "Google: quando você escolhe entrar com Google, e Apple ou Google, quando você adiciona o ingresso à carteira digital.",
            "ViaCEP: somente o CEP digitado, para sugerir o endereço.",
            "Fornecedores de infraestrutura: hospedagem do site, banco de dados, armazenamento de arquivos e envio de e-mails, que tratam os dados por nossa conta e sob nossas instruções.",
            "Autoridades: quando a lei ou uma ordem judicial exigir.",
          ],
        },
        "Alguns fornecedores podem tratar dados fora do Brasil. Nesses casos, adotamos as garantias exigidas pelo art. 33 da LGPD.",
      ],
    },
    {
      title: "5. Por quanto tempo guardamos",
      blocks: [
        "Guardamos os dados enquanto forem necessários às finalidades acima e pelos prazos legais. Os prazos atuais são:",
        {
          list: [
            "Nome, e-mail e telefone do comprador, dos participantes e dos titulares nos pedidos e ingressos: até 5 anos após o fim do evento. Depois, os registros são anonimizados e ficam apenas os valores e datas.",
            "Registros de entrada (check-in): 180 dias após o fim do evento.",
            "Dados da cobrança PIX e link de pagamento: 24 horas depois que o pagamento é concluído, expira ou é cancelado.",
            "Notificações recebidas do Mercado Pago: 180 dias.",
            "E-mails enviados: 90 dias.",
            "Histórico de transferências de ingressos: no mínimo 2 anos, como exige a legislação sobre venda de ingressos.",
            "Lançamentos financeiros, repasses, registros de auditoria e aceites de termos: pelo prazo das obrigações legais e para defesa em processos.",
          ],
        },
        "Se você excluir sua conta, apagamos nome, e-mail, celular, CPF e endereço. Os registros de compras e os demais registros acima continuam guardados, sem identificar você, pelos prazos indicados.",
      ],
    },
    {
      title: "6. Seus direitos",
      blocks: [
        "Você pode pedir: confirmação de que tratamos seus dados, acesso, correção, anonimização, bloqueio ou eliminação de dados desnecessários, portabilidade, informação sobre com quem compartilhamos, e revisão de decisões automatizadas (LGPD, art. 18).",
        "Em Minha conta você corrige seus dados, baixa uma cópia deles e exclui a conta. Para os outros pedidos, escreva ao encarregado. Também é possível reclamar à Autoridade Nacional de Proteção de Dados (ANPD).",
        "Alguns dados não podem ser apagados enquanto a lei exigir que sejam guardados, como os registros de compras.",
      ],
    },
    {
      title: "7. Segurança",
      blocks: [
        "Usamos conexão cifrada (HTTPS), senhas guardadas como hash, CPF e CNPJ cifrados, QR codes assinados e de uso único, controle de acesso por papel e registros de auditoria que não podem ser alterados. Nenhum sistema é totalmente imune a falhas: se houver incidente de segurança com risco relevante a você, avisaremos você e a ANPD, como prevê a lei.",
      ],
    },
    {
      title: "8. Cookies",
      blocks: [
        "Usamos apenas cookies essenciais: o de sessão, que mantém você conectado, e os de preferência, como a cidade escolhida. Sem eles o site não funciona corretamente, por isso não pedimos consentimento para eles. Não usamos cookies de publicidade nem de rastreamento entre sites.",
      ],
    },
    {
      title: "9. Crianças e adolescentes",
      blocks: [
        "A plataforma não é destinada a crianças. Dados de crianças e adolescentes, como os de participantes nominados em ingressos, são tratados no seu melhor interesse e apenas para emitir o ingresso e controlar o acesso ao evento.",
      ],
    },
    {
      title: "10. Alterações desta política",
      blocks: [
        "Podemos atualizar esta política. Cada versão tem número e data. Quando houver mudança relevante, pediremos que você leia e aceite a versão nova.",
      ],
    },
  ],
  reviewNotes: [
    "Prazos de retenção provisórios (D6), vindos de src/server/retention.ts: 5 anos para dados de pedidos, 180 dias para check-in etc. Confirmar ou ajustar; mudar o texto e a constante juntos.",
    "Histórico de transferências ≥ 2 anos: regra tirada de fontes secundárias sobre o Decreto nº 13.108/2026; conferir no texto oficial.",
    "Transferência internacional (art. 33): confirmar as regiões dos fornecedores (hospedagem, banco, e-mail) e o mecanismo aplicável; decidir se os fornecedores devem ser nomeados.",
    "Marco Civil da Internet, art. 15: hoje o sistema não guarda registros de acesso (IP) além do aceite de termos. Confirmar se a obrigação se aplica.",
    "Base legal do CPF e da data de nascimento na primeira compra: confirmar a finalidade declarada (identificação, antifraude, nota fiscal).",
    "Organizador como controlador independente dos dados recebidos: confirmar a qualificação e alinhar com os termos do organizador.",
    "Se o Vercel Speed Insights for ativado, mencionar a coleta de métricas de desempenho (sem cookies).",
  ],
};
