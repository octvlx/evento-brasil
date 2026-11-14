# Área do organizador — inventário e dependências

Responsável: agente `area-organizador`. Última revisão: participantes com titular
atual e histórico de transferências, janelas de alteração abertas e alertas (Fase 4
do Decreto 13.108/2026).

## O que existe

| Funcionalidade | Onde | Estado |
| --- | --- | --- |
| Painel com KPIs, pendências, próximos eventos, desempenho por evento, pedidos recentes, gráfico de 30 dias, ações rápidas | `/organizador`, `organizerDashboard` em `reports.ts` | Pronto |
| Lista de organizações do usuário, troca de organização ativa | `/organizador/organizacoes`, `listMyOrganizations`, `switchOrganizationAction` | Pronto |
| Criar organização (primeira ou adicional; limite de 3 pendentes) | `/organizador/cadastro`, `/organizador/organizacoes/nova`, `createOrganizationAction` | Pronto |
| Reenviar cadastro recusado (id explícito, `org:manage`) | `/organizador/cadastro`, `resubmitApplicationAction` | Pronto |
| Criar evento pelo assistente em 6 etapas (rascunho salvo a cada etapa, autosave, voltar/avançar, retomar depois, revisão e publicação) | `/organizador/eventos/novo`, `event-wizard.ts`, `event-wizard-progress.ts` | Pronto |
| Editar evento (formulário completo), local novo/existente, capa, fuso | `/organizador/eventos/[id]/editar`, `events.ts` | Pronto |
| Tipos de ingresso (preço, quantidade, limites, janela, oculto, nome por ingresso) | `…/[id]/editar`, `upsertTicketType`, `deleteTicketType` | Pronto |
| Publicação com moderação / publicação automática; cancelamento com reembolso | `submitEventForPublication`, `cancelEvent` (financeiro) | Pronto |
| Vendas, repasses e cota de meia-entrada | `/organizador/vendas` | Pronto |
| CSV de meia-entrada por evento (cota, vendidas, reservadas, reembolsadas, canceladas, check-in, cota restante, vendas por dia) — auditado, sem dados pessoais | `/organizador/vendas`, `/api/organizador/eventos/[id]/meia-entrada`, `halfPriceReport`/`halfPriceReportToCsv` em `reports.ts` | Pronto |
| Participantes com titular atual, marcador "Transferido"/"Transferência pendente" e histórico de transferências por ingresso + CSV auditado | `/organizador/participantes`, `/api/organizador/eventos/[id]/participantes`, `listAttendees`, `listTransferHistory` | Pronto |
| Perfil e conta de recebimento (simulada) | `/organizador/configuracoes` | Pronto |
| Equipe, convites e atribuição de check-in (menu abaixo de Eventos) | `/organizador/equipe`, `/convite/[token]` | Pronto |
| Convites: lista de pendentes (com vencidos), revogar, reenviar (novo token; o anterior deixa de valer), recusar pelo convidado | `/organizador/equipe`, `/convite/[token]`, `listPendingInvitations`, `revokeInvitation`, `resendInvitation`, `declineInvitation` | Pronto |
| Alterar papel de membro | `/organizador/equipe`, `changeMemberRole` | Pronto |
| Cupons de desconto (criar, editar, desativar, excluir se nunca usado; avisos de taxa e meia-entrada) | `/organizador/eventos/[id]/editar`, `coupons.ts` | Pronto (ADR 0002, passo 3); aplicar no checkout é o passo 2 (`pagamentos-financeiro`) |
| Links de divulgação rastreados (UTMs, cupom pré-aplicado, cliques, arquivar) | `/organizador/eventos/[id]/editar`, `tracking-links.ts` | Pronto (passo 3); `/r/[code]` e cookie de atribuição são do passo 4 (`paginas-publicas`) |
| Relatórios "Vendas por origem" e "Uso de cupons" (só pedidos pagos, valores líquidos de desconto) | `/organizador/vendas`, `salesBySource`, `couponUsage` | Pronto |
| Recusa de preço de ingresso abaixo da taxa da plataforma (bearer ORGANIZER) | `upsertTicketType` | Pronto (ADR 0002, passo 0) |
| Alteração relevante de evento com vendas: motivo obrigatório, `EventChange` com janela de reembolso, aviso por e-mail, histórico e prorrogação (R8) | `…/[id]/editar` (formulário e "Histórico de alterações"), `updateEvent`, `event-changes.ts`, `notifyEventChange` | Pronto com padrões provisórios (D2) |
| Limite de ingressos por conta (opcional) no assistente e na edição (R4) | `maxTicketsPerAccount` em `eventInputSchema`, `largestHoldingOverLimit` (usa `ticketsHeldByAccount`) | Pronto no organizador; a checagem no checkout é do `pagamentos-financeiro` |
| Janelas de reembolso por alteração abertas, com compradores que pediram reembolso por elas | `…/[id]/editar` (aviso no topo e "Histórico de alterações"), `listEventChanges` | Pronto (só leitura) |
| Alertas no painel: transferência pendente a menos de 72 h do início; janela de alteração aberta | `organizerDashboard` (`PENDING_TRANSFER_ALERT_HOURS`) | Pronto |

