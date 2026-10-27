# Área do organizador — inventário e dependências

Responsável: agente `area-organizador`. Última revisão: convites (revogar,
reenviar, recusar, lista de pendentes) e alteração de papel na equipe.

## O que existe

| Funcionalidade | Onde | Estado |
| --- | --- | --- |
| Painel com KPIs, pendências, próximos eventos, desempenho por evento, pedidos recentes, gráfico de 30 dias, ações rápidas | `/organizador`, `organizerDashboard` em `reports.ts` | Pronto |
| Lista de organizações do usuário, troca de organização ativa | `/organizador/organizacoes`, `listMyOrganizations`, `switchOrganizationAction` | Pronto |
| Criar organização (primeira ou adicional; limite de 3 pendentes) | `/organizador/cadastro`, `/organizador/organizacoes/nova`, `createOrganizationAction` | Pronto |
| Reenviar cadastro recusado (id explícito, `org:manage`) | `/organizador/cadastro`, `resubmitApplicationAction` | Pronto |
| CRUD de eventos, local novo/existente, capa, fuso | `/organizador/eventos`, `…/novo`, `…/[id]/editar`, `events.ts` | Pronto |
| Tipos de ingresso (preço, quantidade, limites, janela, oculto, nome por ingresso) | `…/[id]/editar`, `upsertTicketType`, `deleteTicketType` | Pronto |
| Publicação com moderação / publicação automática; cancelamento com reembolso | `submitEventForPublication`, `cancelEvent` (financeiro) | Pronto |
| Vendas, repasses e cota de meia-entrada | `/organizador/vendas` | Pronto |
| Participantes + CSV auditado | `/organizador/participantes`, `/api/organizador/eventos/[id]/participantes` | Pronto |
| Perfil, conta de recebimento (simulada), equipe, convites, atribuição de check-in | `/organizador/configuracoes`, `/convite/[token]` | Pronto |
| Convites: lista de pendentes (com vencidos), revogar, reenviar (novo token; o anterior deixa de valer), recusar pelo convidado | `/organizador/configuracoes`, `/convite/[token]`, `listPendingInvitations`, `revokeInvitation`, `resendInvitation`, `declineInvitation` | Pronto |
| Alterar papel de membro | `/organizador/configuracoes`, `changeMemberRole` | Pronto |
| Cupons de desconto (criar, editar, desativar, excluir se nunca usado; avisos de taxa e meia-entrada) | `/organizador/eventos/[id]/editar`, `coupons.ts` | Pronto (ADR 0002, passo 3); aplicar no checkout é o passo 2 (`pagamentos-financeiro`) |
| Links de divulgação rastreados (UTMs, cupom pré-aplicado, cliques, arquivar) | `/organizador/eventos/[id]/editar`, `tracking-links.ts` | Pronto (passo 3); `/r/[code]` e cookie de atribuição são do passo 4 (`paginas-publicas`) |
| Relatórios "Vendas por origem" e "Uso de cupons" (só pedidos pagos, valores líquidos de desconto) | `/organizador/vendas`, `salesBySource`, `couponUsage` | Pronto |
| Recusa de preço de ingresso abaixo da taxa da plataforma (bearer ORGANIZER) | `upsertTicketType` | Pronto (ADR 0002, passo 0) |

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
   **Cupons e links (ADR 0002):** cupons da organização inteira (sem evento)
   ainda não têm tela (o serviço lista, mas não cria nem edita); trocar a
   cópia local de `discountPerUnit` em `coupons.ts` pelo import de
   `src/features/fees/discount.ts` quando o passo 2 entrar.
3. **Página do evento no painel** (`/organizador/eventos/[id]`) com resumo de
   vendas do evento (`eventSalesSummary` já existe) e atalhos.
4. **Relatórios:** filtros de período/evento, vendas por tipo de ingresso, ticket
   médio, exportação CSV de vendas, carimbo de data do relatório.
5. **Eventos:** duplicar evento, despublicar, galeria de imagens (`EventImage`
   existe mas não é usado), busca/filtro na lista, paginação.
6. **Avisar compradores** quando data/local de evento com vendas mudar.
7. **Organização:** logo e capa (ver dependências), links sociais adicionais.

## Dependências de outros agentes

| Agente | O que precisamos |
| --- | --- |
| `banco-de-dados` | `Organization.logoUrl` e `coverUrl`; (opcional) `OrganizationInvitation.declinedAt` para separar recusa de revogação sem consultar a auditoria (hoje ambos usam `revokedAt`), e índice parcial `(organizationId) WHERE acceptedAt IS NULL AND revokedAt IS NULL` se a lista de pendentes crescer; papel "Analista" só se o negócio quiser um papel diferente de `FINANCE`. |
| `pagamentos-financeiro` | Relatórios usam o razão (`FinancialLedgerEntry`) e `Order` — qualquer mudança de contas/tipos do razão precisa avisar esta área. Venda por tipo de ingresso e ticket médio dependem de `OrderItem`. Liquidação real (`OrganizerSettlement`) segue desabilitada até o provedor real. |
| `paginas-publicas` | Perfil público do organizador (`/organizadores/[slug]`) deve exibir logo/capa quando existirem e o selo "verificado" conforme a verificação aprovada; dados de evento publicados vêm de `events.ts`/`catalog.ts`. |
| `check-in` | Atribuição de equipe a eventos é feita aqui (`assignStaffToEvent`); o leitor e o histórico são do check-in. |
| `admin` | Aprovação de organizações e moderação de eventos (`reviewOrganization`, `moderateEvent`, `setAutoPublish`) — o painel mostra o resultado como pendências. |
| Equipe (infra de e-mail) | Convites usam o adaptador de e-mail; em produção depende do provedor configurado (`EMAIL_PROVIDER`). |
