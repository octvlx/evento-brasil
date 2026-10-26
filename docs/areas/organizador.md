# Área do organizador — inventário e dependências

Responsável: agente `area-organizador`. Última revisão: implementação do painel
e do fluxo de criação de organizações.

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

Autorização: todo serviço chama `assertOrgPermission`/`assertEventPermission`;
testes em `tests/integration/a-organizer-flow.test.ts`,
`i-j-authz-concurrency.test.ts` e `k-organizer-dashboard.test.ts`; E2E em
`tests/e2e/organizer-onboarding.spec.ts` e `organizer-dashboard.spec.ts`.

## O que falta (por prioridade)

1. **Convites:** revogar, reenviar (invalidando o token anterior), recusar e
   página de convites pendentes. O campo `revokedAt` já existe.
2. **Equipe:** alterar o papel de um membro (com proteção contra escalada de
   privilégio e contra remover o último OWNER, que já existe).
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
| `banco-de-dados` | `Organization.logoUrl` e `coverUrl`; (opcional) enum de status do convite ou manter derivado de `acceptedAt`/`revokedAt`/`expiresAt`; papel "Analista" só se o negócio quiser um papel diferente de `FINANCE`. |
| `pagamentos-financeiro` | Relatórios usam o razão (`FinancialLedgerEntry`) e `Order` — qualquer mudança de contas/tipos do razão precisa avisar esta área. Venda por tipo de ingresso e ticket médio dependem de `OrderItem`. Liquidação real (`OrganizerSettlement`) segue desabilitada até o provedor real. |
| `paginas-publicas` | Perfil público do organizador (`/organizadores/[slug]`) deve exibir logo/capa quando existirem e o selo "verificado" conforme a verificação aprovada; dados de evento publicados vêm de `events.ts`/`catalog.ts`. |
| `check-in` | Atribuição de equipe a eventos é feita aqui (`assignStaffToEvent`); o leitor e o histórico são do check-in. |
| `admin` | Aprovação de organizações e moderação de eventos (`reviewOrganization`, `moderateEvent`, `setAutoPublish`) — o painel mostra o resultado como pendências. |
| Equipe (infra de e-mail) | Convites usam o adaptador de e-mail; em produção depende do provedor configurado (`EMAIL_PROVIDER`). |
