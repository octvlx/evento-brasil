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

## Cupons e atribuição (ADR 0002, passo 2)

Preço:
- `discountPerUnit(preço, cupom)` em `src/features/fees/discount.ts` (pura):
  `PERCENT` = `applyBps` meia-para-cima, `FIXED_PER_TICKET` = `min(valor, preço)`;
  preço 0 não recebe desconto. `undercutHalfPrice(tabela, líquido, preçosDeMeia)` acusa
  quando o cupom leva um ingresso com preço de tabela ≥ meia mais barata para baixo dela
  (tipo que já custa menos que a meia não é afetado; cortesia de 100% fica de fora).
- `computeFees` aceita `discountPerUnitCents` por linha; comissão e taxa BUYER
  incidem sobre o **líquido**. A linha devolve `listUnitPriceCents`,
  `discountPerUnitCents`, `unitPriceCents` (líquido) e `lineDiscountCents`; o
  resultado tem `discountCents`. Razão, reembolsos e `ORDER_TOTALS_MISMATCH` não mudam.

`createOrder`:
- Entrada nova: `couponCode?` (normalizado para maiúsculas) e `attribution?`
  (`trackingLinkId`, `utmSource/Medium/Campaign/Content/Term`).
- Erros: `"Cupom inválido ou indisponível."` (inexistente, malformado, de outra
  organização/evento, desativado — sem revelar qual); `"Cupom fora do período de
  validade."`; `SOLD_OUT "Cupom esgotado."`; `LIMIT_EXCEEDED` (limite por
  comprador); `"Este cupom não vale para os ingressos selecionados."`; meia-entrada
  furada; `"Desconto alto demais…"` (guarda B1 com desconto); `RATE_LIMITED`
  após 10 tentativas com cupom em 10 min por comprador (no serviço, cobre toda entrada).
- Meia-entrada nunca recebe desconto (D3); sem `CouponTicketType` = todos os tipos pagos.
- Atribuição: link de outro evento (ou inexistente) é descartado com os UTMs que
  vieram com ele; UTMs soltos valem; com link e sem UTMs, copia os do link;
  UTMs truncados em 200. Ler o cookie `eb_attr` é da Server Action (passo 4).

Contadores (D4), definição usada também na reconciliação:
`timesReserved` = pedidos `PENDING_PAYMENT` com o cupom;
`timesRedeemed` = pedidos com o cupom que têm ingresso emitido.
- `createOrder`: reserva +1. `finalizePaidOrderTx` (único ponto, inclusive gratuito):
  reservado −1, resgatado +1. `releaseOrderTx` (expirar/cancelar/trocar): reservado −1.
  `acquireLateInventoryTx`: resgatado +1 mesmo acima de `maxUses`, auditado
  `coupon.redeemed_over_limit`. Pagamento tardio sem estoque não resgata.
  Reembolso e chargeback não devolvem o uso. `maxUsesPerUser` conta pendentes e
  pedidos com ingresso.

Travas: **Event → Order → Coupon**. Cupom é trava-folha; transação que mexe em
mais de um cupom (`createOrder` com troca de pedido/expiração, `expireStaleOrders`,
`cancelEvent`) trava todos numa instrução `ORDER BY id FOR UPDATE`
(`lockCoupons`/`lockCouponsOfOrders`). O teste de trocas cruzadas entre dois
eventos com cupons de organização dá deadlock sem isso.

Invariantes novos: `COUPON_COUNTERS_MISMATCH` (igualdade exata),
`ORDER_DISCOUNT_MISMATCH`, `COUPON_TENANT_MISMATCH` (cupom de evento ou link em
pedido de outro evento; `CouponTicketType` de outro evento/organização; link com
cupom de outra organização/evento).

Testes: `tests/unit/discount.test.ts`, `tests/integration/s-coupon-pricing.test.ts`.

## Decreto 13.108/2026 — Fase 1 (L1a, L3, L4a)

Plano em `docs/conformidade-decreto-13108.md`.

### Prévia de preço ao comprador (R1, L1a)
`buyerPricePreview(rule, priceCents)` em `@/server/services/commission` →
`{ priceCents, serviceFeeCents, totalCents }` por ingresso, com `rule` vindo de
`resolveCommissionRule(db, organizationId, eventId)`. Usa o mesmo `computeFees`
do `createOrder`; equivale a `rule.bearer === "BUYER" ? commissionPerUnit(preço, rule) : 0`
para a taxa. Gratuito sempre 0; bearer `ORGANIZER` não tem taxa para o comprador.
`tests/integration/r-price-preview.test.ts` prova que a prévia é o que o pedido
grava e o que vai ao provedor (BUYER e ORGANIZER, percentual + fixo,
gratuitos, regra de organização e de evento).