### Assistente de criação de evento

Etapas (`src/features/organizer/wizard-steps.ts`): 1) Informações básicas
(nome, categoria, resumo, organização), 2) Data e localização (data e horário
separados no fuso do evento, presencial com local cadastrado ou novo — rua,
número, complemento, bairro, CEP, cidade — ou online com link https),
3) Ingressos e preços (capacidade, cota de meia, período de vendas e tipos de
ingresso, com duplicar e estimativa "comprador paga / você recebe" calculada
com `computeFees` e a regra de comissão vigente), 4) Imagens e descrição (capa,
descrição com modelo de Programação/Informações importantes/Política de
entrada, classificação indicativa, acessibilidade), 5) Configurações
(política e prazos de reembolso; atalhos para o que já existe em outros
lugares), 6) Revisão (seções com "Editar", pendências, pré-visualização,
publicar).

- **Persistência:** o rascunho (DRAFT) é criado no servidor assim que a etapa 1
  é válida (`startEventDraft`). O navegador gera uma `draftKey` por formulário;
  com a linha da organização travada, a mesma chave devolve o mesmo evento —
  autosave, "Continuar" e cliques repetidos não duplicam. Cada etapa grava só os
  próprios campos (`saveEventWizardStep`), com `event:write`, as mesmas regras
  de `createEvent`/`updateEvent` (fuso via `zonedLocalToUtc`, capacidade ≥
  vendidos) e só enquanto o evento é DRAFT. O "novo local" reenviado pelo
  autosave atualiza o local criado para o evento, sem duplicar.
- **Valores provisórios:** o schema exige datas, capacidade e descrição; até a
  etapa correspondente ser concluída o evento guarda valores provisórios
  (início em 30 dias, capacidade 100, descrição vazia) que a interface não
  mostra. A lista mostra "A definir" na data, e `submitEventForPublication`
  recusa publicar enquanto houver etapa pendente. A página de gestão redireciona
  para o assistente nesse caso.
- **Progresso:** etapas concluídas e última etapa acessada ficam no `AuditLog`
  (`event.wizard_progress`, a linha mais recente vale; só grava quando muda).
  Eventos sem esse registro (criados antes) contam como completos.
- **Autosave:** debounce de 1,2 s; só envia quando a etapa está válida; estados
  "Salvando…", "Salvo às HH:MM", "Alterações pendentes" e "Erro ao salvar" (com
  "Tentar novamente"). Salvamentos entram numa fila (nunca em paralelo). Uma
  cópia em `localStorage` guarda o que ainda não chegou ao servidor e oferece
  "Restaurar" ao voltar; aviso ao fechar a aba com alterações pendentes.
- **Navegação:** etapa na URL (`?evento=…&etapa=…`), então recarregar e o
  voltar/avançar do navegador funcionam; o servidor limita a etapa às já
  concluídas e à primeira pendente. "Continuar" valida só a etapa atual, mostra
  um resumo de erros com links e foca o primeiro campo inválido; "Voltar" e o
  indicador não validam nem perdem dados. Foco vai para o título da etapa a
  cada troca. Botões ficam desativados até a hidratação (o formulário nunca é
  enviado como GET com dados na URL).
- **Publicação:** `submitEventForPublication` trava o evento e é idempotente
  (segundo envio devolve o estado atual).
