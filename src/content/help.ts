// Conteúdo da Central de ajuda (/ajuda): temas com perguntas e respostas. Os prazos vêm
// das mesmas constantes que o sistema aplica, para o texto não ficar desatualizado.
// tests/unit/help-content.test.ts confere âncoras e links.
import "server-only";
import { PUBLISH_EVENT_INFO_HREF } from "@/lib/help-links";
import { DEFAULT_TRANSFER_POLICY, TRANSFER_ACCEPT_WINDOW_HOURS } from "@/lib/transfer-policy";
import { env } from "@/server/env";
import { PROVISIONAL_CANCELLATION_RESPONSE_DAYS } from "@/server/services/cancellation-requests";
import { ARREPENDIMENTO_DAYS, DEFAULT_REFUND_POLICY } from "@/server/services/refunds";

export interface HelpLink {
  href: string;
  label: string;
}

export interface HelpQuestion {
  /** Âncora da pergunta (/ajuda#<id>). */
  id: string;
  question: string;
  /** Parágrafos da resposta. */
  answer: string[];
  links?: HelpLink[];
}

export type HelpTopicId = "comprar" | "ingressos" | "transferencia" | "cancelamento" | "meia-entrada" | "taxas" | "conta" | "organizadores";

export interface HelpTopic {
  /** Âncora do tema. "cancelamento", "transferencia" e "taxas" são usadas por links do site. */
  id: HelpTopicId;
  title: string;
  summary: string;
  questions: HelpQuestion[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function helpTopics(): HelpTopic[] {
  const reservationMinutes = env().RESERVATION_MINUTES;
  const { transferDeadlineHours, transferMaxTransfers } = DEFAULT_TRANSFER_POLICY;
  const { refundWindowDays, refundMinHoursBeforeEvent } = DEFAULT_REFUND_POLICY;

  return [
    {
      id: "comprar",
      title: "Comprar ingressos",
      summary: "Reserva, pagamento e confirmação do pedido.",
      questions: [
        {
          id: "como-comprar",
          question: "Como eu compro um ingresso?",
          answer: [
            "Na página do evento, escolha o tipo e a quantidade de ingressos e toque em comprar. Você precisa estar com a conta criada e o e-mail confirmado.",
            `Os ingressos ficam reservados por ${plural(reservationMinutes, "minuto", "minutos")} enquanto você paga, com uma contagem regressiva na tela. Nesse tempo, o preço não muda.`,
          ],
        },
        {
          id: "formas-de-pagamento",
          question: "Quais são as formas de pagamento?",
          answer: [
            "PIX e cartão, pelo Mercado Pago. O pagamento acontece no ambiente do próprio Mercado Pago: a TICKET24 não recebe nem guarda os dados do seu cartão.",
          ],
        },
        {
          id: "paguei-e-nao-recebi",
          question: "Paguei, mas o ingresso não apareceu. E agora?",
          answer: [
            "O ingresso só é emitido quando o Mercado Pago confirma o pagamento. No PIX isso costuma levar poucos segundos; no cartão, a análise pode levar alguns minutos.",
            "Veja a situação na página do pedido, em Meus pedidos. Confira também a caixa de spam do seu e-mail. Se o pagamento foi confirmado e o ingresso não aparece, fale com o atendimento informando o código do pedido.",
          ],
          links: [
            { href: "/meus-pedidos", label: "Meus pedidos" },
            { href: "#contato", label: "Falar com o atendimento" },
          ],
        },
        {
          id: "pedido-expirou",
          question: "O meu pedido expirou. Fui cobrado?",
          answer: [
            "Não. Se o pagamento não é confirmado até o fim da reserva, o pedido expira, nada é cobrado e os ingressos voltam a ficar disponíveis. Você pode fazer um pedido novo.",
            "Se o pagamento for confirmado depois que o pedido expirou, os ingressos são emitidos se ainda houver disponibilidade. Se tiverem esgotado, o valor é devolvido automaticamente.",
          ],
        },
        {
          id: "dados-na-primeira-compra",
          question: "Por que pedem CPF e endereço na primeira compra?",
          answer: [
            "Para identificar quem compra e prevenir fraudes. O CPF é guardado cifrado e aparece mascarado na tela. O endereço fica salvo para as próximas compras, e você pode corrigi-lo na revisão da compra.",
          ],
          links: [{ href: "/privacidade", label: "Política de privacidade" }],
        },
        {
          id: "limite-por-conta",
          question: "Existe limite de ingressos por pessoa?",
          answer: ["Sim, quando o organizador define. O limite por pedido e por conta aparece na página do evento e vale também para ingressos recebidos por transferência."],
        },
      ],
    },
    {
      id: "ingressos",
      title: "Ingressos e entrada",
      summary: "Onde ficam os ingressos e como entrar no evento.",
      questions: [
        {
          id: "onde-estao-meus-ingressos",
          question: "Onde estão os meus ingressos?",
          answer: ["Em Meus ingressos, na sua conta. Você também recebe um e-mail de confirmação com o link para cada ingresso."],
          links: [{ href: "/meus-ingressos", label: "Meus ingressos" }],
        },
        {
          id: "como-entrar",
          question: "Como eu entro no evento?",
          answer: [
            "Abra o ingresso no celular e mostre o QR code na entrada. Ele muda a cada 30 segundos, então a equipe lê o código ao vivo, na sua tela.",
            "Você também pode adicionar o ingresso à Apple Wallet ou ao Google Wallet, quando o botão aparecer na página do ingresso.",
            "Leve o celular com bateria e abra o ingresso antes de chegar à fila.",
          ],
        },
        {
          id: "print-ou-pdf",
          question: "Posso entrar com print, foto ou o PDF do ingresso?",
          answer: [
            "Não. Como o QR code muda a cada 30 segundos, prints, fotos, impressões e o PDF não são aceitos na entrada. O PDF serve como comprovante da compra.",
          ],
        },
        {
          id: "uso-unico",
          question: "O ingresso pode ser usado mais de uma vez?",
          answer: ["Não. Cada ingresso vale uma entrada: a primeira leitura válida registra o uso, e as seguintes são recusadas."],
        },
        {
          id: "documento-na-entrada",
          question: "Preciso levar documento?",
          answer: [
            "O organizador pode pedir documento de identidade na entrada e definir idade mínima. Confira as informações na página do evento. Na meia-entrada, o comprovante do benefício é obrigatório.",
          ],
        },
      ],
    },
    {
      id: "transferencia",
      title: "Transferir ingresso",
      summary: "Passar o ingresso para outra pessoa, de graça.",
      questions: [
        {
          id: "como-transferir",
          question: "Como transfiro um ingresso para outra pessoa?",
          answer: [
            "Em Meus ingressos, abra o ingresso e escolha transferir. A pessoa precisa ter conta na TICKET24 e aceitar a transferência. A transferência é sempre gratuita.",
            `O convite pode ser aceito por até ${plural(TRANSFER_ACCEPT_WINDOW_HOURS, "hora", "horas")}, dentro do prazo do evento. Enquanto não for aceito, você pode cancelá-lo.`,
          ],
          links: [{ href: "/meus-ingressos", label: "Meus ingressos" }],
        },
        {
          id: "prazo-de-transferencia",
          question: "Até quando posso transferir?",
          answer: [
            `Cada evento define as próprias regras, mostradas na página do evento e no ingresso. Por padrão, o pedido e o aceite devem acontecer até ${plural(transferDeadlineHours, "hora", "horas")} antes do início, com no máximo ${plural(transferMaxTransfers, "transferência aceita", "transferências aceitas")} por ingresso.`,
            "Ingressos já usados, com reembolso em andamento ou de eventos encerrados não podem ser transferidos.",
          ],
        },
        {
          id: "depois-de-aceitar",
          question: "O que acontece depois que a pessoa aceita?",
          answer: [
            "O ingresso passa para a conta dela com um QR code novo. O QR anterior, o PDF e os passes de carteira salvos antes deixam de valer.",
            "Não há como desfazer. Se o evento permitir devolução, ela é uma nova transferência, iniciada por quem está com o ingresso. Um eventual reembolso continua voltando para quem pagou o pedido.",
          ],
        },
      ],
    },
    {
      id: "cancelamento",
      title: "Cancelar compra e reembolso",
      summary: "Arrependimento, política do evento e estorno.",
      questions: [
        {
          id: "arrependimento",
          question: `Posso desistir da compra em até ${ARREPENDIMENTO_DAYS} dias?`,
          answer: [
            `Sim. Até ${ARREPENDIMENTO_DAYS} dias depois do pagamento, antes do início do evento, você recebe o reembolso integral, com a taxa de serviço, qualquer que seja a política do evento. É o direito de arrependimento do Código de Defesa do Consumidor.`,
            "Basta que nenhum ingresso do pedido tenha sido usado na entrada.",
          ],
        },
        {
          id: "como-pedir-reembolso",
          question: "Como peço o reembolso?",
          answer: [
            "Em Meus pedidos, abra o pedido e toque em \"Solicitar reembolso\". Os ingressos do pedido são cancelados na hora, e a página mostra o andamento do estorno.",
            "Pedidos de valor alto podem passar por uma aprovação antes do estorno.",
          ],
          links: [{ href: "/meus-pedidos", label: "Meus pedidos" }],
        },
        {
          id: "depois-de-7-dias",
          question: `E depois dos ${ARREPENDIMENTO_DAYS} dias?`,
          answer: [
            `Vale a política do evento, mostrada na página dele: até quantos dias depois da compra e até quantas horas antes do início o reembolso é aceito. O padrão de um evento novo é ${plural(refundWindowDays, "dia", "dias")} após a compra e ${plural(refundMinHoursBeforeEvent, "hora", "horas")} antes do início, e o organizador pode oferecer prazos maiores.`,
            "Se o evento informar que a parte fixa da taxa de serviço não é reembolsável, essa parte não é devolvida nesse caso. Isso aparece na página do pedido.",
          ],
        },
        {
          id: "evento-cancelado",
          question: "O evento foi cancelado. Preciso pedir o reembolso?",
          answer: ["Não. Quando o evento é cancelado, o reembolso integral, com todas as taxas, é feito automaticamente para todos os compradores."],
        },
        {
          id: "evento-alterado",
          question: "O evento mudou de data ou de local. Tenho direito ao reembolso?",
          answer: [
            "Quando há uma alteração relevante, como data, local ou atração principal, avisamos por e-mail e abrimos um prazo para você pedir o reembolso integral, com todas as taxas, mesmo fora dos prazos normais. O prazo aparece na página do pedido.",
          ],
        },
        {
          id: "prazo-do-estorno",
          question: "Quanto tempo o dinheiro leva para voltar?",
          answer: [
            "O estorno é feito no mesmo meio de pagamento. No PIX, o valor volta para a conta de origem, em geral rapidamente. No cartão, o estorno aparece na fatura conforme o prazo do banco emissor, que pode levar uma ou duas faturas.",
          ],
        },
        {
          id: "pedido-aguardando-pagamento",
          question: "Quero cancelar um pedido que ainda não paguei.",
          answer: ["Na página do pedido, use \"Cancelar pedido\". Nada é cobrado e a reserva é liberada."],
        },
        {
          id: "fora-das-condicoes",
          question: "O meu caso não se encaixa nessas regras. O que faço?",
          answer: [
            `Abra um pedido de cancelamento aqui na Central de ajuda ou na página do pedido. Você recebe um número de protocolo, e a resposta sai em até ${plural(PROVISIONAL_CANCELLATION_RESPONSE_DAYS, "dia", "dias")}.`,
          ],
          links: [{ href: "#solicitar-cancelamento", label: "Pedir cancelamento" }],
        },
      ],
    },
    {
      id: "meia-entrada",
      title: "Meia-entrada",
      summary: "Quem tem direito e o que levar.",
      questions: [
        {
          id: "quem-tem-direito",
          question: "Quem tem direito à meia-entrada?",
          answer: [
            "Estudantes, pessoas com deficiência e seu acompanhante, quando necessário, jovens de baixa renda de 15 a 29 anos, pessoas com 60 anos ou mais e outros grupos previstos em leis estaduais ou municipais. As regras gerais estão na Lei nº 12.933/2013.",
          ],
        },
        {
          id: "comprovante",
          question: "Preciso comprovar na entrada?",
          answer: [
            "Sim. Ao comprar meia-entrada, você declara ter direito ao benefício e precisa mostrar o documento que comprova esse direito na entrada. Sem ele, o organizador pode impedir o acesso com aquele ingresso.",
          ],
        },
        {
          id: "meia-esgotada",
          question: "Por que a meia-entrada esgotou antes da inteira?",
          answer: [
            "A lei garante que 40% dos ingressos fiquem reservados para meia-entrada até 48 horas antes do evento (72 horas em locais com mais de 10.000 lugares). Quando essa cota acaba, a meia pode esgotar antes. Depois do prazo, a cota não vendida pode ser vendida como inteira.",
          ],
        },
      ],
    },
    {
      id: "taxas",
      title: "Taxas",
      summary: "O que é a taxa de serviço e quando ela aparece.",
      questions: [
        {
          id: "taxa-de-servico",
          question: "O que é a taxa de serviço?",
          answer: [
            "É o valor que remunera a TICKET24 pela venda, pelo pagamento e pela emissão dos ingressos. Ela pode ter uma parte percentual e uma parte fixa por ingresso, e varia conforme o evento.",
          ],
        },
        {
          id: "onde-aparece-a-taxa",
          question: "Onde vejo o valor da taxa?",
          answer: [
            "Desde o anúncio. Os cards de eventos, a busca e a página do evento mostram o preço total por ingresso com a taxa discriminada, por exemplo \"R$ 110,00 (R$ 100,00 + R$ 10,00 de taxa)\". É o mesmo valor cobrado no pagamento.",
          ],
        },
        {
          id: "taxa-meia-e-gratuito",
          question: "Meia-entrada e ingresso gratuito pagam taxa?",
          answer: [
            "Ingressos gratuitos e cortesias não têm taxa. Na meia-entrada, a taxa acompanha o preço: a parte percentual incide sobre o valor da meia, e a parte fixa cai à metade.",
          ],
        },
      ],
    },
    {
      id: "conta",
      title: "Conta e dados",
      summary: "Acesso, senha, dados pessoais e exclusão.",
      questions: [
        {
          id: "nao-consigo-entrar",
          question: "Esqueci a senha ou não consigo entrar.",
          answer: [
            "Use \"Esqueci minha senha\" na tela de login para receber um link de troca no seu e-mail. Se você criou a conta com o Google, entre pelo botão do Google.",
          ],
          links: [{ href: "/esqueci-minha-senha", label: "Esqueci minha senha" }],
        },
        {
          id: "confirmar-email",
          question: "Não recebi o e-mail de confirmação.",
          answer: ["Confira a caixa de spam e as abas de promoções. Ao entrar com uma conta ainda não confirmada, a tela mostra o botão \"Reenviar e-mail de confirmação\"."],
        },
        {
          id: "alterar-dados",
          question: "Como altero meus dados?",
          answer: ["Em Minha conta você muda nome e celular. O endereço é corrigido na revisão da próxima compra, e o e-mail é o seu login."],
          links: [{ href: "/minha-conta", label: "Minha conta" }],
        },
        {
          id: "meus-dados",
          question: "Como baixo meus dados ou excluo minha conta?",
          answer: [
            "Em Minha conta você baixa uma cópia dos seus dados e exclui a conta. Ao excluir, nome, e-mail, celular, CPF e endereço são apagados; os registros das compras ficam guardados sem identificar você, pelo prazo que a lei exige.",
          ],
          links: [
            { href: "/minha-conta", label: "Minha conta" },
            { href: "/privacidade", label: "Política de privacidade" },
          ],
        },
      ],
    },
    {
      id: "organizadores",
      title: "Para organizadores",
      summary: "Publicar eventos, receber e fazer o check-in.",
      questions: [
        {
          id: "publicar-evento",
          question: "Como publico um evento?",
          answer: [
            "Cadastre a sua organização, aguarde a aprovação e crie o evento pelo assistente. O evento passa por moderação antes de aparecer no site.",
          ],
          links: [{ href: PUBLISH_EVENT_INFO_HREF, label: "Publique seu evento" }],
        },
        {
          id: "como-recebo",
          question: "Como recebo o dinheiro das vendas?",
          answer: [
            "Você conecta a sua conta do Mercado Pago em Configurações do painel do organizador. Em cada venda, o Mercado Pago divide o valor: a taxa de serviço vai para a TICKET24 e o restante vai direto para a sua conta, conforme os prazos do Mercado Pago.",
          ],
        },
        {
          id: "check-in",
          question: "Como funciona o check-in na portaria?",
          answer: [
            "Convide a sua equipe pelo painel e atribua o papel de portaria. A equipe usa o leitor da TICKET24 no celular, que confere cada QR code ao vivo e impede entradas duplicadas.",
          ],
        },
      ],
    },
  ];
}