### Preço congelado na reserva (R3, L3)
O pedido grava preço, taxa e regra (`OrderItem.unitPriceCents`,
`serviceFeePerUnitCents`, `Order.commissionRuleId`) na criação; o pagamento
usa `Order.totalCents`. `tests/integration/s-price-freeze.test.ts` muda o preço
do tipo e as regras (plataforma e evento) com a reserva ativa — antes de iniciar
o pagamento e depois do PIX gerado — e confere pedido, valor no provedor, razão
e `checkFinancialInvariants`.

### Limites de pedido e pagamento (R4, L4a)
`src/features/orders/limits.ts`, aplicados em `createOrderAction` e
`startPaymentAction` antes de tocar o banco. Janela fixa de 10 minutos; cada
chamada conta (inclusive repetição com a mesma chave de idempotência e PIX
reaproveitado). Erro `RATE_LIMITED` com mensagem pt-BR.

| Ação | Por conta | Por IP | Por quê |
|---|---|---|---|
| Criar pedido | 10 / 10 min | 30 / 10 min | Compra normal usa 1–3 tentativas (trocar quantidade substitui o pedido pendente). 10 dá folga a quem erra; um robô fica em ~1 pedido/min. |
| Iniciar pagamento | 15 / 10 min | 40 / 10 min | Cartão recusado + nova tentativa + troca PIX/cartão; cada tentativa de cartão no provedor tem custo e risco de teste de cartão roubado. |

O limite por IP é mais folgado porque redes móveis e Wi-Fi de evento
compartilham IP. Limitações: limitador em memória por processo
(`src/server/rate-limit.ts`; com várias instâncias, mover para Redis/Postgres);
o IP vem do primeiro `x-forwarded-for`, confiável só atrás de proxy que
sobrescreve o cabeçalho — o limite por conta vale sempre. O limite de ingressos
por conta por evento está na Fase 3 (L4b, abaixo); sinal anti-robô continua pendente.

## Decreto 13.108/2026 — Fase 3 (L8a, L4b, L5b)

Testes: `tests/integration/z-change-refund-limit-cancellation.test.ts` (14 casos,
todos terminando com `checkFinancialInvariants() == []`).

### Reembolso integral por alteração relevante (R8, L8a)
- `openChangeRefundWindow(db, eventId, paidAt, now?)` em `@/server/services/refunds`
  → `ChangeRefundWindow | null` (`eventChangeId` = alteração original,
  `grantedById` = linha que dá o prazo vigente, `changedAt`, `refundUntil`).
  Abre quando há `EventChange` do evento com `relevant = true`, registrada
  **depois** de `paidAt`, e `now <= refundUntil`. Prorrogação (`extendsChangeId`)
  herda relevância e data da original (vale para os mesmos pedidos). Várias
  abertas: vence o `refundUntil` mais longo. Quem grava as linhas e decide o que é
  relevante e o tamanho da janela é `area-organizador` (D2).
- `refundEligibility(order, event, tickets, now, changeWindow?)` ganhou o 5º
  parâmetro opcional e devolve `{ eligible: true, basis: "EVENT_POLICY" }` ou
  `{ eligible: true, basis: "EVENT_CHANGED", window, message }` (mensagem pt-BR
  com a data-limite, fuso de São Paulo). Com a janela aberta ignora os prazos
  normais do evento; pedido não pago, evento cancelado e ingresso já usado
  continuam recusados.
- `requestCustomerRefund` usa a janela sozinho: o reembolso sai com
  `reason = EVENT_CHANGED` e `eventChangeId`, valor `Order.totalCents` (preço +
  taxa de serviço). A divisão no razão segue a regra de comissão do pedido, como
  nos demais reembolsos. Ingressos transferidos: só o pagador (`Order.userId`)
  pede; todos os ingressos do pedido são revogados, inclusive os de outros
  titulares, e o dinheiro volta ao pagamento original (padrão provisório D7).
- Reembolso `EVENT_CHANGED` com falha pode ser restaurado pelo admin (como
  `CUSTOMER_REQUEST`/`ADMIN`).

### Limite de ingressos por conta (R4, L4b)
- `ticketsHeldByAccount(client, userId, eventId)` em `@/server/services/orders`:
  ingressos `VALID`/`CHECKED_IN` com `holderUserId = userId` + quantidades dos
  pedidos `PENDING_PAYMENT` da conta no evento com reserva não vencida (`expiresAt > now`).
  Ingresso comprado e transferido conta só para o novo titular.
