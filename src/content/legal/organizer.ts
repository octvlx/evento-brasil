import { COMPANY, COMPANY_IDENTIFICATION } from "./company";
import type { LegalDocument } from "./types";

// Termos para organizadores: contrato entre a TICKET24 e a organização que vende pela
// plataforma. O aceite é registrado em nome da organização (TermsAcceptance ORGANIZER_SIGNUP).

export const ORGANIZER_TERMS: LegalDocument = {
  kind: "ORGANIZER",
  title: "Termos para organizadores",
  version: "1.1",
  path: "/termos-organizador",
  updatedAt: "2026-11-27",
  sections: [
    {
      title: "1. Partes e objeto",
      blocks: [
        COMPANY_IDENTIFICATION,
        "Estes termos são o contrato entre a TICKET24 e a pessoa física ou jurídica que cadastra uma organização para publicar eventos e vender ingressos na plataforma (\"organizador\"). Quem envia o cadastro declara ter poderes para aceitá-los em nome da organização.",
        "A TICKET24 oferece ao organizador: página do evento, venda de ingressos, intermediação do pagamento com divisão automática dos valores, emissão de ingressos com QR code dinâmico, ferramentas de equipe e de check-in, relatórios e atendimento aos compradores sobre transferências, cancelamentos e reembolsos.",
        "Estes termos se somam aos Termos de uso e à Política de Privacidade, que o organizador também aceita como usuário.",
      ],
    },
    {
      title: "2. Cadastro e verificação",
      blocks: [
        "O organizador informa nome civil ou razão social, CPF ou CNPJ e contatos verdadeiros e os mantém atualizados. A TICKET24 analisa o cadastro e pode aprovar, pedir correções ou recusar. Só organizações aprovadas publicam eventos.",
        "O organizador responde pelos atos dos membros que convidar para a equipe e pelos papéis que atribuir a eles, inclusive a equipe de portaria.",
      ],
    },
    {
      title: "3. Eventos",
      blocks: [
        "O organizador é o único responsável pela realização do evento e por tudo o que publica: descrição, atrações, data, horário, local, capacidade, preços, lotes, classificação etária, regras de acesso, informações de acessibilidade e política de reembolso.",
        "Cabe ao organizador obter e manter alvarás, licenças, autorizações, laudos de segurança e direitos autorais (incluindo o ECAD, quando aplicável), cumprir as normas de segurança, acessibilidade e capacidade do local, e cumprir a legislação de defesa do consumidor e de venda de ingressos.",
        "A TICKET24 pode revisar os eventos antes da publicação e recusar, despublicar ou suspender eventos com informação falsa, conteúdo ilícito ou que violem estes termos.",
        "Alteração relevante de evento com ingressos vendidos (como data, local ou atração principal) precisa ser registrada na plataforma com o motivo. Os compradores são avisados e recebem um prazo para pedir reembolso integral, com todas as taxas.",
        "O cancelamento do evento gera o reembolso integral e automático de todos os compradores, com todas as taxas.",
      ],
    },
    {
      title: "4. Meia-entrada",
      blocks: [
        "O organizador oferece a meia-entrada nos termos da Lei nº 12.933/2013 e do Decreto nº 8.537/2015 e confere os documentos dos beneficiários na entrada.",
        "A plataforma reserva automaticamente a cota legal de 40% dos ingressos elegíveis até 48 horas antes do início do evento (72 horas quando o local tem mais de 10.000 lugares) e disponibiliza o relatório de meia-entrada vendida. O organizador pode oferecer mais meia-entrada que o mínimo legal, nunca menos.",
      ],
    },
    {
      title: "5. Taxa de serviço",
      blocks: [
        "A TICKET24 é remunerada pela taxa de serviço definida na regra de comissão aplicável à organização ou ao evento, com parte percentual, parte fixa por ingresso ou ambas.",
        "A parte fixa por ingresso é sempre paga pelo comprador, somada ao preço e mostrada antes do pagamento. A regra define quem paga a parte percentual: o comprador, somada ao preço, ou o organizador, descontada do valor da venda. A regra também define quem arca com as tarifas do meio de pagamento, se a taxa é devolvida nos reembolsos e se a parte fixa é reembolsável.",
        "A regra vigente é informada ao organizador antes da publicação do evento e vale para as vendas feitas enquanto estiver vigente. Mudanças valem só para vendas futuras.",
        "Ingressos gratuitos e cortesias não têm taxa. Na meia-entrada, a parte percentual incide sobre o valor da meia e a parte fixa é cobrada inteira.",
      ],
    },
    {
      title: "6. Recebimento pelo Mercado Pago",
      blocks: [
        "Para vender ingressos pagos, o organizador conecta a própria conta do Mercado Pago à TICKET24 e autoriza a plataforma a criar cobranças em nome dele. O organizador mantém a conta ativa e regular e aceita os termos e as tarifas do Mercado Pago, que são de responsabilidade dele, salvo se a regra de comissão disser outra coisa.",
        "Em cada venda, o Mercado Pago divide o valor automaticamente: a taxa de serviço vai para a TICKET24 e o restante, menos as tarifas do Mercado Pago, vai para a conta do organizador, sob as regras de prazo e liberação do Mercado Pago. A TICKET24 não guarda o dinheiro do organizador.",
        "Se a autorização for revogada ou expirar, as vendas pagas ficam suspensas até a nova conexão.",
      ],
    },
    {
      title: "7. Reembolsos, contestações e saldo a compensar",
      blocks: [
        "O organizador define a política de reembolso de cada evento, respeitando o direito de arrependimento de 7 dias do Código de Defesa do Consumidor e as demais regras legais. A TICKET24 processa os reembolsos previstos nestes termos e nos Termos de uso, inclusive os decorrentes de cancelamento e de alteração relevante do evento.",
        "No estorno, o Mercado Pago devolve o valor ao comprador debitando a conta do organizador e a da TICKET24 na mesma proporção da divisão original. O organizador mantém saldo suficiente na conta do Mercado Pago para esses estornos e para contestações de compra (chargebacks).",
        "Quando o reembolso retém a parte fixa da taxa de serviço, mas a proporção do Mercado Pago deixa parte desse valor com o organizador, a diferença vira saldo a compensar em favor da TICKET24. Esse saldo aparece no painel de vendas e é descontado automaticamente das vendas seguintes, até metade da parte do organizador em cada venda.",
        "Valores devidos pelo organizador que não puderem ser compensados assim podem ser cobrados pelos meios legais.",
      ],
    },
    {
      title: "8. Ingressos, portaria e transferências",
      blocks: [
        "A entrada só é válida pelo QR code dinâmico lido no leitor da TICKET24 por membro autorizado da equipe. Impressões, capturas de tela e o PDF do ingresso não valem como entrada. O organizador orienta a equipe de portaria e garante conexão adequada no local.",
        "O organizador define, dentro dos limites da plataforma, o prazo para transferência de titularidade e quantas transferências cada ingresso admite. A transferência é sempre gratuita para o comprador.",
      ],
    },
    {
      title: "9. Dados pessoais",
      blocks: [
        "O organizador recebe dados dos participantes (nome, e-mail, tipo e status do ingresso, check-in e indicação de meia-entrada) e se torna controlador do uso que fizer deles. Ele usa esses dados apenas para realizar o evento e cumprir obrigações legais, salvo outra base legal válida, e cumpre a LGPD.",
        "O organizador protege os dados que exportar da plataforma, limita o acesso à equipe que precisa deles, atende os pedidos dos titulares que lhe forem dirigidos e comunica a TICKET24 sem demora sobre incidentes de segurança que envolvam dados obtidos pela plataforma.",
      ],
    },
    {
      title: "10. Condutas proibidas e suspensão",
      blocks: [
        "É proibido publicar eventos inexistentes ou com informação enganosa, vender fora da plataforma ingressos anunciados nela como exclusivos, manipular estoque ou preços, cobrar dos compradores taxas não informadas e usar a plataforma para fins ilícitos.",
        "Em caso de violação, risco de fraude, ordem de autoridade ou falta de saldo para reembolsos, a TICKET24 pode suspender vendas, eventos ou a organização. A suspensão não afasta os reembolsos devidos aos compradores.",
      ],
    },
    {
      title: "11. Responsabilidades",
      blocks: [
        "O organizador responde pela realização do evento e pelos danos causados a compradores, participantes e terceiros por fatos do evento, e ressarce a TICKET24 por valores que ela tiver de pagar por esses fatos, inclusive em ações de consumidores, garantidos o aviso prévio e o direito de defesa.",
        "A TICKET24 responde pelos serviços da plataforma. Ela não responde por lucros cessantes do organizador decorrentes de indisponibilidade temporária, salvo dolo ou culpa grave.",
      ],
    },
    {
      title: "12. Vigência, alterações e encerramento",
      blocks: [
        "Estes termos valem por prazo indeterminado. Qualquer parte pode encerrar a relação a qualquer momento; os eventos com ingressos vendidos continuam regidos por estes termos até a realização, o cancelamento ou o reembolso de todos os compradores.",
        "A TICKET24 pode atualizar estes termos. Cada versão tem número e data, e a versão nova será apresentada ao organizador para aceite. Mudanças na taxa de serviço só valem para vendas futuras.",
      ],
    },
    {
      title: "13. Lei aplicável e foro",
      blocks: [
        `Estes termos são regidos pelas leis brasileiras. Fica eleito o foro da comarca de ${COMPANY.organizerVenue} para as questões entre a TICKET24 e o organizador, ressalvadas as regras de competência que a lei tornar obrigatórias. Contato: ${COMPANY.supportEmail}.`,
      ],
    },
  ],
  reviewNotes: [
    "Organizador como controlador independente (e não operador) dos dados dos participantes: confirmar a qualificação e se é preciso um acordo de tratamento de dados à parte.",
    "Cobrança de saldo devedor não compensado e indenização (seção 11): avaliar a redação e se cabe cláusula penal ou garantia.",
    "Limitação de responsabilidade da TICKET24 perante o organizador (relação entre empresas): confirmar o alcance.",
    "A política de reembolso do evento aceita prazo de 0 dias no formulário, mas desde o PR #196 o arrependimento de 7 dias vale sempre, por cima da política do evento.",
    "Organizador pessoa física: avaliar se alguma cláusula precisa de tratamento diferente.",
  ],
};