- Testes: `tests/integration/y-event-wizard.test.ts` (idempotência, validação
  por etapa, fluxo completo, local sem duplicar, bloqueio de publicação,
  permissões) e `tests/e2e/organizer-event-wizard.spec.ts` (fluxo completo com
  voltar, recarregar, falha de rede no autosave, revisão e publicação; rascunho
  retomado pela lista e pela página de gestão).

### Alteração relevante e janela de reembolso (R8, L8b)

- **Quando:** evento PUBLISHED com ao menos um pedido PAID, e a edição muda o início
  (`RELEVANT_START_SHIFT_MINUTES`, hoje 0 = qualquer mudança, inclusive só de fuso), o
  local (`venueId`), a cidade (`cityId`) ou o formato (presencial ↔ online). Qualquer
  outra edição segue como antes, sem motivo e sem registro. Reenviar o mesmo "novo
  local" na edição reaproveita o local atual (não conta como troca).
- **Motivo:** obrigatório (10–2000 caracteres). O formulário mostra o campo só quando a
  prévia no navegador detecta a mudança — ou quando o servidor responde
  `CHANGE_REASON_REQUIRED` (ex.: mudança de cidade que o navegador não vê).
- **Registro:** na mesma transação de `updateEvent` (evento travado `FOR UPDATE`):
  `EventChange` com `relevant = true`, `changedFields` ⊂ {startsAt, venue, city,
  locationType}, `before`/`after` = início (ISO UTC), formato, id/nome do local e da
  cidade — **sem** link online nem dados pessoais —, `reason`, `actorUserId`,
  `createdAt` explícito e `refundUntil = min(createdAt + REFUND_WINDOW_DAYS_AFTER_CHANGE
  (30 dias), novo início)`. Novo início no passado é recusado. Auditoria
  `event.relevant_change` e `event.updated` com `{ eventChangeId }`.
- **Aviso:** depois do commit, `notifyEventChange` (em `notifications.ts`) manda um
  e-mail por endereço aos compradores (`buyerEmail`) e titulares atuais dos ingressos
  não revogados de pedidos pagos **antes** da alteração: o que mudou (antes → depois,
  no fuso do evento), o motivo, o prazo de reembolso integral e o link para "Meus
  pedidos". Falha de envio não desfaz a alteração; `event.change_notified` registra
  `{ recipients, sent, failed }`. Em `NODE_ENV=test` o envio automático é desligado
  (os testes chamam `notifyEventChange` com um adaptador de e-mail próprio).
- **Prorrogação:** `extendEventChangeWindow` (`event:write`) grava nova linha com
  `extendsChangeId` = sempre a alteração original, `changedFields = []`,
  `before/after = { refundUntil }` e motivo; só com a janela ainda aberta, prazo novo
  maior que o vigente e no máximo até o início do evento. Também avisa os compradores
  (`event.change_window_extended`).
- **Histórico:** card "Histórico de alterações" na página de gestão do evento
  (`listEventChanges`, `org:read`), com prazo vigente e botão de prorrogar.
- **Reembolso:** quem aplica a janela é o `pagamentos-financeiro` (`refundEligibility`):
  pedidos pagos antes de `createdAt` da alteração original, até o maior `refundUntil`
  entre ela e as prorrogações.
- **D2 em aberto:** as constantes ficam em `src/features/organizer/event-change-rules.ts`.
  Não há status "adiado" no evento.
- Testes: `tests/integration/z-event-relevant-change.test.ts`.

### Limite de ingressos por conta (R4, L4b — lado do organizador)

- Campo opcional "Limite de ingressos por conta" na etapa 3 do assistente e na edição
  (`Event.maxTicketsPerAccount`; vazio = sem limite; 1–1000).
- Com vendas, o servidor recusa limite menor que o que uma conta já tem
  (`largestHoldingOverLimit`). A contagem por conta é o `ticketsHeldByAccount` do
  `pagamentos-financeiro`: ingressos VALID/CHECKED_IN de que a conta é **titular**
  (transferido conta só para o novo titular) + itens dos pedidos PENDING_PAYMENT da
  conta ainda não vencidos. Aqui só se escolhem as contas candidatas (titularidade ou
  reservas acima de metade do limite, em qualquer status/vencimento), para não chamar a
  função para cada comprador. O `createOrder` de lá aplica o limite no checkout.