- `createOrder` recusa com `LIMIT_EXCEEDED` quando `ticketsHeldByAccount +
  quantidade pedida > Event.maxTicketsPerAccount` (NULL = sem limite), sob a
  trava do evento e depois de liberar o pedido pendente anterior do comprador.
  Mensagem: *"Este evento permite até 3 ingressos por conta. Você já tem 2
  ingressos; pode comprar mais 1."*
- Limitação: pagamento tardio (`acquireLateInventoryTx`) não reconfere o limite
  — o pedido estava dentro dele quando criado.

### Pedido de cancelamento com protocolo (R5, L5b)
Serviço `@/server/services/cancellation-requests`:
- `createCancellationRequest(db, buyer, orderId, reason, now?)`: qualquer pedido
  do próprio comprador, motivo de 1 a 2000 caracteres. Protocolo
  `CAN-AAAAMMDD-XXXXXX` (data de São Paulo, base32 Crockford). `respondBy = now +
  PROVISIONAL_CANCELLATION_RESPONSE_DAYS` (**5 dias corridos, padrão provisório
  D3, não é prazo legal**). `autoEligibleAtRequest` guarda o resultado de
  `refundEligibility` (com a janela de alteração) no momento do pedido. Um pedido
  aberto por pedido: o segundo recebe `INVALID_STATE` com o protocolo existente.
- `listMyCancellationRequests(db, buyer)`, `listCancellationRequestsForAdmin(db,
  admin, { status?, take? })` (padrão `OPEN`, pelo prazo mais curto).
- `withdrawCancellationRequest(db, buyer, id)`: desistência do solicitante.
- `decideCancellationRequest(db, adapter, admin, id, { decision, note })` →
  `{ request, outcome, refundId }`. Recusar exige `note` (vai ao comprador).
  Aprovar, sob as travas Event → Order:
  - pedido `PAID` → `REFUND_OPENED`: reembolso integral `reason = ADMIN` com
    `cancellationRequestId`, pelo mesmo `createRefundRequestTx` dos demais
    (revoga ingressos, guarda contra reembolso em dobro) e `processRefund`;
    ignora os prazos normais (decisão do admin);
  - `REFUND_PENDING`/`REFUNDED` → `REFUND_ALREADY_EXISTS` (nenhum novo reembolso);
  - `PENDING_PAYMENT` → `PENDING_ORDER_CANCELLED` (reserva liberada);
  - outros status → `INVALID_STATE` (recusar com motivo).
  A transição `OPEN → decidido` é condicional: decidir duas vezes, ou aprovar
  junto com `requestCustomerRefund`, nunca gera dois reembolsos (teste de corrida).
- Auditoria: `cancellation.requested`, `.withdrawn`, `.approved`, `.rejected`
  (metadados com protocolo, pedido, resultado e reembolso).

Server Actions em `@/features/orders/cancellation-actions`:
`requestCancellationAction(orderId, reason)` → `{ protocol, respondBy }`;
`withdrawCancellationAction(requestId)`;
`adminDecideCancellationAction(requestId, "APPROVE" | "REJECT", note)` →
`{ outcome, refundStatus }` (exige admin; telas na Fase 4).

## Contratos com outras áreas

### Fase 3 (Decreto 13.108/2026)
- **`check-in`** (aceite de transferência): chamar `ticketsHeldByAccount(tx,
  destinatário, eventId)` com `lockEvent(tx, eventId)` já tomado e recusar se
  `+ 1 > Event.maxTicketsPerAccount`; é a mesma trava de `createOrder`, então
  compra e aceite simultâneos não passam do limite.
- **`area-organizador`**: gravar `EventChange` com `relevant = true` e
  `refundUntil` nas alterações relevantes; prorrogação = nova linha com
  `extendsChangeId` e `refundUntil` maior. O financeiro só lê.
- **`paginas-publicas`** (Fase 4, página do pedido): passar
  `await openChangeRefundWindow(db, order.eventId, order.paidAt)` como 5º
  argumento de `refundEligibility` para mostrar a janela e `message`; hoje a
  página não passa e mostra só a política normal (o servidor aceita o pedido de
  reembolso pela janela mesmo assim). Formulário de cancelamento:
  `requestCancellationAction`; histórico: `listMyCancellationRequests`. Tratar o
  reembolso com `reason = EVENT_CHANGED`.
- **`admin`** (Fase 4): fila `listCancellationRequestsForAdmin` e
  `adminDecideCancellationAction`; mostrar `respondBy`, `autoEligibleAtRequest` e,
  para `REFUND_OPENED` com `refundStatus = FAILED`, a fila de reembolsos com falha.

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
Cupons (passo 3): usar `discountPerUnit` e `undercutHalfPrice` de
`@/features/fees/discount` para os avisos; validar na criação que o líquido não
fica abaixo de `commissionPerUnit` com bearer ORGANIZER (mesma guarda B1) e que
`CouponTicketType` só tem tipos do evento/organização do cupom e nunca meia
(o checkout ignora meia de qualquer forma). `unitPriceCents`/`subtotalCents`
são líquidos; "descontos concedidos" = `Order.discountCents`.

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

