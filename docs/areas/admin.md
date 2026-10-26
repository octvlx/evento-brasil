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
8. Exibir `PROVIDER_LINK_MISSING`, `OVER_REFUND_BLOCKED` e
   `checkFinancialInvariants` em `/admin/pagamentos`.
