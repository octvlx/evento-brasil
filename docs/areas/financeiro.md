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
| 9 | **Reembolso `FAILED` sem saída:** ingressos revogados na solicitação; se o provedor recusasse, o comprador ficava sem dinheiro e sem ingresso, sem retentativa nem alerta. | Alta | Corrigido (política abaixo) |

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

## Política para reembolso `FAILED`

A solicitação revoga os ingressos (por causa da corrida com o check-in). Se o
provedor recusar (`PROVIDER_REFUSED`) ou falhar (`PROVIDER_ERROR`), o pedido
fica em `REFUND_PENDING` e o reembolso em `FAILED`, **nunca em silêncio**:

1. **Registro:** cada falha grava auditoria `refund.attempt_failed`
   (metadados `orderId`, `kind`, `attempt`, `message`), atualiza `Refund.note`
   (`"<KIND>: <mensagem> (tentativa N, limite automático 4)"`) e emite log
   estruturado com o id do pedido como correlation id.
2. **Retentativa automática:** `reconcilePayments` (cron de manutenção) chama
   `retryFailedRefunds`, que reenvia ao provedor com a **mesma chave de
   idempotência** (nunca estorna duas vezes). `REFUND_RETRY_POLICY`: até 4
   tentativas no total, esperando 5 min, 30 min e 2 h após a 1ª, 2ª e 3ª falha.
   Só toca reembolsos `FAILED` de pedidos em `REFUND_PENDING`. Um reembolso
   parado em `PROCESSING` cujo provedor lança erro na retomada também entra na
   política (antes ficava preso).
3. **Decisão do admin:** esgotadas as tentativas (auditoria
   `refund.retry_exhausted`, log `refund.awaiting_admin_decision`) ou se o
   reembolso foi bloqueado por `OVER_REFUND_BLOCKED` (nunca reprocessado
   sozinho), o reembolso aguarda o admin, que pode:
   - **reprocessar** — nova tentativa com a mesma chave (conta como tentativa);
   - **restaurar** — o reembolso vira `REJECTED` (terminal), os ingressos
     revogados por ele (`revocationReason = REFUNDED`) voltam a `VALID` e o
     pedido volta a `PAID`. Contadores, status do pagamento e razão **não
     mudam**: `quantityRefunded`, `Payment.REFUNDED` e o estorno no razão só
     são gravados na confirmação, que não aconteceu. Antes de restaurar, o
     provedor é consultado (`getPayment`): se o pagamento já consta estornado
     (ex.: timeout depois do estorno), o reembolso é **confirmado** em vez de
     desfeito (`ALREADY_REFUNDED`); se não está `PAID`, a restauração é recusada
     para análise manual. Só vale para reembolsos `CUSTOMER_REQUEST`/`ADMIN`,
     com o evento não cancelado e ainda não encerrado; reembolsos de evento
     cancelado e de pagamento tardio só podem ser reprocessados.

Depois de uma restauração o comprador pode pedir reembolso de novo (chave nova,
`refund:<pedido>:customer_request:2`), sujeito às regras de elegibilidade.

Concorrência: restauração e reprocessamento disputam a mesma transição
condicional a partir de `FAILED` (`FAILED → REJECTED` sob trava Event → Order;
`FAILED → PROCESSING`); só um vence. O check-in usa `FOR KEY SHARE` no evento,
então nunca lê o ingresso no meio da restauração.

Invariantes novos em `checkFinancialInvariants`:
`REFUND_PENDING_WITHOUT_OPEN_REFUND`, `OPEN_REFUND_ON_PAID_ORDER`,
`VALID_TICKET_ON_REFUND_PENDING_ORDER`.

Logs: `financeLog` (`src/server/services/finance-log.ts`) emite uma linha
`[financeiro] {json}` com `correlationId` = id do pedido. Usado nas falhas de
reembolso, decisões do admin, erro ao processar webhook e erros da
reconciliação no cron (agora com `orderId` quando conhecido).