## Recuperação de webhooks de pagamentos confirmados

Reconciliação de pagamentos confirmados: o cron também consulta pagamentos
`PAID` e `DISPUTED` do provedor configurado, recuperando estornos, chargebacks
e resolução de disputas mesmo quando o webhook não chega. O lote é separado
das tentativas pendentes (limite padrão de 200 por grupo). A fila ordena por
`Payment.updatedAt` e id; cada consulta, inclusive com erro, atualiza esse
horário sem mudar o status financeiro. Assim todos avançam na fila e falhas
aguardam o intervalo de `staleMinutes` (padrão: 10 minutos) antes de repetir.
O relatório retorna `settledPaymentsSynced` e erros `settled-payment`.
Pagamentos `REFUNDED` e `CHARGED_BACK` saem dessa fila. A recuperação usa os
mesmos serviços transacionais e idempotentes dos webhooks.

## Fase 4 — V1: testes cruzados entre domínios

`tests/integration/za-cross-domain.test.ts` (16 casos; cada um termina com
`checkFinancialInvariants() == []`). Cobre, com disputas reais em paralelo:

- **Aceite de transferência × check-in:** aceite contra leituras do QR antigo
  (6 rodadas) e, depois da troca, QR antigo e novo ao mesmo tempo. No máximo uma
  entrada por ingresso; o QR antigo nunca entra depois do aceite.
- **Aceite × reembolso × aprovação do pedido de cancelamento:** um único
  reembolso, integral, para o pagamento de quem pagou (D7); o destinatário não
  pede reembolso nem cancelamento; nenhum ingresso válido sobra; chargeback.
- **Janela da alteração relevante** (alteração gravada por `updateEvent`,
  prorrogação por `extendEventChangeWindow`): pedido com ingresso transferido,
  último instante da janela (`now == refundUntil`), 1 ms depois (política
  normal) e prorrogação reabrindo a janela.
- **Limite por conta:** transferências de entrada e saída, pedido pendente com
  cupom, reserva vencida e liberação pela manutenção; 6 aceites + 6 pedidos
  simultâneos para a mesma conta param exatamente no limite.
- **Cancelamento do evento** com transferências pendentes, inclusive disputando
  com o aceite.
- **Manutenção (mesmos passos de `/api/cron/maintenance`)** no meio dos fluxos:
  retoma reembolsos do cancelamento, concorrente com check-in e novo pedido de
  reembolso; é idempotente; convite vencido expira mesmo com aceite concorrente.

### Achados

| # | Achado | Gravidade | Dono | Situação |
| --- | --- | --- | --- | --- |
| V1-1 | Reembolso, chargeback e cancelamento do evento revogavam os ingressos mas deixavam as **transferências pendentes** como `PENDING` até vencer (até 48 h ou o início do evento). O aceite já era recusado (ingresso não `VALID`), então não havia ingresso válido indevido nem dinheiro errado, mas o convite seguia "pendente" na tela das duas pessoas e no histórico. | Média | pagamentos-financeiro | Corrigido: `closePendingTransfersTx` (`refunds.ts`) encerra as pendentes como `CANCELLED` (automático, `decidedById` nulo, com motivo) em `createRefundRequestTx`, `confirmRefundTx` (cobre o reembolso iniciado no provedor), chargeback (`payments.ts`) e `cancelEvent`; contagem na auditoria. Mesma ordem de travas de `transfers.ts`. |
| V1-2 | `acceptTransfer` (`transfers.ts`, `heldByAccount`) chama `ticketsHeldByAccount` sem repassar o `now` do aceite. Com relógio injetado, uma reserva vencida e ainda não liberada conta contra o limite. Em produção `now` é o relógio, então o efeito real é nulo. | Baixa | check-in | Reportado: teste `it.fails` em `za-cross-domain.test.ts` (V1.4). Correção sugerida: `shared(client, userId, eventId, now)`. |

Verificado como **correto**: aceite e check-in serializados pela trava do
evento (o QR antigo nunca admite depois da troca); reembolso e aprovação do
admin nunca geram dois reembolsos; reembolso de ingresso transferido sempre
vai ao pagamento original; limite por conta respeitado sob concorrência entre
pedidos e aceites; cancelamento do evento revoga tudo e libera reservas;
reconciliação concorrente não duplica estornos.

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
