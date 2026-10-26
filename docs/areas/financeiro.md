# Área financeira — auditoria, fundação e contratos

Responsável: agente `pagamentos-financeiro`.

## Auditoria (checkout, estoque, pagamentos, webhooks, reembolsos)

| # | Achado | Gravidade | Situação |
| --- | --- | --- | --- |
| 1 | **Cobrança duplicada:** `startPayment` verificava "já existe pagamento?" e depois criava, **sem trava**. Cliques simultâneos criavam várias tentativas (no código antigo, 6 cliques no cartão → 5 cobranças para o mesmo pedido). | Crítica | Corrigido |
| 2 | **Reembolso × check-in:** o reembolso checava "nenhum ingresso usado" fora da trava; um check-in no meio permitia entrar **e** ser reembolsado (no código antigo, 8 de 8 disputas). | Crítica | Corrigido |
| 3 | Sem guarda explícita contra **estorno acima do valor pago** (dependia só das chaves por motivo). | Alta | Corrigido |
| 4 | **Webhook perdido** deixava o pedido pago sem confirmação para sempre (nada consultava o provedor depois). | Alta | Corrigido (reconciliação) |
| 5 | Webhook **registrado mas com falha** no processamento nunca era reprocessado se o provedor não reenviasse. | Média | Corrigido (reconciliação) |
| 6 | Queda entre **criar a cobrança no provedor e salvar o id** deixava a cobrança órfã. | Média | Corrigido onde o provedor permite busca por referência |
| 7 | Reembolso parado em **PROCESSING** (queda entre reivindicar e chamar o provedor) ficava preso. | Média | Corrigido (reconciliação, mesma chave de idempotência) |
| 8 | Nenhuma verificação automática dos invariantes no banco. | Média | Corrigido (`checkFinancialInvariants`) |

Verificado como **já correto** (mantido): reserva de estoque com trava do evento e
CHECKs no banco (sem overselling — teste com 40 compradores para 10 ingressos);
fluxo único de checkout (`createOrder`); preços, taxas e comissão calculados no
servidor a partir do banco; deduplicação de webhooks e reconsulta ao provedor;
razão balanceado e somente inserção; emissão única de ingressos; pagamento
tardio (recupera estoque ou reembolsa).

## O que mudou

- `startPayment` (`payments.ts`): decisão sob `SELECT … FOR UPDATE` do pedido.
  No máximo **uma tentativa ativa** por pedido: PIX pendente é reaproveitado;
  qualquer outra combinação com tentativa pendente é recusada; pedido pago recusa
  nova tentativa. A chamada ao provedor fica fora da transação, com chave de
  idempotência.
- Reembolsos (`refunds.ts`): ao **solicitar**, os ingressos válidos são revogados
  dentro da trava (check-in concorrente passa a receber "cancelado"); pedido de
  cliente com ingresso já usado é recusado e nada é alterado. Guardas contra
  estorno acima do pago na solicitação, antes de chamar o provedor
  (`OVER_REFUND_BLOCKED`) e na confirmação (`OverRefundError`). Novo
  `resumeRefund`.
- `reconciliation.ts` (novo): `reconcilePayments` (webhooks com falha,
  pagamentos pendentes há mais de 10 min, cobranças sem id do provedor,
  reembolsos parados) e `checkFinancialInvariants` (razão balanceado, contadores
  de reservados/vendidos, reservas ativas em pedidos fechados, ingressos de
  pedidos pagos, totais × itens, estorno acima do pago, venda sem lançamento,
  ingresso revogado em pedido pago). Nada é corrigido em silêncio.
- Provedor: método opcional `findPaymentByReference` no contrato; o simulado
  implementa. **Item novo na lista de verificação do Mercado Pago.**
- `POST /api/cron/maintenance` agora também reconcilia e verifica invariantes
  (resposta com contagens; detalhes no log de erro do servidor).

Testes: `tests/integration/l-financial-integrity.test.ts` (12 casos, todos
terminam com `checkFinancialInvariants() == []`). As duas corridas críticas
foram confirmadas como **falhando no código antigo** e passando no novo.

## Contratos com outras áreas

### `paginas-publicas` (checkout e pedido)
Sem mudança de assinatura nas Server Actions. Mudanças de comportamento:
- `startPaymentAction`: pode retornar `INVALID_STATE` com
  *"Já há um pagamento com cartão em processamento…"* ou
  *"Este pedido não está aguardando pagamento."* — a tela já exibe `res.error`.
  Recomendação de UX: desabilitar o botão até a resposta (o servidor já protege).
- `requestRefundAction`: os ingressos ficam **cancelados assim que o reembolso é
  solicitado** (antes, só após a confirmação). Se o provedor recusar, o pedido
  fica em `REFUND_PENDING` com o reembolso `FAILED` para reprocessamento no
  admin. A página do pedido deve continuar mostrando o status do reembolso.

### `area-organizador` (relatórios)
Sem mudança no razão nem nas contas. Ingressos de pedidos com reembolso em
andamento passam a aparecer como cancelados mais cedo nas contagens de
"ingressos vendidos" e na lista de participantes.

### `admin`
Pagamentos sem vínculo com o provedor podem aparecer com
`failureReason = PROVIDER_LINK_MISSING` (provedor sem busca por referência) e
reembolsos com `OVER_REFUND_BLOCKED` — ambos exigem análise humana.

## Pendências (em ordem)

1. Integração real verificada (Mercado Pago), incluindo `findPaymentByReference`
   e cartão tokenizado no provedor — nenhuma transação com dinheiro real sem
   aprovação explícita.
2. Outbox durável para notificações de pedido pago/reembolso.
3. Reembolso parcial e etapa opcional de aprovação.
4. Política para reembolso `FAILED` (restaurar ingressos ou reprocessar).
5. Logs estruturados com correlation id por pedido; métricas.
