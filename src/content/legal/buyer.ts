import { COMPANY, COMPANY_IDENTIFICATION } from "./company";
import type { LegalDocument } from "./types";

// Termos de uso para compradores. Os números (prazos, minutos, horas) refletem as regras
// que o sistema aplica hoje; tests/unit/legal-documents.test.ts confere os que vêm de constantes.

export const BUYER_TERMS: LegalDocument = {
  kind: "BUYER",
  title: "Termos de uso",
  version: "1.1",
  path: "/termos",
  updatedAt: "2026-11-27",
  sections: [
    {
      title: "1. Quem somos e o que estes termos regulam",
      blocks: [
        COMPANY_IDENTIFICATION,
        "Estes termos regulam o uso do site e dos serviços da TICKET24 por quem cria uma conta, compra, recebe ou transfere ingressos. Ao criar a conta ou concluir uma compra, você declara que leu e aceita estes termos e a Política de Privacidade.",
        "Definições usadas aqui:",
        {
          list: [
            "Organizador: pessoa ou empresa que cria o evento, define preços, lotes e regras, e é responsável por realizá-lo.",
            "Comprador: quem paga o pedido.",
            "Titular: quem detém o ingresso. É o comprador, salvo nominação a outra pessoa ou transferência.",
            "Ingresso: direito de acesso ao evento, representado por um QR code dinâmico vinculado à conta do titular.",
          ],
        },
      ],
    },
    {
      title: "2. O papel da TICKET24",
      blocks: [
        "A TICKET24 é uma plataforma de intermediação: divulgamos eventos, vendemos ingressos em nome dos organizadores, intermediamos o pagamento, emitimos os ingressos e oferecemos as ferramentas de transferência, cancelamento e controle de acesso.",
        "O organizador é o responsável pela realização do evento: programação, atrações, local, horários, segurança, acessibilidade, classificação etária, alvarás e licenças, e pelas informações que publica na página do evento.",
        "A TICKET24 responde pelos serviços que presta, nos termos do Código de Defesa do Consumidor. Nada nestes termos afasta os direitos que a lei garante a você.",
      ],
    },
    {
      title: "3. Sua conta",
      blocks: [
        "Para comprar é preciso ter uma conta com e-mail confirmado. Você pode entrar com e-mail e senha ou com sua conta Google.",
        "Na primeira compra pedimos CPF, data de nascimento e endereço. Os dados precisam ser verdadeiros e seus. Menores de 18 anos devem comprar com a assistência de um responsável legal; a idade mínima para entrar em cada evento é definida pelo organizador e informada na página do evento.",
        "A conta é pessoal. Guarde sua senha em sigilo e avise-nos se perceber uso indevido. Você responde pelo que for feito na sua conta enquanto não nos avisar.",
        "Você pode baixar seus dados e excluir sua conta a qualquer momento em Minha conta, como explica a Política de Privacidade.",
      ],
    },
    {
      title: "4. Preço, taxa de serviço e reserva",
      blocks: [
        "Desde o anúncio, mostramos o valor total de cada ingresso com a taxa de serviço discriminada. O valor cobrado é o calculado por nossos servidores no momento da compra, com o detalhamento no resumo do pedido antes do pagamento.",
        "A taxa de serviço remunera a intermediação da TICKET24. Ela pode ter uma parte percentual e uma parte fixa por ingresso. Na meia-entrada, a parte percentual incide sobre o valor da meia e a parte fixa é cobrada inteira. Ingressos gratuitos e cortesias não têm taxa.",
        "Ao iniciar o pagamento, os ingressos ficam reservados por tempo limitado, indicado na tela com uma contagem regressiva, e o preço fica congelado nesse período. Se o pagamento não for confirmado até o fim da reserva, o pedido expira e os ingressos voltam a ficar disponíveis.",
        "Pode haver limite de ingressos por pedido e por conta em cada evento, informado na página do evento.",
      ],
    },
    {
      title: "5. Pagamento",
      blocks: [
        "Os pagamentos são processados pelo Mercado Pago, por PIX ou cartão, no ambiente do próprio Mercado Pago. A TICKET24 não recebe nem guarda os dados do seu cartão.",
        "O pedido só é confirmado, e os ingressos só são emitidos, quando o Mercado Pago confirma o pagamento. Uma tela de \"pagamento em análise\" não significa compra concluída.",
        "Podemos recusar ou cancelar pedidos com indícios de fraude, uso de robôs ou violação destes termos. Se houver cobrança, o valor é devolvido integralmente.",
      ],
    },
    {
      title: "6. Ingressos e entrada no evento",
      blocks: [
        "Os ingressos ficam em Meus ingressos. A entrada é feita pelo QR code dinâmico exibido no site, que muda a cada poucos segundos, ou pelo cartão da carteira digital (Apple Wallet ou Google Wallet), quando disponível.",
        "Capturas de tela, impressões, fotos e o PDF do ingresso não dão acesso ao evento: o QR que vale é o exibido ao vivo na sua conta. Por isso, leve o celular com bateria e, de preferência, abra o ingresso antes de chegar.",
        "Cada ingresso dá direito a uma única entrada. A primeira leitura válida na portaria registra o uso, e leituras seguintes do mesmo ingresso são recusadas.",
        "O organizador pode pedir documento de identidade na entrada e aplicar as regras de acesso do evento informadas na página do evento.",
      ],
    },
    {
      title: "7. Meia-entrada",
      blocks: [
        "A meia-entrada segue a Lei nº 12.933/2013 e o Decreto nº 8.537/2015. Ao comprar meia-entrada, você declara ter direito ao benefício.",
        "O documento que comprova o direito deve ser apresentado na entrada. Sem ele, o organizador pode impedir o acesso com aquele ingresso, conforme a lei e a política do evento.",
        "A cota legal de meia-entrada fica reservada até 48 horas antes do início do evento (72 horas quando o local tem mais de 10.000 lugares). Depois desse prazo, os ingressos não vendidos da cota podem ser vendidos como inteira.",
      ],
    },
    {
      title: "8. Transferência de titularidade",
      blocks: [
        "Você pode transferir gratuitamente um ingresso válido para outra pessoa, pela própria plataforma. O destinatário precisa ter conta na TICKET24 e aceitar a transferência.",
        "Ao aceitar, o ingresso passa ao novo titular com um novo QR code, e o QR anterior deixa de valer. O histórico de transferências é registrado e guardado.",
        "Cada evento define o prazo-limite para transferir (em regra, até 24 horas antes do início) e quantas vezes um ingresso pode ser transferido (em regra, uma), informados na página do evento.",
        "Ingressos já usados, com reembolso em andamento ou de eventos encerrados não podem ser transferidos. Se um ingresso transferido for reembolsado, o valor volta para quem pagou o pedido original.",
        "A TICKET24 não garante ingressos obtidos fora da plataforma, nem acordos de revenda feitos fora dela.",
      ],
    },
    {
      title: "9. Arrependimento, cancelamento e reembolso",
      blocks: [
        "Você pode pedir o cancelamento e o reembolso em Meus pedidos, pelo link \"Cancelar compra / arrependimento\". As regras são:",
        {
          list: [
            "Arrependimento: até 7 dias depois da compra, com reembolso integral, taxa de serviço incluída, como prevê o art. 49 do Código de Defesa do Consumidor.",
            "Política do evento: cada evento informa na página dele até quantos dias após a compra e até quantas horas antes do início o reembolso é feito automaticamente. Depois de 7 dias da compra, dentro desses prazos, devolvemos o valor pago; se o evento informar que a parte fixa da taxa de serviço não é reembolsável, essa parte não é devolvida nesse caso.",
            "Evento cancelado: reembolso integral, com todas as taxas, feito automaticamente.",
            "Alteração relevante do evento (por exemplo, data, local ou atração principal): avisamos por e-mail e abrimos um prazo para você pedir o reembolso integral, com todas as taxas, mesmo fora dos prazos normais.",
            "Ingressos já usados na entrada não são reembolsáveis.",
          ],
        },
        "Quando o pedido não se enquadra no reembolso automático, inclusive o arrependimento que a política do evento não cobrir, você pode abrir um pedido de cancelamento pelo mesmo canal. Ele recebe um número de protocolo, e respondemos em até 5 dias.",
        "O reembolso é feito no mesmo meio de pagamento. No PIX, o valor volta para a conta de origem; no cartão, o estorno aparece na fatura conforme o prazo do emissor do cartão. Pedidos de reembolso de valor alto podem passar por aprovação manual antes do estorno.",
      ],
    },
    {
      title: "10. Condutas proibidas",
      blocks: [
        "Não é permitido:",
        {
          list: [
            "usar robôs, scripts ou meios automatizados para comprar ou reservar ingressos;",
            "comprar para revenda com ágio ou burlar os limites por conta e por pedido;",
            "falsificar, copiar ou adulterar ingressos ou QR codes;",
            "usar dados ou meios de pagamento de terceiros sem autorização;",
            "contestar indevidamente uma compra legítima junto ao emissor do cartão;",
            "tentar acessar áreas, contas ou dados que não são seus, ou prejudicar o funcionamento da plataforma.",
          ],
        },
        "Nesses casos podemos cancelar pedidos e ingressos, suspender ou encerrar a conta e comunicar as autoridades, sem prejuízo do direito de defesa e dos reembolsos que a lei garantir.",
      ],
    },
    {
      title: "11. Eventos de outros sites",
      blocks: [
        "Alguns eventos exibidos na TICKET24 são vendidos por outros sites e aparecem identificados como eventos externos. Nesses casos, a compra acontece no site indicado, sob as regras dele, e a TICKET24 não participa da venda.",
      ],
    },
    {
      title: "12. Disponibilidade do serviço",
      blocks: [
        "Trabalhamos para manter a plataforma disponível e segura, mas ela pode passar por manutenções e instabilidades. Quando uma falha nossa impedir o uso de um ingresso válido, buscaremos com o organizador uma solução, que pode incluir o reembolso.",
      ],
    },
    {
      title: "13. Comunicações",
      blocks: [
        "Enviamos para o e-mail da conta as mensagens necessárias ao serviço: confirmação de cadastro e de compra, ingressos, transferências, alterações e cancelamentos de eventos e reembolsos. Mantenha o e-mail atualizado.",
      ],
    },
    {
      title: "14. Alterações destes termos",
      blocks: [
        "Podemos atualizar estes termos. Cada versão tem número e data. Quando houver versão nova, pediremos que você a leia e aceite antes da próxima compra. As compras já feitas seguem a versão aceita no momento da compra, salvo o que for mais favorável a você.",
      ],
    },
    {
      title: "15. Lei aplicável, foro e atendimento",
      blocks: [
        "Estes termos são regidos pelas leis brasileiras. Eventuais disputas podem ser levadas ao foro do seu domicílio, como prevê o Código de Defesa do Consumidor.",
        `Atendimento: pela Central de Ajuda do site ou pelo e-mail ${COMPANY.supportEmail}. Você também pode registrar reclamação no Procon ou na plataforma consumidor.gov.br.`,
      ],
    },
  ],
  reviewNotes: [
    "Arrependimento (D3): o texto promete os 7 dias do CDC, art. 49, sem exceção, e o sistema aplica isso desde o PR #196 (refundEligibility, base ARREPENDIMENTO): reembolso integral até 7 dias após o pagamento e antes do início do evento, mesmo com política mais restritiva. Confirmar se o arrependimento deve valer também nas últimas horas antes do evento.",
    "Valor fixo não reembolsável: hoje o aviso aparece na página do pedido. Confirmar se é preciso exibi-lo também antes do pagamento (oferta/checkout) para valer contra o comprador.",
    "Definição de \"alteração relevante\" e duração da janela de reembolso (D2).",
    "Prazo de resposta de 5 dias no pedido de cancelamento é provisório (PROVISIONAL_CANCELLATION_RESPONSE_DAYS).",
    "Reembolso de ingresso transferido ao pagador original (D7).",
    "Confirmar a aplicabilidade e os deveres do Decreto nº 13.108/2026 ao modelo de marketplace (D1) e se o texto deve citá-lo.",
    "Responsabilidade solidária plataforma × organizador: o texto não exclui a responsabilidade da TICKET24 (CDC arts. 7º, 25 e 51). Ajustar se houver estratégia diferente.",
  ],
};