### Participantes e transferências (R6, T-TRANSF — lado do organizador)

- `listAttendees` (`attendees:read`: OWNER, ADMIN, EVENT_MANAGER, FINANCE) mostra o
  **titular atual**: `holderUserId`, `holderName`/`holderEmail` do ingresso (o aceite os
  troca para o novo titular) ou, sem eles, nome/e-mail da conta titular. `transferred` =
  titular ≠ comprador (`userId`, que nunca muda); `pendingTransfer` = transferência
  PENDING (e-mail do destinatário e validade). O pedido continua do comprador.
- `listTransferHistory(db, actor, eventId, ticketId?)`: de → para (nome/e-mail copiados
  na transferência), criação, validade, decisão, situação e se foi pela plataforma
  (`initiatedBy = ADMIN`). Nunca devolve token, hash, IP nem user agent. Filtra por
  `eventId` do evento autorizado (ingresso de outra organização não aparece).
  Na tela, fica num "Histórico de transferências (n)" recolhível em cada ingresso.
- CSV: `codigo, titular, email_titular, conta_titular, transferido, transferencia_pendente,
  tipo, status, check_in, pedido`, com `csvCell` (fórmulas neutralizadas). Cada download
  grava `attendees.exported`.
- Equipe de check-in (`CHECKIN_STAFF`) não vê participantes nem histórico.

### Janelas de alteração abertas e alertas

- `listEventChanges` devolve, em cada alteração original, `refundRequests = { buyers,
  refunded }`: compradores distintos com `Refund.eventChangeId` daquela alteração (gravado
  pelo `pagamentos-financeiro` em `requestCustomerRefund`) e quantos já com reembolso
  SUCCEEDED. Só contagens; permissão `org:read`. A página de gestão mostra um aviso no topo
  com as janelas abertas e a contagem no histórico.
- Painel: alerta "warning" por evento com transferência PENDING e início em até
  `PENDING_TRANSFER_ALERT_HOURS` (72 h), com link para os participantes se o papel tiver
  `attendees:read`; alerta "info" por evento PUBLISHED com `EventChange` de prazo futuro.
- Testes: `tests/integration/z-organizer-participants-transfers.test.ts` e
  `tests/e2e/organizer-participants.spec.ts` (com os dados do seed).

### Relatório de meia-entrada (R7)

- Exige `finance:read` no evento (`assertEventPermission`): OWNER, ADMIN e
  FINANCE; vale também com a organização suspensa, como o resto das finanças.
- "Vendidas" é o `quantitySold` dos tipos `HALF_PRICE` (monotônico: inclui as
  depois reembolsadas/canceladas). Reembolsadas, canceladas (evento cancelado),
  outras revogações, válidas e com check-in vêm de `IssuedTicket`. Cota restante
  = cota − (vendidas + reservadas), a mesma regra do checkout.
- Vendas por dia: pedidos pagos (inclusive os depois reembolsados), agrupados por
  `paidAt` no fuso do evento.
- CSV com BOM UTF-8, separador `;` e decimal com vírgula (Excel em pt-BR),
  células entre aspas e fórmulas neutralizadas (`csvCell`, compartilhado com o
  CSV de participantes). Cada download grava `half_price_report.exported`.
- Testes: `tests/integration/r-half-price-report.test.ts`; 403 para cliente em
  `tests/e2e/access-control.spec.ts`.

### Regras da equipe (aplicadas no servidor)

- Gerenciar equipe exige `members:manage` (OWNER/ADMIN), verificado dentro da
  transação. Hierarquia: OWNER > ADMIN > EVENT_MANAGER = FINANCE > CHECKIN_STAFF.
- Ninguém convida, promove, rebaixa ou remove alguém com papel acima do próprio,
  nem concede papel acima do próprio — só OWNER cria ou altera OWNER. A interface
  só oferece os papéis permitidos (`assignableRoles`), mas o serviço revalida.
- A organização nunca fica sem OWNER (rebaixar ou remover). Mudanças de equipe
  travam a linha da organização (`FOR NO KEY UPDATE`), então dois OWNERs se
  rebaixando ao mesmo tempo não zeram os responsáveis.