Testes: `tests/integration/o-refund-failure.test.ts` (13 casos: recusa, erro de
rede, retentativa com espera, esgotamento, reprocessar, restaurar, novo pedido
após restaurar, provedor que estornou de fato, evento cancelado, detecção de
invariante, restauração × check-in, reprocessar × restaurar, retentativa ×
check-in), todos terminando com `checkFinancialInvariants() == []`.

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
  Agora a manutenção tenta de novo automaticamente (até 4 vezes) e, se o admin
  restaurar, o pedido volta a `PAID` com os ingressos válidos e o reembolso
  fica `REJECTED` — a página deve tratar esse status ("reembolso não
  realizado; seus ingressos foram reativados").

### `area-organizador` (relatórios)
Sem mudança no razão nem nas contas. Ingressos de pedidos com reembolso em
andamento passam a aparecer como cancelados mais cedo nas contagens de
"ingressos vendidos" e na lista de participantes.

### `admin`
**Fila de reembolsos com falha** (tela a cargo do agente admin, em
`/admin/pagamentos` ou nova página):

- Leitura (Server Component): `listFailedRefunds(db, admin)` em
  `@/server/services/refunds` → `FailedRefundView[]` com `refundId`, `orderId`,
  `orderPublicCode`, `eventId`, `eventTitle`, `reason`, `amountCents`, `note`
  (última falha), `failedAt`, `attempts`, `nextRetryAt` (nulo = aguarda admin),
  `awaitingAdminDecision` e `restoreBlockedReason` (nulo = pode restaurar;
  senão, texto para exibir e desabilitar o botão).
- Ações (Server Actions em `@/features/orders/actions`, exigem admin e motivo):
  - `adminRetryFailedRefundAction(refundId, note)` →
    `ActionResult<{ status }>` (`SUCCEEDED`, `FAILED` ou `PROCESSING`).
  - `adminRestoreFailedRefundAction(refundId, note)` →
    `ActionResult<{ outcome: "RESTORED" | "ALREADY_REFUNDED"; restoredTickets }>`.
    Pedir confirmação explícita: o comprador **não** recebe o dinheiro.
  - Erros: `VALIDATION` (motivo vazio), `INVALID_STATE` (reembolso/pedido
    mudou de estado, evento cancelado/encerrado, pagamento não `PAID`),
    `PROVIDER_ERROR` (não foi possível consultar o provedor — tentar de novo).
- Recomendação: trocar o atual `retryRefundAction` (`features/admin/actions.ts`,
  chama `processRefund` direto, sem motivo nem checagem do pedido) por
  `adminRetryFailedRefundAction`.
- Destacar `awaitingAdminDecision = true` (também sinalizado no log
  `refund.awaiting_admin_decision`).

Pagamentos sem vínculo com o provedor podem aparecer com
`failureReason = PROVIDER_LINK_MISSING` (provedor sem busca por referência) e
reembolsos com `OVER_REFUND_BLOCKED` — ambos exigem análise humana.

## Pendências (em ordem)

1. Integração real verificada (Mercado Pago), incluindo `findPaymentByReference`
   e cartão tokenizado no provedor — nenhuma transação com dinheiro real sem
   aprovação explícita.
2. Outbox durável para notificações de pedido pago/reembolso.
3. Reembolso parcial e etapa opcional de aprovação.
4. ~~Política para reembolso `FAILED`~~ (feito). Melhoria via `banco-de-dados`:
   colunas `Refund.attemptCount`, `nextRetryAt`, `lastErrorKind` e índice em
   `(status, nextRetryAt)` para não depender da contagem na auditoria.
5. Logs: correlation id por pedido feito nos caminhos de erro financeiro
   (`financeLog`); faltam métricas e o mesmo padrão nos caminhos de sucesso.
6. Notificar o comprador por e-mail quando o reembolso falhar/for restaurado
   (depende do outbox, item 2).
