# Administração — decisões atômicas e lacunas

Responsável: agente `admin`. Última revisão: correção das corridas de aprovação
(organizações e moderação de eventos).

## Corridas de aprovação (corrigido)

`reviewOrganization`, `setOrganizationSuspended` (`src/server/services/organizers.ts`)
e `moderateEvent` (`src/server/services/events.ts`) liam a linha e depois
atualizavam sem trava. Em READ COMMITTED, duas transações liam o mesmo
`PENDING_REVIEW`, a segunda esperava a primeira no `UPDATE` e depois gravava por
cima. Consequências reproduzidas em teste no código antigo:

| Cenário | Antes | Agora |
| --- | --- | --- |
| Admin A aprova e admin B rejeita a mesma organização pendente | As duas chamadas tinham sucesso; duas auditorias contraditórias, status final = quem gravou por último | Uma vence; a outra recebe `INVALID_STATE` ("A organização não está em análise.") |
| Duplo clique em "Aprovar" | Duas aprovações auditadas | Uma aprovação; a segunda recebe `INVALID_STATE` |
| Aprovar × suspender ao mesmo tempo | A aprovação podia sobrescrever a suspensão (status final `APPROVED` com auditoria de suspensão) | Status final sempre `SUSPENDED`; se a suspensão vem antes, a aprovação é recusada |
| Dois admins reativando a mesma organização | Duas auditorias `organization.reinstated` | Uma reativação; a segunda é idempotente e não audita |
| Dois moderadores (aprovar × devolver) no mesmo evento pendente | As duas tinham sucesso | Uma vence; a outra recebe "O evento não está aguardando moderação." |

Como foi corrigido:

- Cada decisão abre uma transação e trava a linha com `SELECT … FOR UPDATE`
  **antes** de ler o status (`lockOrganization` em `organizers.ts`; trava do
  `Event` em `moderateEvent`, mesmo padrão de `orders.ts`/`cancellation.ts`).
- `setOrganizationSuspended` passou a rodar em transação; antes o `update` e o
  `audit` eram escritas soltas. Organização inexistente agora gera `notFound()`
  (antes era o erro P2025 do Prisma).
- `moderateEvent` (aprovação) lê o status da organização com `FOR SHARE`: uma
  suspensão concorrente espera a aprovação terminar, ou a aprovação vê a
  organização já suspensa.
- `AuditLog.metadata` é gravado na mesma transação e agora inclui
  `previousStatus`, `newStatus` e o motivo (`note` / `reason`, chaves
  mantidas). Assim a trilha encadeia: o `previousStatus` de cada entrada é o
  `newStatus` da anterior.
- Assinaturas e mensagens de erro inalteradas.

Testes: `tests/integration/p-admin-approvals.test.ts`. Para tornar a corrida
determinística, uma terceira conexão segura a linha com `FOR UPDATE`, as duas
chamadas começam, o teste espera até ver as duas bloqueadas em `pg_locks` e só
então libera. No código antigo 5 dos 6 testes falham; com a correção, todos
passam.

## Fase 4 — filas do Decreto 13.108/2026 (A1 + T5)

Todas as telas chamam `requireAdmin()` e passam o admin para leituras em
`src/server/services/admin-oversight.ts`, que começam com
`assertPlatformAdmin` (admin suspenso também é recusado). Listas paginadas por
`?pagina=` (25 por página, `ADMIN_PAGE_SIZE`). As decisões **não** são do
admin: usam as Server Actions e os serviços do financeiro.