- Convite: aceitar reivindica o convite com `UPDATE` condicional (não aceito, não
  revogado, não vencido, mesmo token) e cria a associação com
  `ON CONFLICT DO NOTHING` — aceites simultâneos geram uma única associação; quem
  já é membro mantém o papel. Revogar/reenviar perdem para um aceite concorrente.
- Recusar marca `revokedAt` (não há coluna própria); a diferença entre revogado e
  recusado fica no `AuditLog` (`member.invitation_revoked` × `member.invitation_declined`).
- Sair de CHECKIN_STAFF apaga as atribuições de check-in do membro na organização.
- Auditoria na mesma transação: `member.invited`, `member.invitation_revoked`,
  `member.invitation_resent`, `member.invitation_declined`, `member.joined`,
  `member.role_changed` (`{ userId, from, to }`), `member.removed`.

Autorização: todo serviço chama `assertOrgPermission`/`assertEventPermission`;
testes em `tests/integration/a-organizer-flow.test.ts`,
`i-j-authz-concurrency.test.ts`, `k-organizer-dashboard.test.ts` e
`n-organizer-team.test.ts` (equipe/convites, autorização negada e concorrência);
E2E em `tests/e2e/organizer-onboarding.spec.ts`, `organizer-dashboard.spec.ts`
e `organizer-team.spec.ts` (convites e papéis).

## O que falta (por prioridade)

1. **Convites (complementos):** transferir a propriedade com confirmação por
   e-mail; limitar convites pendentes por organização.
2. ~~Convites: revogar, reenviar, recusar, pendentes~~ e ~~Equipe: alterar papel~~ — feitos.
   ~~**Cupons da organização inteira**~~ — feito: `/organizador/cupons` (menu
   "Cupons", permissão `event:write`) cria e edita cupons sem evento
   (`createOrganizationCoupon`, `listOrganizationCoupons`, `updateCoupon`), válidos em
   todos os eventos, nos tipos pagos exceto meia-entrada (sem seleção de tipos);
   validade no horário de Brasília; avisos de repasse negativo e de desconto abaixo
   da meia calculados para cada evento aberto (até 30). Na página do evento eles
   aparecem com o selo "Toda a organização", sem edição ali. Testes em
   `zz-organization-coupons.test.ts`. Os avisos do
   cadastro usam `discountPerUnit`/`undercutHalfPrice` de
   `src/features/fees/discount.ts`, as mesmas regras do checkout.
3. ~~**Página do evento no painel**~~ — feita: `/organizador/eventos/[id]` (resumo:
   vendidos/capacidade, check-ins, a receber e meia-entrada; estoque por tipo; vendas
   do evento) com atalhos para gestão, página pública, participantes e check-in. O
   título na lista de eventos e o botão "Resumo" da gestão levam a ela.
4. ~~**Relatórios**~~ — feitos em `/organizador/vendas`: filtro de período (data do
   pagamento, horário de São Paulo; atalhos 7/30 dias, mês, tudo) e de evento; totais,
   ticket médio (por pedido) e preço médio por ingresso; vendas por tipo de ingresso e
   por evento; CSV de vendas (`/api/organizador/vendas`, sem dados pessoais, auditado
   como `sales_report.exported`) e carimbo "gerado em". Serviço `salesReport` /
   `listSalesOrders` em `reports.ts`; "vendido" = pedido que chegou a ser pago, inclusive
   o reembolsado depois (que aparece à parte). Testes em `zy-sales-report.test.ts`.
5. **Eventos:** ~~duplicar evento, despublicar~~ — feitos (`duplicateEvent`,
   `unpublishEvent` em `events.ts`; testes em `zx-event-duplicate-unpublish.test.ts`).
   Duplicar pede a nova data de início e desloca todas as datas (evento, vendas e
   janelas dos tipos) pelo mesmo intervalo; copia dados, local e tipos com contadores
   zerados; não copia cupons, links, equipe, regras de comissão nem o regime de
   meia-entrada. Despublicar volta PUBLISHED/PENDING_REVIEW a rascunho, recusado com
   ingresso válido/usado ou pedido aguardando pagamento (aí é cancelar), sob a mesma
   trava do evento que `createOrder`. Falta: galeria de imagens (`EventImage` existe
   mas não é usado), busca/filtro na lista, paginação.
6. ~~Avisar compradores quando data/local de evento com vendas mudar~~ — feito (R8).
   Falta: reenvio manual do aviso e outbox durável (T7).
