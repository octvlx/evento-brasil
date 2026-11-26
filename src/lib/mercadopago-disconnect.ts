// Regras da desconexão da conta Mercado Pago da organização (texto compartilhado entre
// o servidor, que decide, e a tela de configurações, que mostra).
//
// Toda cobrança, consulta de pagamento e reembolso de uma venda usa o token OAuth da conta
// que recebeu aquela venda. Sem token, nada disso funciona. Por isso a desconexão:
//   - é recusada enquanto houver dinheiro em andamento que depende do token: pedido
//     aguardando pagamento (PIX em aberto), reembolso pendente, contestação, cancelamento
//     aberto ou venda paga de evento que ainda não terminou (pode ser reembolsada);
//   - quando permitida, para na hora a venda de ingressos pagos (o checkout recusa e nunca
//     cobra em outra conta); ingressos gratuitos continuam;
//   - deixa os reembolsos de vendas antigas (estornos, reembolsos manuais da plataforma)
//     dependentes de reconectar a MESMA conta Mercado Pago.

export type MpDisconnectBlocker = "PENDING_PAYMENTS" | "UPCOMING_PAID_ORDERS" | "OPEN_REFUNDS" | "OPEN_DISPUTES" | "OPEN_CANCELLATIONS";

export const MP_DISCONNECT_BLOCKER_TEXT: Record<MpDisconnectBlocker, string> = {
  PENDING_PAYMENTS: "Há pedidos aguardando pagamento (PIX ou cartão em aberto). Espere o pagamento ou o vencimento da reserva.",
  UPCOMING_PAID_ORDERS: "Há ingressos pagos de eventos que ainda não terminaram. Eles podem precisar de reembolso, que só é feito pela conta que recebeu.",
  OPEN_REFUNDS: "Há reembolsos pendentes ou com falha.",
  OPEN_DISPUTES: "Há pedidos em contestação ou com reembolso em andamento.",
  OPEN_CANCELLATIONS: "Há pedidos de cancelamento de compradores em aberto.",
};

export function mpDisconnectBlockedMessage(blockers: MpDisconnectBlocker[]): string {
  return ["Ainda não dá para desconectar o Mercado Pago:", ...blockers.map((b) => `• ${MP_DISCONNECT_BLOCKER_TEXT[b]}`)].join("\n");
}