| Tela | Rota | Leitura | Decisão (dono) |
| --- | --- | --- | --- |
| Pedidos de cancelamento | `/admin/cancelamentos` (`?status=OPEN\|APPROVED\|REJECTED\|WITHDRAWN`, `?vencidos=1`) | `listCancellationQueue` — abertos pelo `respondBy`, vencidos destacados | — |
| Detalhe do protocolo | `/admin/cancelamentos/[id]` | `getCancellationRequestDetail` — pedido, pagamentos, reembolsos, ingressos, elegibilidade de hoje (`refundEligibility` + `openChangeRefundWindow`) | `adminDecideCancellationAction(id, "APPROVE"\|"REJECT", note)` (financeiro) |
| Reembolsos com falha | `/admin/pagamentos#reembolsos-falhos` | `listFailedRefunds` (financeiro) | `adminRetryFailedRefundAction` / `adminRestoreFailedRefundAction` (financeiro, PR #16) |
| Transferências | `/admin/transferencias` (`?q=` código/e-mail/evento, `?status=`) | `searchTransfers` (nunca seleciona `tokenHash`) + `transferPatternReport` | nenhuma — somente leitura |
| Alterações de evento | `/admin/alteracoes` | `listOpenChangeWindows` — alteração original relevante com prazo vigente (inclui prorrogações), reembolsos por `Refund.eventChangeId` e pedidos ainda pagos antes da alteração | nenhuma |
| Auditoria | `/admin/auditoria` (`?grupo=`, `?acao=`) | `listAuditLogs` | — |

Decisões com motivo obrigatório e diálogo de confirmação
(`ReasonedDecisionButton`, `src/features/admin/decision-controls.tsx`): o botão
trava do primeiro clique até a resposta. A garantia contra dupla decisão continua
no domínio (transição condicional `OPEN → decidido` sob trava Event → Order);
aprovar duas vezes ou aprovar × recusar gera uma decisão e no máximo um
reembolso (testado). A recusa exige motivo no serviço; a aprovação exige só na
tela (o serviço aceita aprovação sem nota).

Relatório de transferências: na janela de 24h (`TRANSFER_PATTERN_DEFAULTS`),
sinaliza titular com ≥ 3 envios, e-mail com ≥ 3 recebimentos e ingresso com
≥ 3 transferências (só `initiatedBy = HOLDER`). Apenas sinalização; nenhuma
ação automática.

Grupos da auditoria (`AUDIT_PRESETS`) usam os nomes **gravados pelos
serviços**: `ticket.transfer.*` (não `transfer.*`), `cancellation.*` (não
`cancellation_request.*`), `event.relevant_change` + `event.change_*`,
`terms.*` e `refund.*`. Hoje nenhum serviço grava `terms.*` (os aceites ficam
em `TermsAcceptance`); o filtro existe para quando gravarem. O seed grava
`event.change.buyers_notified`, que não casa com `event.change_` — fica no
filtro livre `?acao=event.change`.

Visão geral (`/admin`): cartões com pedidos de cancelamento abertos/vencidos e
reembolsos com falha (`adminQueueCounts`). O botão genérico "Reprocessar" da
lista de reembolsos ficou só para `REQUESTED`; `FAILED` vai para a seção nova.

Testes: `tests/integration/p-admin-phase4-queues.test.ts` (autorização de
cliente e admin suspenso em todas as leituras e decisões; fila e vencidos;
duplo clique e aprovar × recusar pelo domínio; reprocessar e restaurar;
busca e relatório de transferências; janelas com prorrogação e contagem;
grupos e paginação da auditoria) e
`tests/e2e/admin-cancellation-queue.spec.ts` (cliente redirecionado das rotas
novas; admin aprova o protocolo do seed com motivo e duplo clique).

## Lacunas restantes (por prioridade)

1. **Outras escritas do admin sem trava/transação:**
   - `setUserSuspended` (`users.ts`): `update`, `revokeAllSessions` e `audit`
     são escritas separadas, sem `previousStatus`. Suspender × reativar
     simultâneos podem deixar sessões revogadas com usuário ativo (ou vice-versa)
     e auditoria fora de ordem.
   - `setAutoPublish` e `setEventFeatured`: `update` e `audit` fora de
     transação; a auditoria não registra o valor anterior.
   - `resubmitOrganizerApplication` (dono: `area-organizador`) tem o mesmo
     padrão lê-depois-grava sem trava; o reenvio duplo pode criar duas
     verificações. Sugerido usar o mesmo `lockOrganization`.
   - `cancelEvent` (`cancellation.ts`) já trava o evento — sem ação.
2. **AuditLog append-only:** falta o trigger (reaproveitar o padrão do razão);
   paginação, filtros por data/ator/entidade e exportação CSV autorizada.
   Exige migração (`banco-de-dados`).
3. **Colunas de auditoria:** `previousStatus`/`newStatus`/`reason`/correlation id
   vivem em `metadata` (JSON). Propor colunas próprias ao `banco-de-dados` se a
   tela de auditoria precisar filtrar por elas.
4. Sub-papéis de admin e permissões (migração).
5. Páginas de detalhe com histórico; casos de moderação/denúncias.
6. Suspensão de evento distinta do cancelamento (sem reembolso) — com
   `pagamentos-financeiro`.
7. Pré-visualização de comissão via `computeFees`/`resolveCommissionRule`.
8. Exibir `PROVIDER_LINK_MISSING` e `checkFinancialInvariants` em
   `/admin/pagamentos` (`OVER_REFUND_BLOCKED` já aparece na seção de
   reembolsos com falha, com decisão do admin).
9. Fase 4: atribuição de pedidos de cancelamento a um admin
   (`assignedToId` existe no schema, sem serviço); exportação CSV das filas;
   limiares do relatório de transferências configuráveis; `/admin/pagamentos`
   ainda lista pedidos/reembolsos/webhooks sem paginação (take fixo).