7. **Organização:** ~~logo e capa~~ — feitos: `Organization.logoUrl`/`coverUrl`
   (migração `20261113120000_organization_logo_cover`, só aditiva), envio em
   Configurações → Perfil público (`setOrganizationImage`, `org:manage`, tipo pelo
   conteúdo, até 5 MB, logo ≥ 200×200 e capa ≥ 1200×300; o banco só recebe URLs do
   armazenamento; auditoria `organization.logo_updated/_removed` e `cover_…`). Falta:
   links sociais adicionais.

8. **Assistente de evento (complementos):** preencher endereço pelo CEP quando
   houver integração; galeria de imagens (`EventImage`); usar o assistente
   também na edição; campos da proposta ao `banco-de-dados` abaixo.

## Dependências de outros agentes

| Agente | O que precisamos |
| --- | --- |
| `banco-de-dados` | **Assistente de evento (proposta):** `Event.wizardCompletedSteps Int[]` e `Event.wizardLastStep Int?` (hoje no `AuditLog`, ver `event-wizard-progress.ts`) e permitir `startsAt`/`endsAt`/`salesStartAt`/`salesEndAt`/`capacity` nulos enquanto `status = DRAFT` (CHECK), para dispensar os valores provisórios; campos que o briefing pediu e ainda não existem: subcategoria, modalidade híbrida, número/complemento do endereço separados, plataforma da transmissão, evento privado/fora da busca, aprovação de participantes, regras de transferência. ~~`Organization.logoUrl` e `coverUrl`~~ (feito); (opcional) `OrganizationInvitation.declinedAt` para separar recusa de revogação sem consultar a auditoria (hoje ambos usam `revokedAt`), e índice parcial `(organizationId) WHERE acceptedAt IS NULL AND revokedAt IS NULL` se a lista de pendentes crescer; papel "Analista" só se o negócio quiser um papel diferente de `FINANCE`. |
| `pagamentos-financeiro` | Relatórios usam o razão (`FinancialLedgerEntry`) e `Order` — qualquer mudança de contas/tipos do razão precisa avisar esta área. Venda por tipo de ingresso e ticket médio dependem de `OrderItem`. Liquidação real (`OrganizerSettlement`) segue desabilitada até o provedor real. |
| `paginas-publicas` | `PanelShell` (`src/components/site/panel-shell.tsx`): abaixo de `lg` a grade não define colunas e a coluna implícita cresce até a largura da navegação (~680 px), causando rolagem horizontal em todas as páginas do painel no celular — `grid-cols-1`/`grid-cols-[minmax(0,1fr)]` resolve. Perfil público do organizador (`/organizadores/[slug]`) já exibe logo/capa (e usa a capa no compartilhamento); falta o selo "verificado" conforme a verificação aprovada; dados de evento publicados vêm de `events.ts`/`catalog.ts`. |
| `check-in` | Atribuição de equipe a eventos é feita aqui (`assignStaffToEvent`); o leitor e o histórico são do check-in. |
| `admin` | Aprovação de organizações e moderação de eventos (`reviewOrganization`, `moderateEvent`, `setAutoPublish`) — o painel mostra o resultado como pendências. |
| Equipe (infra de e-mail) | Convites usam o adaptador de e-mail; em produção depende do provedor configurado (`EMAIL_PROVIDER`). |

## Política de transferência por evento

A etapa 5 do assistente, sua revisão e a edição do evento permitem definir a
antecedência mínima para transferir (0–8760 horas; padrão 24), o máximo de
transferências aceitas por ingresso (1–10; padrão 1) e a possibilidade de uma
nova transferência para um titular anterior (desabilitada por padrão).
Devolver exige solicitação pelo titular atual e aceite do destinatário, consome
uma transferência do limite e requer limite de pelo menos 2; não é um desfazer
unilateral. Configurações incoerentes são recusadas no formulário e no servidor.

Com ingressos vendidos ou reservados, a política só pode ficar mais favorável:
reduzir a antecedência, aumentar o limite ou permitir devolução. A verificação
ocorre sob a trava do evento, junto da edição; não altera regras financeiras.
Os valores anterior e novo ficam no AuditLog. Alterar somente essa política
não cria uma janela artificial de reembolso por alteração relevante.
